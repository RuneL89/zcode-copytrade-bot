import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { AppConfig, RiskConfig } from '@zcode-bot/config';
import { bankrollHeadroom, canPromote, dashboardBadges, usdToMicro } from '@zcode-bot/core';
import type { DashboardState } from './state.js';
import { discoveryDecision } from './discovery.js';
import type { ControlService } from './control.js';
import type { LeaderMonitor } from './monitor.js';
import type { TraderLifecycle } from './lifecycle.js';
import { SOL_MINT, USDC_MINT, USDT_MINT } from './engine.js';

/** Marks older than this are treated as "no mark" (provider may be down). */
const MARK_MAX_AGE_MS = 300_000;
/** Activity tape length: copied/skipped/exit rows sent to the dashboard. */
const ACTIVITY_LIMIT = 50;
/** The tape shows only the last 18 hours; older rows drop off the dashboard. */
export const ACTIVITY_WINDOW_HOURS = 18;
/** Observed-event window scanned to compose the tape (noise collapses into a counter). */
const OBSERVED_WINDOW = 300;

/** True when `tIso` falls inside the dashboard's activity window ending at `nowMs`. */
export function withinActivityWindow(tIso: string, nowMs: number): boolean {
  const t = Date.parse(tIso);
  return Number.isFinite(t) && nowMs - t <= ACTIVITY_WINDOW_HOURS * 3_600_000;
}

/**
 * Builds the authoritative dashboard state from persisted evidence. Every
 * number traces to demo fixtures, paper calculations, or live evidence, and
 * is labeled with source and freshness.
 */
export class StateBuilder {
  /** positionId -> live value of remaining tokens, refreshed by the runtime. */
  private marks = new Map<string, { valueUsdMicro: bigint; observedAt: number }>();

  constructor(
    private db: AppDatabase,
    private config: AppConfig,
    private control: ControlService,
    private monitor: LeaderMonitor | null,
    private lifecycle: TraderLifecycle,
    private equityStartUsdMicro: bigint,
    private lastKnownHealth: {
      helius: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
      jupiter: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
    } = { helius: 'UNCONFIGURED', jupiter: 'UNCONFIGURED' },
  ) {}

  setHealth(h: {
    helius: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
    jupiter: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
  }): void {
    this.lastKnownHealth = h;
  }

  /** Called by the runtime after re-pricing a position's remaining tokens. */
  setMark(positionId: string, valueUsdMicro: bigint, observedAt: number): void {
    this.marks.set(positionId, { valueUsdMicro, observedAt });
  }

  /** Fee wallet: SOL balance (lamports) + its USD value at last refresh. */
  private feeWallet: { solLamports: number | null; solUsdMicro: bigint | null } = {
    solLamports: null,
    solUsdMicro: null,
  };

  /** Called by the runtime each health cycle (SOL pays every network fee). */
  setFeeWallet(solLamports: number | null, solUsdMicro: bigint | null): void {
    this.feeWallet = { solLamports, solUsdMicro };
  }

  /**
   * Chain-priced SOL spend, refreshed by the runtime's fee ledger. Null until
   * the first scan — the dashboard then shows "—" instead of a fake $0.00.
   */
  private feeLedger: {
    totals: {
      feeLamports: number;
      rentLamports: number;
      accountsOpened: number;
      accountsClosed: number;
      txs: number;
    };
    tx: Record<string, { feeLamports: number; rentLamports: number }>;
    solUsdMicro: bigint | null;
  } | null = null;

  setFeeLedger(input: StateBuilder['feeLedger']): void {
    this.feeLedger = input;
  }

  private lamportsToUsdMicro(lamports: number): bigint | null {
    const price = this.feeLedger?.solUsdMicro;
    if (price === null || price === undefined) return null;
    return (BigInt(Math.max(0, Math.round(lamports))) * price) / 10n ** 9n;
  }

  /** Discovery-stage facts (plan 07), read lazily from the service's record. */
  private discoveryStatus:
    (() => { lastRunAt: string | null; creditsRemaining: number | null; sources: string[] }) | null = null;

  setDiscoveryStatus(
    fn: () => { lastRunAt: string | null; creditsRemaining: number | null; sources: string[] },
  ): void {
    this.discoveryStatus = fn;
  }

  /** Wallet USDC balance (base units) at the last health sample. */
  private walletUsdcBase: bigint | null = null;

  setWalletUsdc(usdcBase: bigint | null): void {
    this.walletUsdcBase = usdcBase;
  }

  /** Latest mark for a position, for callers outside the dashboard build. */
  peekMark(positionId: string): { valueUsdMicro: bigint; observedAt: number } | null {
    return this.marks.get(positionId) ?? null;
  }

