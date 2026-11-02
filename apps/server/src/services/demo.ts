import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_RISK } from '@zcode-bot/config';
import type { DashboardState } from './state.js';

/**
 * Fictional 28-second demo replay. Purely in-memory: demo fixtures are NEVER
 * written to live trading tables. Every emitted state is labeled
 * FICTIONAL DEMO · NOT A PERFORMANCE CLAIM.
 */

interface DemoTimeline {
  meta: { durationSeconds: number; label: string; switch1Seconds: number; switch2Seconds: number };
  start: { equityUsdMicro: string; handle: string; weeklyRank: number };
  traders: Array<{ handle: string; weeklyRank: number; displayedPnl7dPct: number }>;
  events: Array<DemoEvent>;
  end: { equityUsdMicro: string; trades: number; winners: number };
}

type DemoEvent =
  | { t: number; type: 'close'; pnlUsdMicro: string; equityAfterUsdMicro: string; symbol: string }
  | {
      t: number;
      type: 'mirror';
      status: string;
      symbol: string;
      leaderUsd: number;
      copyUsd: number;
      pnlUsd: number | null;
    }
  | {
      t: number;
      type: 'switch';
      fromHandle: string;
      fromRank: number;
      toHandle: string | null;
      toRank: number | null;
      reason: string;
    };

export class DemoEngine {
  private timeline: DemoTimeline;
  private startedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;

  constructor(
    private fixturesPath: string,
    private emit: (state: DashboardState) => void,
    private onDone?: () => void,
  ) {
    if (!existsSync(fixturesPath)) {
      throw new Error(
        `demo fixtures missing: ${fixturesPath} (run pnpm --filter @zcode-bot/server run fixtures:generate)`,
      );
    }
    this.timeline = JSON.parse(readFileSync(fixturesPath, 'utf8')) as DemoTimeline;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.cursor = 0;
    this.timer = setInterval(() => this.tick(), 100);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const elapsed = this.startedAt === null ? 0 : (Date.now() - this.startedAt) / 1000;
    const dur = this.timeline.meta.durationSeconds;
    const finished = elapsed >= dur + 1.2;

    // Apply due events.
    const applied: DemoEvent[] = [];
    while (this.cursor < this.timeline.events.length && this.timeline.events[this.cursor]!.t <= elapsed) {
      applied.push(this.timeline.events[this.cursor]!);
      this.cursor++;
    }

    void applied; // state below is a pure function of cursor position + clock

    const state = this.buildState(Math.min(elapsed, dur));
    this.emit(state);

    if (finished) {
      this.stop();
      this.onDone?.();
    }
  }

