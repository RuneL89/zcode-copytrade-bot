import type { AppState, DashboardBadge } from '@zcode-bot/core';

/** One watched wallet's row in the D4 watch-list panel. */
export interface WatchlistRow {
  candidateId: string;
  handle: string;
  status: 'watching' | 'cooling' | 'promoted' | 'archived';
  profileUrl: string | null;
  /** Newest funded buy on the watch record (the promotion recency clock). */
  lastFundedBuyAt: string | null;
  fundedBuys24h: number;
  fundedSells24h: number;
  /** Closed shadow trades (the K sample). */
  closedTrades: number;
  /** Net of the closed shadow trades, micro-USD. */
  netShadowPnlUsdMicro: string;
  /** Notional of the open pretend positions, micro-USD. */
  openNotionalUsdMicro: string;
  /** Open notional already at/over the age ceiling, awaiting a quote to close. */
  ceilingExposureUsdMicro: string;
  /** Why promotion is blocked right now, or null when it is not. */
  blockedReason: string | null;
  /** Where these numbers come from and how fresh they are. */
  source: 'SHADOW_LEDGER';
  lastEventAt: string | null;
}

/** The five pipeline stages (plan 07); the return lane is exits → watch. */
export type PipelineStage = 'discovery' | 'pool' | 'watch' | 'roster' | 'exits';

/** One stage-to-stage transition over the last 24h (thickness = volume). */
export interface PipelineEdge {
  from: PipelineStage;
  to: PipelineStage;
  count24h: number;
}

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
    /** The roster chair this position belongs to (plan 05 grouping). */
    leaderHandle: string | null;
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
    /** Chairs the pipeline's roster grid renders (ROSTER_SIZE). */
    rosterSize: number;
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
    }>;
  };
  /**
   * The roster (D4/plan 05): up to ROSTER_SIZE leaders sharing one budget pool.
   * `activeTrader` above is `roster[0]` for one release; plan 06 removes it.
   */
  roster: Array<{
    activationId: string;
    candidateId: string;
    handle: string;
    avatarUrl: string | null;
    status: string;
    realizedPnlUsdMicro: string;
    unrealizedPnlUsdMicro: string;
    openPositions: number;
    lastSix: Array<'W' | 'L' | 'B'>;
    streak: number;
    fireAfter: number;
    sinceIso: string;
  }>;
  /**
   * Watch list (D4): the wallets under observation and their shadow-ledger
   * record — the evidence promotion reads. Every number carries its source and
   * freshness; the fomo PnL mark never appears here as a gate.
   */
  watchlist: {
    /** Wallets currently `watching`. */
    size: number;
    /** Configured watch-list cap. */
    cap: number;
    /** Wallets promoted and waiting for a chair. */
    bench: number;
    /** Configured bench target (the D5 discovery trigger). */
    benchTarget: number;
    /** Why the next discovery run will (or will not) happen. */
    nextDiscoveryReason: string;
    rows: WatchlistRow[];
  };
  /**
   * The pipeline spine (plan 07): five stages, their 24h transitions and the
   * roster seats. Every count is DB-derived here; the dashboard renders them
   * verbatim and never derives its own.
   */
  pipeline: {
    asOf: string;
    discovery: {
      lastSyncAt: string | null;
      newHandles24h: number;
      creditsRemaining: number | null;
      sources: string[];
    };
    pool: { total: number; withWallet: number; fundedBuyers24h: number };
    watch: { watching: number; cooling: number; promotable: number; benchTarget: number };
    roster: Array<{
      activationId: string;
      candidateId: string;
      handle: string;
      status: 'BUYING' | 'SELLING' | 'IDLE' | 'RECONCILING';
      realizedPnlUsdMicro: string;
      unrealizedPnlUsdMicro: string;
      openPositions: number;
      /** Newest observed leader signal (ISO), or null when none was seen. */
      lastSignalAt: string | null;
    }>;
    exits: {
      fired24h: number;
      replacements24h: number;
      /** The fired lane: the last five firings with their replacement status. */
      recent: Array<{
        candidateId: string;
        handle: string;
        reason: string;
        firedAt: string;
        /** Handle of the hire that took the freed chair, or null while empty. */
        replacedBy: string | null;
      }>;
    };
    edges: PipelineEdge[];
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
