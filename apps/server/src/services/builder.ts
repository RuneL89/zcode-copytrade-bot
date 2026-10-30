import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { AppConfig, RiskConfig } from '@zcode-bot/config';
import { bankrollHeadroom, dashboardBadges, recommendationExpired } from '@zcode-bot/core';
import type { DashboardState } from './state.js';
import type { ControlService } from './control.js';
import type { LeaderMonitor } from './monitor.js';
import type { RecommendationService } from './research.js';
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
    private recommendations: RecommendationService,
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
    const activation = repo.activeActivation(this.db);
    const lastHandoff = repo.listHandoffEvents(this.db, 1)[0];
    let appState: DashboardState['appState'] = 'RUNNING';
    if (this.control.flags.emergencyStopped) appState = 'EMERGENCY_STOPPED';
    else if (repo.openReconciliationCases(this.db).length > 0 && !activation)
      appState = 'REQUIRES_RECONCILIATION';
    else if (activation?.state === 'REQUIRES_RECONCILIATION') appState = 'REQUIRES_RECONCILIATION';
    else if (this.control.flags.newEntriesPaused) appState = 'PAUSED_NEW_ENTRIES';
    else if (!activation) {
      // No active trader: waiting for a candidate (initial), ZCode (post-firing
      // pause), or fresh research (the ordering predates the newest scan).
      appState =
        lastHandoff?.status === 'paused_waiting_for_zcode' ||
        lastHandoff?.status === 'paused_for_fresh_research'
          ? 'PAUSED_WAITING_FOR_ZCODE'
          : 'PAUSED_WAITING_FOR_CANDIDATE';
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
    // Idle-fire countdown: only counting while the hire holds zero positions.
    let idleFireHoursLeft: number | null = null;
    if (activation && openPositionRows.length === 0) {
      const lastOpenAt = repo.kvGet(this.db, `monitor.lastOpenAt:${activation.activationId}`);
      const baselineMs = Math.max(Date.parse(activation.startedAt), lastOpenAt ? Date.parse(lastOpenAt) : 0);
      if (Number.isFinite(baselineMs) && baselineMs > 0) {
        idleFireHoursLeft = Math.max(
          0,
          Math.round(((this.config.risk.IDLE_FIRE_HOURS * 3_600_000 - (now - baselineMs)) / 3_600_000) * 10) /
            10,
        );
      }
    }
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
    const snapshot = this.recommendations.currentSnapshotForLifecycle();
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
        awaitingZcode: false,
      }))
      .sort((a, b) => (a.weeklyRank ?? 999) - (b.weeklyRank ?? 999));

    // --- recommendation ------------------------------------------------------
    const latest = this.recommendations.latestAny();
    const valid = this.recommendations.latestValid();
    let recStatus: DashboardState['recommendation']['status'] = 'NONE';
    if (valid) recStatus = 'VALID';
    else if (latest?.status === 'rejected') recStatus = 'REJECTED';
    else if (latest?.abstain) recStatus = 'ABSTAIN';
    else if (latest && recommendationExpired({ expiresAt: latest.expiresAt }, now)) recStatus = 'EXPIRED';
    const ordered = valid
      ? valid.payload.orderedCandidates.map((c) => {
          const row = candidatesRows.find((r) => r.candidateId === c.candidateId);
          return {
            candidateId: c.candidateId,
            handle: row?.handle ?? null,
            rank: c.rank,
            confidence: c.confidence,
            thesis: c.thesis,
            concerns: c.concerns,
            eligibleNow: Boolean(
              snapshot?.candidates.find((s) => s.candidateId === c.candidateId && s.enabled),
            ),
          };
        })
      : [];

    // --- handoff (drives the fired animation) --------------------------------
    let handoff: DashboardState['handoff'] = null;
    if (lastHandoff && now - Date.parse(lastHandoff.createdAt) < 20_000) {
      const from = candidatesRows.find((c) => c.candidateId === lastHandoff.fromCandidateId);
      const to = candidatesRows.find((c) => c.candidateId === lastHandoff.toCandidateId);
      // Fire reason from the outgoing trader's latest firing event, so the
      // overlay shows rank/rotation/stall/idle instead of a hardcoded cause.
      const firedActivation = activations
        .filter((a) => a.candidateId === lastHandoff.fromCandidateId && a.state === 'FIRED')
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      const fireReason = firedActivation
        ? (repo.latestFiringEventForActivation(this.db, firedActivation.activationId)?.reason ?? null)
        : null;
      handoff = {
        phase:
          lastHandoff.status === 'activated'
            ? 'FIRED'
            : lastHandoff.status === 'paused_for_fresh_research'
              ? 'PAUSED_FOR_FRESH_RESEARCH'
              : 'WAITING_FOR_ZCODE',
        fromHandle: from?.handle ?? lastHandoff.fromCandidateId ?? '',
        fromRank: from?.weeklyRank ?? null,
        fromPnlText: from?.displayedWeeklyPnlUsdMicro
          ? `${(Number(from.displayedWeeklyPnlUsdMicro) / 1e6).toFixed(0)}% 7d (displayed)`
          : null,
        fromReason: fireReason,
        toHandle: to?.handle ?? null,
        toRank: to?.weeklyRank ?? null,
        atIso: lastHandoff.createdAt,
        demo: mode === 'demo',
      };
    }

    // --- hiring loop (the fired → paused → research → auto-hire cycle) ------
    const pausedForResearch =
      !activation &&
      (lastHandoff?.status === 'paused_waiting_for_zcode' ||
        lastHandoff?.status === 'paused_for_fresh_research');
    const latestScanRow = repo.listRecentScans(this.db, 1)[0] ?? null;
    const researchRequested = pausedForResearch
      ? repo
          .listControlEvents(this.db, 20)
          .some(
            (e) =>
              (e.type === 'research_request' || e.type === 'replacement_request') &&
              e.createdAt >= (lastHandoff?.createdAt ?? ''),
          )
      : false;
    const hiring: DashboardState['hiring'] = {
      pausedForResearch,
      reason: pausedForResearch ? (lastHandoff?.detail ?? null) : null,
      latestScanAt: latestScanRow?.observedAt ?? null,
      recommendationAt: latest?.createdAt ?? null,
      researchRequested,
      autoResume: true,
    };

    const pendingRecon = repo.openReconciliationCases(this.db).length;
    const health = this.lastKnownHealth;

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
      handoff,
      hiring,
      recommendation: {
        status: recStatus,
        ageMs: latest ? Math.max(0, now - Date.parse(latest.createdAt)) : null,
        expiresInMs: latest ? Math.max(0, Date.parse(latest.expiresAt) - now) : null,
        modelLabel: latest?.modelLabel ?? null,
        ordered,
      },
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