  /** Pure function of replay time — deterministic and resumable. */
  private buildState(elapsed: number): DashboardState {
    const tl = this.timeline;
    const eventsApplied = tl.events.filter((e) => e.t <= elapsed);

    // Current trader + the fictional switch between demo traders.
    const swaps = eventsApplied.filter((e) => e.type === 'switch') as Extract<
      DemoEvent,
      { type: 'switch' }
    >[];
    const lastSwap = swaps[swaps.length - 1] ?? null;
    const activeHandle =
      lastSwap?.toHandle ?? (eventsApplied.length >= 0 ? tl.start.handle : tl.start.handle);
    const activeRank = lastSwap?.toRank ?? tl.start.weeklyRank;
    const traderMeta = tl.traders.find((t) => t.handle === activeHandle) ?? tl.traders[0]!;

    // Closes + equity.
    const closes = eventsApplied.filter((e) => e.type === 'close') as Extract<DemoEvent, { type: 'close' }>[];
    const equity = closes.length ? closes[closes.length - 1]!.equityAfterUsdMicro : tl.start.equityUsdMicro;
    const winners = closes.filter((c) => BigInt(c.pnlUsdMicro) > 0n).length;

    // Last-six markers per current trader (recomputed from that trader's closes).
    const traderStartT = lastSwap?.t ?? 0;
    const traderCloses = closes.filter((c) => c.t >= traderStartT);
    const lastSix: Array<'W' | 'L' | 'B'> = traderCloses
      .slice(-6)
      .map((c) => (BigInt(c.pnlUsdMicro) > 0n ? 'W' : 'L'));

    // Streak = consecutive losses at the tail of the current trader.
    let streak = 0;
    for (let i = traderCloses.length - 1; i >= 0; i--) {
      if (BigInt(traderCloses[i]!.pnlUsdMicro) <= 0n) streak++;
      else break;
    }

    // Mirror card.
    const mirrors = eventsApplied.filter((e) => e.type === 'mirror') as Extract<
      DemoEvent,
      { type: 'mirror' }
    >[];
    const lastMirror = mirrors[mirrors.length - 1] ?? null;

    // Contribution segments per trader.
    const contribution = new Map<string, bigint>();
    let currentTrader = tl.start.handle;
    for (const e of eventsApplied) {
      if (e.type === 'switch') currentTrader = e.toHandle ?? currentTrader;
      if (e.type === 'close') {
        contribution.set(currentTrader, (contribution.get(currentTrader) ?? 0n) + BigInt(e.pnlUsdMicro));
      }
    }

    const sessionTotal = 24 * 3600;
    const sessionElapsed = Math.round((elapsed / tl.meta.durationSeconds) * sessionTotal);

    const gapActive = lastSwap !== null && elapsed - lastSwap.t < 4.0;
    const gapPending = lastSwap?.toHandle == null;

    const series: DashboardState['equity']['series'] = [
      { t: '0', usdMicro: tl.start.equityUsdMicro },
      ...closes.map((c) => ({ t: String(c.t), usdMicro: c.equityAfterUsdMicro })),
    ];

    // Panels: derive open positions and the activity tape from fixture events
    // (fictional like everything else in the replay).
    const isoAt = (t: number) => new Date(Date.now() - Math.max(0, elapsed - t) * 1000).toISOString();
    const openMirrors = new Map<string, Extract<DemoEvent, { type: 'mirror' }>>();
    for (const e of eventsApplied) {
      if (e.type !== 'mirror') continue;
      if (e.status === 'CLOSED') openMirrors.delete(e.symbol);
      else openMirrors.set(e.symbol, e);
    }
    const demoPositions: DashboardState['positions'] = [...openMirrors.values()].map((m, i) => ({
      positionId: `demo-pos-${i}`,
      leaderHandle: activeHandle,
      mintShort: m.symbol.slice(0, 4),
      symbol: m.symbol,
      status: m.status,
      copyUsdMicro: BigInt(Math.round(m.copyUsd * 1e6)).toString(),
      feesUsdMicro: BigInt(Math.round(m.copyUsd * 1e6 * 0.0005)).toString(),
      entryFeeLamports: null,
      entryRentLamports: null,
      realizedPnlUsdMicro: m.pnlUsd === null ? '0' : BigInt(Math.round(m.pnlUsd * 1e6)).toString(),
      markUsdMicro: null,
      unrealizedPnlUsdMicro: null,
      markAgeSeconds: null,
      openedIso: isoAt(m.t),
      entries: [
        {
          intentId: `demo-intent-${i}`,
          atIso: isoAt(m.t),
          usdMicro: BigInt(Math.round(m.copyUsd * 1e6)).toString(),
          inputUsdMicro: BigInt(Math.round(m.copyUsd * 1e6)).toString(),
          tokenBase: '1000',
          unrealizedPnlUsdMicro: m.pnlUsd === null ? null : BigInt(Math.round(m.pnlUsd * 1e6)).toString(),
          txSignature: null,
        },
      ],
    }));
    const demoActivity: DashboardState['activity'] = [
      ...mirrors
        .filter((m) => m.status !== 'CLOSED')
        .map((m, i) => ({
          id: `demo-act-m${i}`,
          tIso: isoAt(m.t),
          kind: 'copied' as const,
          tokenShort: m.symbol.slice(0, 4),
          leaderUsdMicro: BigInt(Math.round(m.leaderUsd * 1e6)).toString(),
          leaderSolBase: null,
          copyUsdMicro: BigInt(Math.round(m.copyUsd * 1e6)).toString(),
          realizedPnlUsdMicro: null,
          reasonChip: null,
        })),
      ...closes.map((c, i) => ({
        id: `demo-act-c${i}`,
        tIso: isoAt(c.t),
        kind: 'exit' as const,
        tokenShort: c.symbol.slice(0, 4),
        leaderUsdMicro: null,
        leaderSolBase: null,
        copyUsdMicro: null,
        realizedPnlUsdMicro: c.pnlUsdMicro,
        reasonChip: null,
      })),
    ].sort((a, b) => b.tIso.localeCompare(a.tIso));

    // How many of the fixture's traders the story has introduced so far (the
    // pool's "funded buyers" in the replay's own terms).
    const tradersSeen = Math.max(1, tl.traders.findIndex((t) => t.handle === activeHandle) + 1);

    const demoCounters = (() => {
      // Capital tracks the replay's running (realized) equity, not the static start.
      const capital = BigInt(equity);
      const deployed = demoPositions.reduce(
        (acc, p) => acc + BigInt(p.copyUsdMicro) + BigInt(p.feesUsdMicro),
        0n,
      );
      const cash = capital - deployed;
      return {
        copiedToday: closes.length,
        skippedToday: 0,
        openPositions: demoPositions.length,
        openExposureUsdMicro: deployed.toString(),
        capitalUsdMicro: capital.toString(),
        cashUsdMicro: cash.toString(),
        deployedUsdMicro: deployed.toString(),
        deployedPct: capital > 0n ? Math.round(Number((deployed * 10_000n) / capital)) / 100 : 0,
        maxDeployedPct: 80,
        rosterSize: DEFAULT_RISK.ROSTER_SIZE,
        maxPositionAgeHours: 16,
        positionGraceHours: 3,
        idleFireHoursLeft: null,
        feesPaidUsdMicro: '0',
        feesLamports: null,
        rentUsdMicro: null,
        rentLamports: null,
        openTokenAccounts: null,
        solUsdMicro: null,
        ledgerTxs: null,
      };
    })();

    return {
      version: 0,
      generatedAt: new Date().toISOString(),
      mode: 'demo',
      armed: false,
      badges: ['DEMO', ...(gapActive ? (['PAUSED'] as const) : [])],
      // The fictional gap between two demo traders reads as "no trader hired".
      appState: gapActive ? 'PAUSED_NO_TRADER' : 'RUNNING',
      control: { newEntriesPaused: false, emergencyStopped: false, pausedReason: null },
      equity: {
        currentUsdMicro: equity,
        startUsdMicro: tl.start.equityUsdMicro,
        changeUsdMicro: (BigInt(equity) - BigInt(tl.start.equityUsdMicro)).toString(),
        rollingUsdMicro: (
          BigInt(demoCounters.cashUsdMicro) +
          demoPositions.reduce((acc, p) => acc + BigInt(p.copyUsdMicro), 0n)
        ).toString(),
        series,
        source: 'DEMO_FIXTURES',
        asOf: new Date().toISOString(),
      },
      activeTrader: {
        candidateId: `demo_${activeHandle}`,
        handle: activeHandle,
        avatarUrl: null,
        weeklyRank: activeRank,
        displayedPnl7dUsdMicro: (BigInt(Math.round(traderMeta.displayedPnl7dPct)) * 10000n).toString(),
        copyScale: 'COPY 0.25x',
        lastSix,
        streak,
        fireAfter: 2,
        realizedPnlUsdMicro: (contribution.get(activeHandle) ?? 0n).toString(),
        unrealizedPnlUsdMicro: [...openMirrors.values()]
          .reduce((acc, m) => acc + (m.pnlUsd === null ? 0n : BigInt(Math.round(m.pnlUsd * 1e6))), 0n)
          .toString(),
        boughtCount: mirrors.length,
        boughtUsdMicro: mirrors.reduce((acc, m) => acc + BigInt(Math.round(m.copyUsd * 1e6)), 0n).toString(),
        soldCount: closes.length,
        soldUsdMicro: null,
        firedCount: swaps.filter((h) => h.fromHandle === activeHandle).length,
        sinceIso: new Date(Date.now() - Math.max(0, elapsed - traderStartT) * 1000).toISOString(),
        source: 'demo-fixture',
      },
      // The replay is one fictional chair; the roster panel shows it as a single
      // seat (the real roster is filled from the promotion queue).
      roster: [
        {
          activationId: `demo_act_${activeHandle}`,
          candidateId: `demo_${activeHandle}`,
          handle: activeHandle,
          avatarUrl: null,
          status: gapActive ? 'FIRING' : 'ACTIVE',
          realizedPnlUsdMicro: (contribution.get(activeHandle) ?? 0n).toString(),
          unrealizedPnlUsdMicro: [...openMirrors.values()]
            .reduce((acc, m) => acc + (m.pnlUsd === null ? 0n : BigInt(Math.round(m.pnlUsd * 1e6))), 0n)
            .toString(),
          openPositions: openMirrors.size,
          lastSix,
          streak,
          fireAfter: 2,
          sinceIso: new Date(Date.now() - Math.max(0, elapsed - traderStartT) * 1000).toISOString(),
        },
      ],
      closes: closes.slice(-60).map((c, i) => ({
        id: `demo-${i}`,
        t: String(c.t),
        pnlUsdMicro: c.pnlUsdMicro,
        traderHandle: this.traderForClose(eventsApplied, c.t),
        symbol: c.symbol,
      })),
      positions: demoPositions,
      activity: demoActivity,
      activityNoiseCount: 0,
      counters: demoCounters,
      stats: {
        copiedTrades: closes.length,
        winners,
        winRatePct: closes.length ? Math.round((winners / closes.length) * 100) : null,
      },
      candidates: {
        sessionElapsedSeconds: sessionElapsed,
        sessionTotalSeconds: sessionTotal,
        entries: tl.traders.map((t) => ({
          candidateId: `demo_${t.handle}`,
          handle: t.handle,
          weeklyRank: t.weeklyRank,
          fired: swaps.some((h) => h.fromHandle === t.handle),
          active: t.handle === activeHandle,
          contributionUsdMicro: (contribution.get(t.handle) ?? 0n).toString(),
        })),
      },
      // The pipeline spine, told from the replay itself (fictional, like
      // everything else in demo mode): the fixture's handles are "discovered",
      // watched, hired, fired and returned to the watch list as the story runs.
      pipeline: {
        asOf: new Date().toISOString(),
        discovery: {
          lastSyncAt: null,
          newHandles24h: tl.traders.length,
          creditsRemaining: null,
          sources: ['demo replay'],
        },
        pool: {
          total: tl.traders.length,
          withWallet: tl.traders.length,
          fundedBuyers24h: tradersSeen,
        },
        watch: { watching: 0, cooling: 0, promotable: 0, benchTarget: DEFAULT_RISK.BENCH_TARGET },
        roster: [
          {
            activationId: `demo_act_${activeHandle}`,
            candidateId: `demo_${activeHandle}`,
            handle: activeHandle,
            status: gapActive ? 'IDLE' : openMirrors.size > 0 ? 'BUYING' : 'IDLE',
            realizedPnlUsdMicro: (contribution.get(activeHandle) ?? 0n).toString(),
            unrealizedPnlUsdMicro: [...openMirrors.values()]
              .reduce((acc, m) => acc + (m.pnlUsd === null ? 0n : BigInt(Math.round(m.pnlUsd * 1e6))), 0n)
              .toString(),
            openPositions: openMirrors.size,
            lastSignalAt: new Date().toISOString(),
            idleFireHoursLeft: openMirrors.size === 0 ? 6 : null,
          },
        ],
        exits: {
          fired24h: swaps.length,
          replacements24h: swaps.length,
          recent: swaps.map((sw) => ({
            candidateId: `demo_${sw.fromHandle}`,
            handle: sw.fromHandle,
            reason: sw.reason,
            firedAt: new Date(Date.now() - Math.max(0, elapsed - sw.t) * 1000).toISOString(),
            replacedBy: sw.toHandle,
          })),
        },
        edges: [
          { from: 'discovery', to: 'pool', count24h: tl.traders.length },
          { from: 'pool', to: 'watch', count24h: tl.traders.length },
          { from: 'watch', to: 'roster', count24h: 1 + swaps.length },
          { from: 'roster', to: 'exits', count24h: swaps.length },
          { from: 'exits', to: 'watch', count24h: swaps.length },
        ],
      },
      // The fictional replay never touches the watch tables: the panel shows its
      // empty state with the shipped defaults as targets.
      health: {
        workerRunning: true,
        helius: 'OK',
        jupiter: 'OK',
        lastTickIso: new Date().toISOString(),
        pendingReconciliations: 0,
        feeSolBalance: null,
        feeSolUsdMicro: null,
        walletUsdcBase: null,
        walletUsdcUsdMicro: null,
      },
      watchlist: {
        size: 0,
        cap: DEFAULT_RISK.WATCH_LIST_SIZE,
        bench: 0,
        benchTarget: DEFAULT_RISK.BENCH_TARGET,
        nextDiscoveryReason: 'demo replay: discovery is disabled (no API spend)',
        rows: [],
      },
      fictional: true,
    };
  }

  private traderForClose(events: DemoEvent[], t: number): string {
    let current = this.timeline.start.handle;
    for (const e of events) {
      if (e.type === 'switch' && e.t <= t) current = e.toHandle ?? current;
      if (e.type !== 'switch' && e.t > t) break;
    }
    return current;
  }
}

export function defaultFixturesPath(repoRoot: string): string {
  return resolve(repoRoot, 'fixtures', 'demo-timeline.json');
}