  build(): DashboardState {
    const mode = this.config.mode;
    const now = Date.now();

    // --- app state -------------------------------------------------------
    // The roster (plan 05): the first chair keeps the legacy `activeTrader`
    // shape for one release; plan 06 removes it in favour of `roster`.
    const activeActivations = repo.listActiveActivations(this.db);
    const activation = activeActivations[0] ?? null;
    let appState: DashboardState['appState'] = 'RUNNING';
    if (this.control.flags.emergencyStopped) appState = 'EMERGENCY_STOPPED';
    else if (repo.openReconciliationCases(this.db).length > 0 && !activation)
      appState = 'REQUIRES_RECONCILIATION';
    else if (activation?.state === 'REQUIRES_RECONCILIATION') appState = 'REQUIRES_RECONCILIATION';
    else if (this.control.flags.newEntriesPaused) appState = 'PAUSED_NEW_ENTRIES';
    else if (!activation) {
      // No active trader: the chairs are empty. The promotion queue fills them
      // from the watch list, and an empty chair is an acceptable state (D4).
      appState = 'PAUSED_NO_TRADER';
    }

    // --- equity + closes ---------------------------------------------------
    const positions = repo.listPositions(this.db, 200);
    const lots = repo.listPnlLots(this.db, 500);
    const equityStart = this.equityStartUsdMicro;
    let equityNow = equityStart;
    for (const lot of lots) equityNow += BigInt(lot.pnlUsdMicro);
    const winners = lots.filter((l) => BigInt(l.pnlUsdMicro) > 0n).length;

    // Equity series: start point plus every lot.
    const series: DashboardState['equity']['series'] = [
      {
        t: lots.length ? lots[lots.length - 1]!.closedAt : new Date(now).toISOString(),
        usdMicro: equityStart.toString(),
      },
    ];
    let running = equityStart;
    for (const lot of [...lots].reverse()) {
      running += BigInt(lot.pnlUsdMicro);
      series.push({ t: lot.closedAt, usdMicro: running.toString() });
    }

    const closes: DashboardState['closes'] = lots.slice(0, 60).map((lot) => ({
      id: `lot-${lot.id}`,
      t: lot.closedAt,
      pnlUsdMicro: lot.pnlUsdMicro,
      traderHandle: this.handleForPosition(lot.positionId),
      // Same symbol the open row showed: resolved once on the position.
      symbol: positions.find((p) => p.positionId === lot.positionId)?.mintSymbol ?? null,
    }));

    // --- positions panel (every non-closed position, with live mark) --------
    const openPositionRows = positions.filter(
      (p) => p.status === 'open' || p.status === 'partially_closed' || p.status === 'requires_reconciliation',
    );
    // Entry signature per position, so each row can show the real on-chain
    // cost of the transaction that opened it rather than a fixed estimate.
    const entrySpendByPosition = new Map<string, { feeLamports: number; rentLamports: number }>();
    if (this.feeLedger) {
      const fillsOldestFirst = repo
        .listFills(this.db, 500)
        .slice()
        .sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt));
      for (const fill of fillsOldestFirst) {
        if (!fill.positionId || entrySpendByPosition.has(fill.positionId)) continue;
        const spend = fill.txSignature ? this.feeLedger.tx[fill.txSignature] : null;
        if (spend) entrySpendByPosition.set(fill.positionId, spend);
      }
    }
    const positionsPanel: DashboardState['positions'] = openPositionRows.map((p) => {
      const mark = this.marks.get(p.positionId);
      const markAgeSeconds = mark ? Math.max(0, Math.round((now - mark.observedAt) / 1000)) : null;
      const fresh =
        mark !== undefined && markAgeSeconds !== null && mark.observedAt > now - MARK_MAX_AGE_MS
          ? mark
          : null;
      const markUsdMicro = fresh ? fresh.valueUsdMicro.toString() : null;
      const entrySpend = entrySpendByPosition.get(p.positionId) ?? null;
      return {
        positionId: p.positionId,
        leaderHandle: this.handleForPosition(p.positionId),
        mintShort: mintShort(p.mint),
        symbol: p.mintSymbol,
        status: p.status,
        copyUsdMicro: p.inputUsdMicro,
        feesUsdMicro: p.feesUsdMicro,
        entryFeeLamports: entrySpend ? entrySpend.feeLamports : null,
        entryRentLamports: entrySpend ? entrySpend.rentLamports : null,
        realizedPnlUsdMicro: p.realizedPnlUsdMicro,
        markUsdMicro,
        unrealizedPnlUsdMicro: fresh ? (fresh.valueUsdMicro - BigInt(p.inputUsdMicro)).toString() : null,
        markAgeSeconds: fresh ? markAgeSeconds : null,
        openedIso: p.openedAt,
      };
    });

    // --- active trader -------------------------------------------------------
    // Per-hire performance: realized (fee-net lots) + unrealized (live marks)
    // of THIS activation only — a rehire starts a new activation, so the
    // numbers reset on every hiring.
    let activeTrader: DashboardState['activeTrader'] = null;
    if (activation) {
      const candidate = repo.getCandidate(this.db, activation.candidateId);
      const activations = repo.listActivations(this.db, 500);
      const firedCount = activations.filter(
        (a) => a.candidateId === activation.candidateId && a.state === 'FIRED',
      ).length;
      const realized = lots
        .filter((l) => this.activationOfPosition(l.positionId) === activation.activationId)
        .reduce((acc, l) => acc + BigInt(l.pnlUsdMicro), 0n);
      const hirePositions = positionsPanel.filter((p) => {
        const row = openPositionRows.find((o) => o.positionId === p.positionId);
        return row?.activationId === activation.activationId;
      });
      const unrealized = hirePositions.reduce((acc, p) => acc + BigInt(p.unrealizedPnlUsdMicro ?? '0'), 0n);
      const hireLots = lots.filter(
        (l) => this.activationOfPosition(l.positionId) === activation.activationId,
      );
      const bought = repo
        .intentsInStates(this.db, ['confirmed'])
        .filter((i) => i.kind === 'entry' && i.activationId === activation.activationId)
        .reduce((acc, i) => ({ count: acc.count + 1, usd: acc.usd + BigInt(i.inputUsdMicro ?? '0') }), {
          count: 0,
          usd: 0n,
        });
      activeTrader = {
        candidateId: activation.candidateId,
        handle: candidate?.handle ?? activation.candidateId,
        avatarUrl: candidate?.avatarUrl ?? null,
        weeklyRank: candidate?.weeklyRank ?? null,
        displayedPnl7dUsdMicro: candidate?.displayedWeeklyPnlUsdMicro ?? null,
        copyScale: `COPY ${this.config.risk.COPY_SCALE}x`,
        lastSix: this.lifecycle.lastSixFor(activation.activationId),
        streak: activation.lossStreak,
        fireAfter: this.config.risk.FIRE_AFTER_CONSECUTIVE_LOSSES,
        realizedPnlUsdMicro: realized.toString(),
        unrealizedPnlUsdMicro: unrealized.toString(),
        boughtCount: bought.count,
        boughtUsdMicro: bought.usd.toString(),
        soldCount: hireLots.length,
        soldUsdMicro: hireLots.length
          ? hireLots.reduce((acc, l) => acc + BigInt(l.proceedsUsdMicro), 0n).toString()
          : null,
        firedCount,
        sinceIso: activation.startedAt,
        source: activation.source,
      };
    }

    // --- activity tape (leader buys → copy/skip, exits, unmatched sells) ----
    const observedEvents = repo.listObservedEvents(this.db, undefined, OBSERVED_WINDOW);
    const tape = this.buildActivity(positions, lots, observedEvents, now);
    const noise = tape.noiseCount;

    // --- counters (UTC day, same boundary the engine's risk gates use) ------
    const dayStartIso = new Date(new Date(now).toISOString().slice(0, 10)).toISOString();
    const intentsOfToday = repo
      .intentsInStates(this.db, ['confirmed', 'skipped', 'quote_rejected'])
      .filter((i) => i.kind === 'entry' && i.createdAt >= dayStartIso);
    const staleRejectionsToday = repo
      .listRiskRejections(this.db, 200)
      .filter((r) => r.rule === 'MAX_COPY_EVENT_AGE_SECONDS' && r.createdAt >= dayStartIso);
    const bank = bankrollHeadroom({
      equityStartUsdMicro: this.equityStartUsdMicro,
      openEntriesUsdMicro: openPositionRows.reduce((acc, p) => acc + BigInt(p.inputUsdMicro), 0n),
      openFeesUsdMicro: openPositionRows.reduce((acc, p) => acc + BigInt(p.feesUsdMicro), 0n),
      realizedNetUsdMicro: repo.realizedPnlSince(this.db, '1970-01-01T00:00:00.000Z'),
      maxDeployedPct: this.config.risk.MAX_DEPLOYED_PCT,
    });
    const deployedPct =
      bank.capitalUsdMicro > 0n
        ? Math.round(Number((bank.deployedUsdMicro * 10_000n) / bank.capitalUsdMicro)) / 100
        : 0;
    // Idle-fire countdown for the first chair (the legacy counters field); the
    // per-seat value below is what the roster shows.
    const idleFireHoursLeft = activation
      ? this.idleFireHoursLeftFor(activation.activationId, activation.startedAt, openPositionRows.length, now)
      : null;
    // Chain-priced SOL spend. Every figure below is read from transaction
    // evidence; nothing here is a guess. Null until the first ledger scan so
    // the dashboard can say "pending" instead of printing a fake zero.
    const feeLedgerTotals = this.feeLedger?.totals ?? null;
    const networkFeesUsdMicro = feeLedgerTotals ? this.lamportsToUsdMicro(feeLedgerTotals.feeLamports) : null;
    const rentUsdMicro = feeLedgerTotals ? this.lamportsToUsdMicro(feeLedgerTotals.rentLamports) : null;
    const openTokenAccounts = feeLedgerTotals
      ? Math.max(0, feeLedgerTotals.accountsOpened - feeLedgerTotals.accountsClosed)
      : null;

    const counters: DashboardState['counters'] = {
      copiedToday: intentsOfToday.filter((i) => i.state === 'confirmed').length,
      skippedToday:
        intentsOfToday.filter((i) => i.state === 'skipped' || i.state === 'quote_rejected').length +
        staleRejectionsToday.length,
      openPositions: openPositionRows.length,
      openExposureUsdMicro: bank.deployedUsdMicro.toString(),
      capitalUsdMicro: bank.capitalUsdMicro.toString(),
      cashUsdMicro: bank.cashUsdMicro.toString(),
      deployedUsdMicro: bank.deployedUsdMicro.toString(),
      deployedPct,
      maxDeployedPct: this.config.risk.MAX_DEPLOYED_PCT,
      /** Chairs the pipeline's roster grid renders (ROSTER_SIZE). */
      rosterSize: this.config.risk.ROSTER_SIZE,
      maxPositionAgeHours: this.config.risk.MAX_POSITION_AGE_HOURS,
      positionGraceHours: this.config.risk.POSITION_GRACE_HOURS,
      idleFireHoursLeft,
      feesPaidUsdMicro: networkFeesUsdMicro?.toString() ?? null,
      feesLamports: feeLedgerTotals?.feeLamports ?? null,
      rentUsdMicro: rentUsdMicro?.toString() ?? null,
      rentLamports: feeLedgerTotals?.rentLamports ?? null,
      openTokenAccounts,
      solUsdMicro: this.feeLedger?.solUsdMicro?.toString() ?? null,
      ledgerTxs: feeLedgerTotals?.txs ?? null,
    };

    // --- candidates panel ---------------------------------------------------
    const candidatesRows = repo.listCandidates(this.db);
    const activations = repo.listActivations(this.db, 500);
    const sessionStart = activations.length
      ? Date.parse(activations[activations.length - 1]!.startedAt)
      : now;
    const contributions = new Map<string, bigint>();
    for (const lot of lots) {
      const actId = this.activationOfPosition(lot.positionId);
      const act = activations.find((a) => a.activationId === actId);
      if (act)
        contributions.set(
          act.candidateId,
          (contributions.get(act.candidateId) ?? 0n) + BigInt(lot.pnlUsdMicro),
        );
    }
    const candidateEntries = candidatesRows
      .map((c) => ({
        candidateId: c.candidateId,
        handle: c.handle,
        weeklyRank: c.weeklyRank,
        fired: activations.some((a) => a.candidateId === c.candidateId && a.state === 'FIRED'),
        active: activation?.candidateId === c.candidateId,
        contributionUsdMicro: (contributions.get(c.candidateId) ?? 0n).toString(),
      }))
      .sort((a, b) => (a.weeklyRank ?? 999) - (b.weeklyRank ?? 999));

    const pendingRecon = repo.openReconciliationCases(this.db).length;
    const health = this.lastKnownHealth;
    const pipeline = this.buildPipeline(
      now,
      activeActivations,
      activations,
      positionsPanel,
      openPositionRows,
      lots,
    );

    return {
      version: 0,
      generatedAt: new Date(now).toISOString(),
      mode,
      armed: this.control.flags.armed && mode === 'live',
      badges: dashboardBadges({
        mode,
        armed: this.control.flags.armed,
        appState,
        dataStale: health.helius !== 'OK' && mode !== 'demo',
      }),
      appState,
      control: {
        newEntriesPaused: this.control.flags.newEntriesPaused,
        emergencyStopped: this.control.flags.emergencyStopped,
        pausedReason: this.control.flags.pausedReason,
      },
      equity: {
        currentUsdMicro: equityNow.toString(),
        startUsdMicro: equityStart.toString(),
        changeUsdMicro: (equityNow - equityStart).toString(),
        // Rolling equity: bankroll (investable cash, fees already sunk) plus
        // the live mark of every open position (at entry cost until priced).
        rollingUsdMicro: (
          bank.cashUsdMicro +
          positionsPanel.reduce((acc, p) => acc + BigInt(p.markUsdMicro ?? p.copyUsdMicro), 0n)
        ).toString(),
        series,
        source: mode === 'demo' ? 'DEMO_FIXTURES' : mode === 'paper' ? 'PAPER_CALCULATION' : 'LIVE_EVIDENCE',
        asOf: new Date(now).toISOString(),
      },
      activeTrader,
      roster: activeActivations.map((a) => {
        const candidate = repo.getCandidate(this.db, a.candidateId);
        const realized = lots
          .filter((l) => this.activationOfPosition(l.positionId) === a.activationId)
          .reduce((acc, l) => acc + BigInt(l.pnlUsdMicro), 0n);
        const hirePositions = positionsPanel.filter((p) => {
          const row = openPositionRows.find((o) => o.positionId === p.positionId);
          return row?.activationId === a.activationId;
        });
        const unrealized = hirePositions.reduce((acc, p) => acc + BigInt(p.unrealizedPnlUsdMicro ?? '0'), 0n);
        return {
          activationId: a.activationId,
          candidateId: a.candidateId,
          handle: candidate?.handle ?? a.candidateId,
          avatarUrl: candidate?.avatarUrl ?? null,
          status: a.state,
          realizedPnlUsdMicro: realized.toString(),
          unrealizedPnlUsdMicro: unrealized.toString(),
          openPositions: hirePositions.length,
          lastSix: this.lifecycle.lastSixFor(a.activationId),
          streak: a.lossStreak,
          fireAfter: this.config.risk.FIRE_AFTER_CONSECUTIVE_LOSSES,
          sinceIso: a.startedAt,
        };
      }),
      pipeline,
      closes,
      positions: positionsPanel,
      activity: tape.rows,
      activityNoiseCount: noise,
      counters,
      stats: {
        copiedTrades: lots.length,
        winners,
        winRatePct: lots.length > 0 ? Math.round((winners / lots.length) * 100) : null,
      },
      candidates: {
        sessionElapsedSeconds: Math.max(0, Math.round((now - sessionStart) / 1000)),
        sessionTotalSeconds: 24 * 3600,
        entries: candidateEntries,
      },
      watchlist: this.buildWatchlist(bank.headroomUsdMicro, now),
      health: {
        workerRunning: Boolean(this.monitor?.running),
        helius: mode === 'demo' ? 'OK' : health.helius,
        jupiter: mode === 'demo' ? 'OK' : health.jupiter,
        lastTickIso: this.monitor?.lastTickAt ?? null,
        pendingReconciliations: pendingRecon,
        feeSolBalance:
          this.feeWallet.solLamports !== null ? (this.feeWallet.solLamports / 1e9).toFixed(4) : null,
        feeSolUsdMicro: this.feeWallet.solUsdMicro?.toString() ?? null,
        walletUsdcBase: this.walletUsdcBase?.toString() ?? null,
        walletUsdcUsdMicro: this.walletUsdcBase?.toString() ?? null, // USDC base == micro-USD
      },
      fictional: mode === 'demo',
    };
  }

  /**
   * The D4 watch list: wallets under observation, their shadow record, and why
   * promotion is blocked. Numbers come from the shadow ledger only — the fomo
   * PnL mark is not an input (D4).
   */
  private buildWatchlist(headroomUsdMicro: bigint, now: number): DashboardState['watchlist'] {
    const risk = this.config.risk;
    const wallets = repo.listWatchWallets(this.db);
    const openLots = repo.listOpenShadowTrades(this.db);
    const ceilingMs = risk.MAX_POSITION_AGE_HOURS * 3_600_000;
    const slotsFree = Math.max(0, risk.ROSTER_SIZE - repo.activeActivationCount(this.db));

    const rows: DashboardState['watchlist']['rows'] = wallets.map((wallet) => {
      const candidate = repo.getCandidate(this.db, wallet.candidateId);
      const events = repo.listWatchEvents(this.db, wallet.candidateId, 200);
      const since24h = now - 24 * 3_600_000;
      const buys24h = events.filter((e) => e.side === 'buy' && Date.parse(e.observedAt) >= since24h).length;
      const sells24h = events.filter((e) => e.side === 'sell' && Date.parse(e.observedAt) >= since24h).length;
      const aggregates = repo.shadowAggregates(this.db, wallet.candidateId);
      const lots = openLots.filter((l) => l.candidateId === wallet.candidateId);
      const openNotional = lots.reduce((acc, l) => acc + BigInt(l.notionalUsdMicro), 0n);
      const ceilingExposure = lots
        .filter((l) => now - Date.parse(l.openedAt) >= ceilingMs)
        .reduce((acc, l) => acc + BigInt(l.notionalUsdMicro), 0n);
      const decision = canPromote({
        aggregates,
        lastFundedBuyAt: repo.lastFundedBuyAt(this.db, wallet.candidateId),
        lastFiredAt: repo.lastFiredAt(this.db, wallet.candidateId),
        nowMs: now,
        config: {
          promotionMinClosed: risk.PROMOTION_MIN_CLOSED,
          promotionMinNetUsdMicro: usdToMicro(risk.PROMOTION_MIN_NET_USD),
          promotionMaxLastBuyHours: risk.PROMOTION_MAX_LAST_BUY_HOURS,
          minHireHeadroomUsdMicro: usdToMicro(risk.MIN_HIRE_HEADROOM_USD),
        },
        slotsFree,
        headroomUsdMicro,
      });
      const status = (wallet.status as DashboardState['watchlist']['rows'][number]['status']) ?? 'watching';
      return {
        candidateId: wallet.candidateId,
        handle: candidate?.handle ?? wallet.candidateId,
        status,
        profileUrl: candidate?.profileUrl ?? null,
        lastFundedBuyAt: wallet.lastFundedBuyAt,
        fundedBuys24h: buys24h,
        fundedSells24h: sells24h,
        closedTrades: aggregates.closedCount,
        netShadowPnlUsdMicro: aggregates.netPnlUsdMicro.toString(),
        openNotionalUsdMicro: openNotional.toString(),
        ceilingExposureUsdMicro: ceilingExposure.toString(),
        // A promoted/cooling/archived row is not "blocked" — the reason only
        // explains why a watching row cannot move.
        blockedReason: status === 'watching' ? decision.reason : null,
        source: 'SHADOW_LEDGER',
        lastEventAt: events[0]?.observedAt ?? null,
      };
    });

    const decision = discoveryDecision({
      promotableWatchWallets: rows.filter((r) => r.status === 'promoted').length,
      watchListWallets: rows.filter((r) => r.status === 'watching').length,
      rosterInUse: repo.activeActivationCount(this.db),
      rosterSize: risk.ROSTER_SIZE,
      benchTarget: risk.BENCH_TARGET,
      lastRunAt: repo.kvGet(this.db, 'discovery.last_run_at') ?? null,
      nowMs: now,
      minIntervalMs: risk.DISCOVERY_MIN_INTERVAL_MS,
    });

    return {
      size: rows.filter((r) => r.status === 'watching').length,
      cap: risk.WATCH_LIST_SIZE,
      bench: rows.filter((r) => r.status === 'promoted').length,
      benchTarget: risk.BENCH_TARGET,
      nextDiscoveryReason: decision.reason,
      rows,
    };
  }

  /**
   * Hours left before the idle fire, or null when the seat holds a position
   * (the clock only runs while flat). The baseline is the later of the hire and
   * the last moment the seat held something, read from the monitor's own record
   * so the dashboard and the fire rule agree.
   */
  private idleFireHoursLeftFor(
    activationId: string,
    startedAt: string,
    seatPositions: number,
    now: number,
  ): number | null {
    if (seatPositions > 0) return null;
    const lastOpenAt = repo.kvGet(this.db, `monitor.lastOpenAt:${activationId}`);
    const baselineMs = Math.max(Date.parse(startedAt), lastOpenAt ? Date.parse(lastOpenAt) : 0);
    if (!Number.isFinite(baselineMs) || baselineMs <= 0) return null;
    const hours = (this.config.risk.IDLE_FIRE_HOURS * 3_600_000 - (now - baselineMs)) / 3_600_000;
    return Math.max(0, Math.round(hours * 10) / 10);
  }

  /**
   * The pipeline spine (plan 07). Every count is a read of persisted rows or
   * the discovery service's own record of its last run — nothing is estimated.
   */
  private buildPipeline(
    now: number,
    activeActivations: ReturnType<typeof repo.listActiveActivations>,
    activations: ReturnType<typeof repo.listActivations>,
    positionsPanel: DashboardState['positions'],
    openPositionRows: Array<{ positionId: string; activationId: string }>,
    lots: ReturnType<typeof repo.listPnlLots>,
  ): DashboardState['pipeline'] {
    const risk = this.config.risk;
    const cutoff24h = new Date(now - 24 * 3_600_000).toISOString();
    const candidates = repo.listCandidates(this.db);
    const walletIds = new Set(
      repo
        .listCandidateAddresses(this.db)
        .filter((a) => a.chain === 'solana')
        .map((a) => a.candidateId),
    );
    const enabled = candidates.filter((c) => c.enabled);
    const watchWallets = repo.listWatchWallets(this.db);

    const newHandles24h = candidates.filter((c) => c.createdAt >= cutoff24h).length;
    const admissions24h = watchWallets.filter((w) => w.admittedAt >= cutoff24h).length;
    // The return lane (exits → watch): a fired wallet re-enters the watch
    // record as `cooling` (the runtime marks it on every fire); the 24h count
    // is those recent re-entries.
    const cooled24h = watchWallets.filter((w) => w.status === 'cooling' && w.updatedAt >= cutoff24h).length;
    // A replacement is a chair filled from the promotion queue — the activation
    // row's source records exactly that.
    const replacements24h = activations.filter(
      (a) => a.source === 'watch_promotion' && a.startedAt >= cutoff24h,
    ).length;
    const firings24h = repo.listFiringEventsSince(this.db, cutoff24h).length;
    // The fired lane: the newest firings, each with the chair's replacement
    // status — the first promotion-hire that started after the firing took it.
    const firedLane = repo.listRecentFirings(this.db, 5).map((f) => {
      const hire = activations.find(
        (a) => a.startedAt > f.firedAt && a.candidateId !== f.candidateId && a.source === 'watch_promotion',
      );
      return {
        candidateId: f.candidateId,
        handle: repo.getCandidate(this.db, f.candidateId)?.handle ?? f.candidateId,
        reason: f.reason,
        firedAt: f.firedAt,
        replacedBy: hire ? (repo.getCandidate(this.db, hire.candidateId)?.handle ?? hire.candidateId) : null,
      };
    });

    const seats = activeActivations.map((a) => {
      const reconciling =
        a.state === 'REQUIRES_RECONCILIATION' ||
        positionsPanel.some((p) => {
          const row = openPositionRows.find((o) => o.positionId === p.positionId);
          return row?.activationId === a.activationId && p.status === 'requires_reconciliation';
        });
      // The newest observed signal decides what the seat shows: a sell is
      // SELLING, a buy (even a skipped one) is BUYING; no signal is IDLE.
      // Reconciliation overrides both — it is the state that freezes a chair.
      const signal = repo.listObservedEvents(this.db, a.activationId, 1)[0] ?? null;
      const status: DashboardState['pipeline']['roster'][number]['status'] = reconciling
        ? 'RECONCILING'
        : signal?.kind === 'swap_sell'
          ? 'SELLING'
          : signal?.kind === 'swap_buy' || signal?.kind === 'skipped'
            ? 'BUYING'
            : 'IDLE';
      const realized = lots
        .filter((l) => this.activationOfPosition(l.positionId) === a.activationId)
        .reduce((acc, l) => acc + BigInt(l.pnlUsdMicro), 0n);
      const seatPositions = positionsPanel.filter((p) => {
        const row = openPositionRows.find((o) => o.positionId === p.positionId);
        return row?.activationId === a.activationId;
      });
      const unrealized = seatPositions.reduce((acc, p) => acc + BigInt(p.unrealizedPnlUsdMicro ?? '0'), 0n);
      return {
        activationId: a.activationId,
        candidateId: a.candidateId,
        handle: repo.getCandidate(this.db, a.candidateId)?.handle ?? a.candidateId,
        status,
        realizedPnlUsdMicro: realized.toString(),
        unrealizedPnlUsdMicro: unrealized.toString(),
        openPositions: seatPositions.length,
        lastSignalAt: signal?.processedAt ?? null,
        idleFireHoursLeft: this.idleFireHoursLeftFor(a.activationId, a.startedAt, seatPositions.length, now),
      };
    });

    const discovery = this.discoveryStatus?.() ?? { lastRunAt: null, creditsRemaining: null, sources: [] };

    return {
      asOf: new Date(now).toISOString(),
      discovery: {
        lastSyncAt: discovery.lastRunAt,
        newHandles24h,
        creditsRemaining: discovery.creditsRemaining,
        sources: discovery.sources,
      },
      pool: {
        total: enabled.length,
        withWallet: enabled.filter((c) => walletIds.has(c.candidateId)).length,
        fundedBuyers24h: enabled.filter((c) => c.activityCheckStatus === 'ok' && (c.buys24h ?? 0) > 0).length,
      },
      watch: {
        watching: watchWallets.filter((w) => w.status === 'watching').length,
        cooling: watchWallets.filter((w) => w.status === 'cooling').length,
        promotable: watchWallets.filter((w) => w.status === 'promoted').length,
        benchTarget: risk.BENCH_TARGET,
      },
      roster: seats,
      exits: { fired24h: firings24h, replacements24h, recent: firedLane },
      edges: [
        { from: 'discovery', to: 'pool', count24h: newHandles24h },
        { from: 'pool', to: 'watch', count24h: admissions24h },
        { from: 'watch', to: 'roster', count24h: replacements24h },
        { from: 'roster', to: 'exits', count24h: firings24h },
        { from: 'exits', to: 'watch', count24h: cooled24h },
      ],
    };
  }

  private handleForPosition(positionId: string): string {
    const activationId = this.activationOfPosition(positionId);
    if (!activationId) return 'unknown';
    const act = repo.getActivation(this.db, activationId);
    if (!act) return 'unknown';
    return repo.getCandidate(this.db, act.candidateId)?.handle ?? act.candidateId;
  }

  private activationOfPosition(positionId: string): string | null {
    const pos = repo.getPosition(this.db, positionId);
    return pos?.activationId ?? null;
  }

  /**
   * Compose the leader-activity tape from persisted evidence only: observed
   * leader events joined with their order intents (copy result / skip reason),
   * exits matched to realized PnL lots, and stale-event rejections that never
   * became intents. Unparseable events collapse into a counter.
   */
  private buildActivity(
    positions: ReturnType<typeof repo.listPositions>,
    lots: ReturnType<typeof repo.listPnlLots>,
    observed: ReturnType<typeof repo.listObservedEvents>,
    nowMs: number,
  ): { rows: DashboardState['activity']; noiseCount: number } {
    const intents = repo.intentsInStates(this.db, ['confirmed', 'skipped', 'quote_rejected']);
    const staleBySig = new Map<string, string>();
    for (const r of repo.listRiskRejections(this.db, 200)) {
      if (r.rule === 'MAX_COPY_EVENT_AGE_SECONDS' && r.detail?.includes('stale buy ')) {
        staleBySig.set(r.detail.replace('stale buy ', '').trim(), r.rule);
      }
    }

    let noiseCount = 0;
    const rows: DashboardState['activity'] = [];
    for (const ev of observed) {
      const detail = safeParseDetail(ev.detailJson);
      const tIso = ev.blockTime !== null ? new Date(ev.blockTime * 1000).toISOString() : ev.processedAt;
      // The dashboard tape is an 18-hour window: older evidence is dropped
      // entirely (noise included) so the panel reflects recent behaviour.
      if (!withinActivityWindow(tIso, nowMs)) continue;

      if (ev.kind === 'skipped') {
        noiseCount++;
        continue;
      }

      if (ev.kind === 'swap_buy') {
        const intent = intents.find(
          (i) => i.kind === 'entry' && (i.idempotencyKey ?? '').includes(ev.signature),
        );
        const base = {
          id: `obs-${ev.id}`,
          tIso,
          tokenShort: detail?.mint ? mintShort(detail.mint) : null,
          leaderUsdMicro:
            detail?.fundingMint === USDC_MINT || detail?.fundingMint === USDT_MINT
              ? baseUnitsToString(detail.fundingDeltaBase)
              : null,
          leaderSolBase: detail?.fundingMint === SOL_MINT ? baseUnitsToString(detail.fundingDeltaBase) : null,
        };
        if (intent && intent.state === 'confirmed') {
          rows.push({
            ...base,
            kind: 'copied',
            copyUsdMicro: intent.inputUsdMicro,
            realizedPnlUsdMicro: null,
            reasonChip: null,
          });
        } else {
          const chip = intent
            ? chipFromReason(intent.reason)
            : staleBySig.get(ev.signature)
              ? 'TOO OLD'
              : 'NOT COPIED';
          rows.push({
            ...base,
            kind: 'skipped',
            copyUsdMicro: intent?.inputUsdMicro ?? null,
            realizedPnlUsdMicro: null,
            reasonChip: chip,
          });
        }
        continue;
      }

      if (ev.kind === 'swap_sell') {
        const pos = detail?.mint
          ? positions.find((p) => p.mint === detail.mint && p.activationId === ev.activationId)
          : undefined;
        if (!pos) {
          rows.push({
            id: `obs-${ev.id}`,
            tIso,
            kind: 'leader_sell',
            tokenShort: detail?.mint ? mintShort(detail.mint) : null,
            leaderUsdMicro: null,
            leaderSolBase: null,
            copyUsdMicro: null,
            realizedPnlUsdMicro: null,
            reasonChip: null,
          });
          continue;
        }
        const lot = lots.find(
          (l) =>
            l.positionId === pos.positionId && Date.parse(l.closedAt) >= (ev.blockTime ?? 0) * 1000 - 60_000,
        );
        rows.push({
          id: lot ? `lot-${lot.id}` : `obs-${ev.id}`,
          tIso,
          kind: 'exit',
          tokenShort: mintShort(pos.mint),
          leaderUsdMicro: null,
          leaderSolBase: null,
          copyUsdMicro: null,
          realizedPnlUsdMicro: lot ? lot.pnlUsdMicro : pos.realizedPnlUsdMicro,
          reasonChip: null,
        });
      }
    }

    rows.sort((a, b) => b.tIso.localeCompare(a.tIso));
    return { rows: rows.slice(0, ACTIVITY_LIMIT), noiseCount };
  }
}

