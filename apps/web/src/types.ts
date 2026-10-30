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
      awaitingZcode: boolean;
    }>;
  };
  handoff: null | {
    phase: 'FIRED' | 'WAITING_FOR_ZCODE' | 'PAUSED_FOR_FRESH_RESEARCH';
    fromHandle: string;
    fromRank: number | null;
    fromPnlText: string | null;
    /** Why the outgoing trader was fired (rank / rotation / stall / idle). */
    fromReason: string | null;
    toHandle: string | null;
    toRank: number | null;
    atIso: string;
    demo: boolean;
  };
  /** The fired → paused → research → auto-hire cycle, for the hire/fire panel. */
  hiring: {
    stage:
      | 'IDLE_COUNTDOWN'
      | 'FIRED'
      | 'RESEARCH_REQUESTED'
      | 'RESEARCH_RUNNING'
      | 'POOL_STALE'
      | 'ORDERING_READY'
      | 'HIRED'
      | 'IDLE';
    stageSince: string | null;
    pausedForResearch: boolean;
    reason: string | null;
    firedAt: string | null;
    latestScanAt: string | null;
    recommendationAt: string | null;
    researchRequested: boolean;
    researchDispatched: boolean;
    idleFireAtIso: string | null;
    autoResume: true;
  };
  recommendation: {
    status: string;
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
