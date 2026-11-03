export interface DashboardState {
  version: number;
  generatedAt: string;
  mode: 'demo' | 'paper' | 'live';
  armed: boolean;
  badges: string[];
  appState: string;
  control: { newEntriesPaused: boolean; emergencyStopped: boolean; pausedReason: string | null };
  equity: {
    currentUsdMicro: string;
    startUsdMicro: string;
    changeUsdMicro: string;
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
    displayedPnl7dUsdMicro: string | null;
    copyScale: string;
    lastSix: Array<'W' | 'L' | 'B'>;
    streak: number;
    fireAfter: number;
    realizedPnlUsdMicro: string;
    unrealizedPnlUsdMicro: string;
    boughtCount: number;
    boughtUsdMicro: string;
    soldCount: number;
    soldUsdMicro: string | null;
    firedCount: number;
    sinceIso: string;
    source: string;
  };
  closes: Array<{ id: string; t: string; pnlUsdMicro: string; traderHandle: string; symbol: string | null }>;
  positions: Array<{
    positionId: string;
    leaderHandle: string | null;
    mintShort: string;
    symbol: string | null;
    status: string;
    copyUsdMicro: string;
    feesUsdMicro: string;
    /** Real network fee of the entry transaction (lamports), from the chain. */
    entryFeeLamports: number | null;
    /** Rent locked into token accounts opened by the entry transaction. */
    entryRentLamports: number | null;
    realizedPnlUsdMicro: string;
    markUsdMicro: string | null;
    unrealizedPnlUsdMicro: string | null;
    markAgeSeconds: number | null;
    openedIso: string;
    /** The individual copy buys still open inside this position, newest first. */
    entries: Array<{
      intentId: string;
      atIso: string;
      /** USD spent on the open part of the buy. */
      usdMicro: string;
      /** The buy's original size; larger after a partial exit. */
      inputUsdMicro: string;
      tokenBase: string;
      unrealizedPnlUsdMicro: string | null;
      txSignature: string | null;
    }>;
  }>;
  activity: Array<{
    id: string;
    tIso: string;
    kind: 'copied' | 'exit' | 'skipped' | 'leader_sell';
    tokenShort: string | null;
    leaderUsdMicro: string | null;
    leaderSolBase: string | null;
    copyUsdMicro: string | null;
    realizedPnlUsdMicro: string | null;
    reasonChip: string | null;
  }>;
  activityNoiseCount: number;
  counters: {
    copiedToday: number;
    skippedToday: number;
    openPositions: number;
    openExposureUsdMicro: string;
    capitalUsdMicro: string;
    cashUsdMicro: string;
    deployedUsdMicro: string;
    deployedPct: number;
    maxDeployedPct: number;
    /** Configured roster size (chairs). */
    rosterSize?: number;
    maxPositionAgeHours: number;
    positionGraceHours: number;
    idleFireHoursLeft: number | null;
    /** Real network fees paid (chain-priced). Null until the ledger has scanned. */
    feesPaidUsdMicro: string | null;
    feesLamports: number | null;
    /** Rent locked in the wallet's SPL token accounts. */
    rentUsdMicro: string | null;
    rentLamports: number | null;
    openTokenAccounts: number | null;
    solUsdMicro: string | null;
    ledgerTxs: number | null;
  };
  stats: { copiedTrades: number; winners: number; winRatePct: number | null };
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
  /** The roster (D4/plan 05): up to ROSTER_SIZE leaders sharing one pool. */
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
  /** D4 watch list: the wallets under observation and their shadow record. */
  watchlist: {
    size: number;
    cap: number;
    bench: number;
    benchTarget: number;
    nextDiscoveryReason: string;
    rows: Array<{
      candidateId: string;
      handle: string;
      status: 'watching' | 'cooling' | 'bench' | 'hired' | 'archived';
      profileUrl: string | null;
      lastFundedBuyAt: string | null;
      fundedBuys24h: number;
      fundedSells24h: number;
      closedTrades: number;
      netShadowPnlUsdMicro: string;
      openNotionalUsdMicro: string;
      ceilingExposureUsdMicro: string;
      blockedReason: string | null;
      source: 'SHADOW_LEDGER';
      lastEventAt: string | null;
    }>;
  };
  /**
   * The pipeline spine (plan 07): five stages, their 24h transitions and the
   * roster seats — rendered verbatim from the server payload.
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
      lastSignalAt: string | null;
      /** Hours until the idle fire; null while the seat holds a position. */
      idleFireHoursLeft: number | null;
    }>;
    exits: {
      fired24h: number;
      replacements24h: number;
      recent: Array<{
        candidateId: string;
        handle: string;
        reason: string;
        firedAt: string;
        replacedBy: string | null;
      }>;
    };
    edges: Array<{ from: string; to: string; count24h: number }>;
  };
  /** Worker/liveness snapshot for the health strip. */
  health: {
    workerRunning: boolean;
    helius: string;
    jupiter: string;
    lastTickIso: string | null;
    pendingReconciliations: number;
    feeSolBalance: string | null;
    feeSolUsdMicro: string | null;
    walletUsdcBase: string | null;
    walletUsdcUsdMicro: string | null;
  };
  fictional: boolean;
}

export function usd(micro: string | null | undefined, decimals = 2): string {
  if (micro === null || micro === undefined) return '—';
  const n = BigInt(micro);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1000000n;
  const frac = (abs % 1000000n).toString().padStart(6, '0').slice(0, decimals);
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

export function signedUsd(micro: string | null | undefined, decimals = 2): string {
  if (micro === null || micro === undefined) return '—';
  const n = BigInt(micro);
  return `${n > 0n ? '+' : ''}${usd(micro, decimals)}`;
}

export function splitEquity(micro: string): { sign: string; whole: string; decimals: string } {
  const n = BigInt(micro);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return {
    sign: neg ? '-' : '',
    whole: (abs / 1000000n).toLocaleString('en-US'),
    decimals: (abs % 1000000n).toString().padStart(6, '0').slice(0, 2),
  };
}

export function clockFromSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

/** Compact relative age ("40s", "3m", "2h 15m", "1d"). */
export function timeAgo(iso: string, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Format SOL base units (9 decimals) as a short "◎1.5"-style amount. */
export function solFromBase(base: string): string {
  const n = BigInt(base);
  const whole = n / 1_000_000_000n;
  const frac = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '').slice(0, 2);
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Compact on-chain direction pair ("6b · 3s"). Null counts are unknown —
 * "6b" when only sells are unknown, "—" when neither side was classified.
 */
export function dirPair(buys: number | null, sells: number | null): string {
  if (buys === null && sells === null) return '—';
  const b = `${buys ?? '?'}b`;
  const s = `${sells ?? '?'}s`;
  return `${b} · ${s}`;
}

// ---- Operations console contracts -------------------------------------------

export interface OpRun {
  runId: number;
  opId: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'timeout';
  exitCode: number | null;
  summary: string | null;
  lines: string[];
}

export interface OpsSystem {
  nodeVersion: string;
  mode: string;
  port: number;
  uptimeSeconds: number;
  workerRunning: boolean;
  lockHeld: boolean;
  dbBytes: number;
  walletExists: boolean;
  walletPublicKey: string | null;
  dataDir: string;
  backups: string[];
}

export interface OpDefinition {
  id: string;
  label: string;
  group: 'setup' | 'server' | 'testing' | 'maintenance' | 'wallet';
  description: string;
  danger: 'normal' | 'confirm' | 'destructive';
  confirmWord?: string;
}
