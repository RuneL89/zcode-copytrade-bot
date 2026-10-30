import type { AppState, DashboardBadge } from '@zcode-bot/core';

/** Full SSE/REST contract consumed by the React dashboard. */
export interface DashboardState {
  version: number;
  generatedAt: string;
  mode: 'demo' | 'paper' | 'live';
  armed: boolean;
  badges: DashboardBadge[];
  appState: AppState;
  control: {
    newEntriesPaused: boolean;
    emergencyStopped: boolean;
    pausedReason: string | null;
  };
  equity: {
    currentUsdMicro: string;
    startUsdMicro: string;
    changeUsdMicro: string;
    /** Bankroll (cash, investable now) + unrealized marks of open positions. */
    rollingUsdMicro: string;
    series: Array<{ t: string; usdMicro: string }>;
    source: 'DEMO_FIXTURES' | 'PAPER_CALCULATION' | 'LIVE_EVIDENCE';
    asOf: string;
  };
  activeTrader: null | {
    candidateId: string;
    handle: string;
    avatarUrl: string | null;
    weeklyRank: number | null;
    /** Displayed (unverified) leaderboard 7d PnL. */
    displayedPnl7dUsdMicro: string | null;
    copyScale: string;
    lastSix: Array<'W' | 'L' | 'B'>;
    streak: number;
    fireAfter: number;
    /** Realized PnL of this hire's closed lots (fee-net). */
    realizedPnlUsdMicro: string;
    /** Unrealized PnL of this hire's open positions at live marks. */
    unrealizedPnlUsdMicro: string;
    /** Entry copies confirmed since this hire began (pyramids count). */
    boughtCount: number;
    /** Total spent on those entries (excl. fees — fees shown via bankroll). */
    boughtUsdMicro: string;
    /** Exits mirrored since this hire began. */
    soldCount: number;
    /** Total proceeds of those exits (USDC legs, fee-embedded), null if none. */
    soldUsdMicro: string | null;
    firedCount: number;
    sinceIso: string;
    source: string;
  };
  closes: Array<{
    id: string;
    t: string;
    pnlUsdMicro: string;
    traderHandle: string;
    symbol: string | null;
  }>;
  /** Every non-closed copied position (open / partially closed / reconciling). */
  positions: Array<{
    positionId: string;
    mintShort: string;
    symbol: string | null;
    status: string;
    copyUsdMicro: string;
    /** Entry fee recorded on the position (paper: 5 bps; live: flat network fee). */
    feesUsdMicro: string;
    /** Real network fee of the entry transaction, read from the chain. */
    entryFeeLamports: number | null;
    /** Rent that transaction locked into newly opened token accounts. */
    entryRentLamports: number | null;
    realizedPnlUsdMicro: string;
    /** Live value of the remaining tokens (Jupiter quote); null until priced. */
    markUsdMicro: string | null;
    unrealizedPnlUsdMicro: string | null;
    markAgeSeconds: number | null;
    openedIso: string;
  }>;
  /** Leader-event tape: copies, mirrored exits, and every skipped buy with its reason. */
  activity: Array<{
    id: string;
    tIso: string;
    kind: 'copied' | 'exit' | 'skipped' | 'leader_sell';
    tokenShort: string | null;
    /** Leader's input size: exact micro-USD when the funding leg was a stable. */
    leaderUsdMicro: string | null;
    /** Leader's input size in SOL base units (9 decimals) when funded with SOL. */
    leaderSolBase: string | null;
    copyUsdMicro: string | null;
    realizedPnlUsdMicro: string | null;
    reasonChip: string | null;
  }>;
  /** Non-trade leader events (airdrops/transfers/unparseable) in the same window. */
  activityNoiseCount: number;
  counters: {
    copiedToday: number;
    skippedToday: number;
    openPositions: number;
    /** Deployed in open positions INCLUDING entry fees. */
    openExposureUsdMicro: string;
    /** equityStart + realized (fee-net). */
    capitalUsdMicro: string;
    /** capital − deployed: the operator's free cash. */
    cashUsdMicro: string;
    deployedUsdMicro: string;
    deployedPct: number;
    maxDeployedPct: number;
    /** Day-trader time-exit window (display). */
    maxPositionAgeHours: number;
    positionGraceHours: number;
    /** Hours until the idle fire, counting only while flat; null when holding. */
    idleFireHoursLeft: number | null;
    /**
     * Real network fees paid, priced from chain transaction fees. Null until
     * the fee ledger has scanned (never a fabricated zero).
     */
    feesPaidUsdMicro: string | null;
    feesLamports: number | null;
    /** Rent currently locked in the wallet's SPL token accounts. */
    rentUsdMicro: string | null;
    rentLamports: number | null;
    openTokenAccounts: number | null;
    solUsdMicro: string | null;
    /** Transactions the ledger has priced. */
    ledgerTxs: number | null;
  };
  stats: {
    copiedTrades: number;
    winners: number;
    winRatePct: number | null;
  };
  candidates: {
    sessionElapsedSeconds: number;
    sessionTotalSeconds: number;
    entries: Array<{
      candidateId: string;
      handle: string;
      weeklyRank: number | null;
      fired: boolean;
      active: boolean;
      contributionUsdMicro: string;
      awaitingZcode: boolean;
    }>;
  };
  handoff: null | {
    phase: 'FIRED' | 'WAITING_FOR_ZCODE';
    fromHandle: string;
    fromRank: number | null;
    fromPnlText: string | null;
    toHandle: string | null;
    toRank: number | null;
    atIso: string;
    demo: boolean;
  };
  recommendation: {
    status: 'NONE' | 'VALID' | 'EXPIRED' | 'REJECTED' | 'ABSTAIN';
    ageMs: number | null;
    expiresInMs: number | null;
    modelLabel: string | null;
    ordered: Array<{
      candidateId: string;
      handle: string | null;
      rank: number;
      confidence: number;
      thesis: string;
      concerns: string[];
      eligibleNow: boolean;
    }>;
  };
  health: {
    workerRunning: boolean;
    helius: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
    jupiter: 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED';
    lastTickIso: string | null;
    pendingReconciliations: number;
    /** Fee wallet SOL balance (fees are paid in SOL); null until sampled. */
    feeSolBalance: string | null;
    feeSolUsdMicro: string | null;
    /** Wallet USDC balance (base units) at the last sample; null until read. */
    walletUsdcBase: string | null;
    walletUsdcUsdMicro: string | null;
  };
  fictional: boolean;
}

type Listener = (state: DashboardState) => void;

export class StateStore {
  private state: DashboardState | null = null;
  private listeners = new Set<Listener>();
  private version = 0;

  get(): DashboardState | null {
    return this.state;
  }

  publish(state: DashboardState): void {
    this.version++;
    this.state = { ...state, version: this.version };
    for (const l of this.listeners) {
      try {
        l(this.state);
      } catch {
        /* listener errors must not break the worker */
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** SSE payload wrapper: clients resync from `state`; `demo-tick` carries replay timing. */
export type SseEvent = { event: 'state'; data: DashboardState } | { event: 'heartbeat'; data: { t: string } };