function safeParseDetail(json: string | null): {
  mint?: string;
  fundingMint?: string;
  fundingDeltaBase?: string | number;
} | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as { mint?: string; fundingMint?: string; fundingDeltaBase?: string | number };
  } catch {
    return null;
  }
}

function mintShort(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * detailJson stores bigints via stringifyBigIntSafe, which renders them as
 * "123n" (literal syntax). Amounts sent to the dashboard must be plain digit
 * strings — the web helpers BigInt() them directly.
 */
function baseUnitsToString(v: string | number | bigint | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.endsWith('n') ? s.slice(0, -1) : s;
}

/** Map a risk-gate reason string to a short, human chip label. */
function chipFromReason(reason: string | null | undefined): string {
  if (!reason) return 'SKIPPED';
  const rule = reason.split(/[:\s]/)[0] ?? reason;
  switch (rule) {
    case 'MAX_DEPLOYED_PCT':
      return 'BANKROLL CAP';
    case 'MAX_POSITION_USD':
      return 'POSITION CAP';
    case 'MAX_TOTAL_EXPOSURE_USD':
      return 'EXPOSURE CAP';
    case 'MAX_SLIPPAGE_BPS':
      return 'SLIPPAGE';
    case 'MAX_PRICE_IMPACT_BPS':
      return 'PRICE IMPACT';
    case 'MIN_PER_BUY_USD':
      return 'BELOW MIN';
    case 'MAX_COPY_EVENT_AGE_SECONDS':
      return 'TOO OLD';
    case 'MAX_TRADES_PER_DAY':
      return 'DAILY LIMIT';
    case 'MAX_DAILY_REALIZED_LOSS_USD':
      return 'DAILY LOSS';
  }
  if (/paused/i.test(reason)) return 'PAUSED';
  if (/emergency/i.test(reason)) return 'EMERGENCY';
  return rule.slice(0, 18);
}
