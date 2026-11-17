import type { DashboardState } from '../types';
import { ageLabel, humanReason, pct, signedUsdFromMicro, usdFromMicro } from './format';

export type RiskValue = number | string | boolean;
export type RiskMap = Record<string, RiskValue>;

export interface SettingsView {
  mode: string;
  armed: boolean;
  risk: RiskMap;
  paperAssumptions?: { slippageBps: number; feeBps: number; note: string };
  providers: {
    heliusConfigured: boolean;
    jupiter: { baseUrl: string; keyConfigured: boolean };
    telegramConfigured: boolean;
    fomoWebConfigured: boolean;
    fomoApiConfigured: boolean;
    fomoApiBaseUrl: string;
  };
  wallet: { exists: boolean; publicKey: string | null };
  readiness?: { ready: boolean; items: Array<{ id: string; ok: boolean; label: string; detail: string }> };
  control: { newEntriesPaused: boolean; emergencyStopped: boolean; pausedReason?: string | null };
  hiring?: { mode: 'auto' | 'agent'; hiresToday: number };
  liveAckString?: string;
}

export interface CreditsView {
  dayTotal: number;
  month: number;
  level: 'green' | 'amber' | 'red' | 'roster-only' | 'exits-only';
  byPath: Record<string, number>;
  hardCap: number;
  monthCeiling: number;
  freePlan: number;
  paths: Record<string, { capPerDay: number; expectedPerDay: number; exempt: boolean }>;
  monthCaps: { amber: number; red: number; rosterOnly: number; exitsOnly: number };
  admin: string;
  adminDetail: string | null;
  reported: unknown;
}

export interface AuditEvent {
  id: number;
  category: string;
  message: string;
  dataJson?: string | null;
  createdAt: string;
}

export interface CandidateRejectionRow {
  id: number;
  candidateId: string;
  handle: string;
  reason: string;
  detail: string | null;
  createdAt: string;
}

export interface RejectionsView {
  rejections: Array<Record<string, unknown>>;
  candidateRejections?: CandidateRejectionRow[];
}

export interface DropRow {
  id: string;
  at: string;
  handle: string | null;
  stage: string;
  reason: string;
  detail: string | null;
}

export interface FeedItem {
  id: string;
  at: string;
  type: string;
  text: string;
}

export interface SeatView {
  seatIndex: number;
  activationId: string;
  candidateId: string;
  handle: string;
  realizedUsdMicro: bigint;
  unrealizedUsdMicro: bigint;
  totalUsdMicro: bigint;
  openPositions: number;
  streak: number;
  fireAfter: number;
  status: string;
  idleFireHoursLeft: number | null;
  lastSignalAt: string | null;
  sinceIso: string;
  series: bigint[];
  replaces: string | null;
}

export interface PositionView {
  positionId: string;
  symbol: string;
  mintShort: string;
  leaderHandle: string;
  status: string;
  copyUsdMicro: bigint;
  unrealizedUsdMicro: bigint | null;
  unrealizedPct: number | null;
  markAgeSeconds: number | null;
  openedIso: string;
  stopBps: number;
  trailArmBps: number;
  trailDistanceBps: number;
  takeProfitBps: number;
  maxHoldHours: number;
  timeLeftMs: number;
  planSource: 'copytrader' | 'code';
  plan: { stopLossBps?: number; trailDistanceBps?: number; maxHoldHours?: number } | null;
}

const MICRO = 1_000_000n;

export function numberRisk(risk: RiskMap, key: string, fallback: number): number {
  const value = risk[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function boolRisk(risk: RiskMap, key: string, fallback: boolean): boolean {
  const value = risk[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function realizedToday(state: DashboardState): bigint {
  const day = new Date().toISOString().slice(0, 10);
  return state.closes
    .filter((close) => close.t.slice(0, 10) === day)
    .reduce((acc, close) => acc + BigInt(close.pnlUsdMicro), 0n);
}

export function unrealizedTotal(state: DashboardState): bigint {
  return state.positions.reduce((acc, p) => acc + BigInt(p.unrealizedPnlUsdMicro ?? '0'), 0n);
}

export function openCost(state: DashboardState): bigint {
  return state.positions.reduce((acc, p) => acc + BigInt(p.copyUsdMicro), 0n);
}

export function headerModel(state: DashboardState, settings: SettingsView | null) {
  const mode = state.mode.toUpperCase();
  const modeLabel = state.control.emergencyStopped
    ? 'STOPPED'
    : state.control.newEntriesPaused
      ? `${mode} · PAUSED`
      : mode;
  const modeClass = state.control.emergencyStopped
    ? 'stopped'
    : state.control.newEntriesPaused
      ? 'paused'
      : state.mode === 'live'
        ? 'live'
        : 'paper';
  const realized = realizedToday(state);
  const unrealized = unrealizedTotal(state);
  const today = realized + unrealized;
  const cost = openCost(state);
  const unrealPct = cost > 0n ? Number((unrealized * 10_000n) / cost) / 100 : null;
  const deployed = BigInt(state.counters.deployedUsdMicro);
  const capital = BigInt(state.counters.capitalUsdMicro);
  const maxPct = BigInt(state.counters.maxDeployedPct || 80);
  const room = capital > 0n ? (capital * maxPct) / 100n - deployed : 0n;
  const usdcFree = state.health.walletUsdcUsdMicro ?? state.counters.cashUsdMicro;
  const solBalance = state.health.feeSolBalance;
  // Equity is account value: cash plus the live mark of every open position.
  // `currentUsdMicro` is the realized book (start + closed PnL) and is kept for
  // the realized-equity chart; the header KPI uses the mark-to-market figure.
  const equityStart = BigInt(state.equity.startUsdMicro);
  const equityNow = BigInt(state.equity.rollingUsdMicro);
  return {
    modeLabel,
    modeClass,
    equity: equityNow,
    equityPct: Number(((equityNow - equityStart) * 10_000n) / (equityStart || 1n)) / 100,
    today,
    realized,
    unrealized,
    unrealPct,
    openCount: state.counters.openPositions,
    usdcFree: BigInt(usdcFree),
    deployed,
    room: room > 0n ? room : 0n,
    solBalance,
    solUsdMicro: state.counters.solUsdMicro,
    rentUsdMicro: state.counters.rentUsdMicro,
    rentLamports: state.counters.rentLamports,
    paused: state.control.newEntriesPaused,
    stopped: state.control.emergencyStopped,
  };
}

export function funnelModel(state: DashboardState) {
  const pool = state.pipeline.pool;
  const watch = state.pipeline.watch;
  // The watch rows are the rendered identities; their statuses are the same
  // source the dots and drawers read. Pipeline counters can lag a seeded row
  // by one tick, so prefer the row counts when they are present.
  const watchingRows = state.watchlist.rows.filter((row) => row.status === 'watching').length;
  const benchRows = state.watchlist.rows.filter((row) => row.status === 'bench').length;
  const stages = [
    {
      id: 'discovered',
      name: 'Discovered',
      owner: 'code',
      count: pool.total,
      today: state.pipeline.discovery.newHandles24h,
      description: 'Fomo board + alerts, deduped',
      retired: false,
    },
    {
      id: 'screening',
      name: 'Screening',
      owner: 'code',
      count: pool.withWallet,
      today: null as number | null,
      description: 'wallet resolved · hard filters',
      retired: false,
    },
    {
      id: 'shadow',
      name: 'Shadow',
      owner: 'code',
      count: watchingRows,
      today: state.watchlist.size,
      description: 'paper copies at real quotes',
      retired: false,
    },
    {
      id: 'review',
      name: 'Agent review',
      owner: 'agent',
      count: 0,
      today: null as number | null,
      description: 'retired (D6) — no agent review runs',
      retired: true,
    },
    {
      id: 'bench',
      name: 'Bench',
      owner: 'code',
      count: benchRows,
      today: null as number | null,
      description: 'promotion queue, best shadow net first',
      retired: false,
    },
  ];
  return {
    stages,
    hired: state.roster.length,
    rosterSize: state.counters.rosterSize ?? 5,
    discoveredToday: state.pipeline.discovery.newHandles24h,
    hiresToday:
      state.pipeline.hiresToday ??
      state.roster.filter((r) => r.sinceIso.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
    benchTarget: watch.benchTarget,
  };
}

export function dropsModel(
  state: DashboardState,
  candidateRejections: CandidateRejectionRow[] | undefined,
): DropRow[] {
  const rows: DropRow[] = [];
  for (const rejection of candidateRejections ?? []) {
    rows.push({
      id: `rej-${rejection.id}`,
      at: rejection.createdAt,
      handle: rejection.handle,
      stage: 'hire gate',
      reason: humanReason(rejection.reason),
      detail: rejection.detail,
    });
  }
  for (const row of state.watchlist.rows) {
    if (row.status !== 'archived' && row.status !== 'cooling') continue;
    const at = row.lastEventAt ?? row.lastFundedBuyAt;
    if (!at) continue;
    rows.push({
      id: `watch-${row.candidateId}`,
      at,
      handle: row.handle,
      stage: 'shadow',
      reason: humanReason(row.reason ?? row.status),
      detail: null,
    });
  }
  for (const firing of state.pipeline.exits.recent) {
    rows.push({
      id: `fire-${firing.candidateId}-${firing.firedAt}`,
      at: firing.firedAt,
      handle: firing.handle,
      stage: 'hired',
      reason: humanReason(firing.reason),
      detail: firing.replacedBy ? `replaced by ${firing.replacedBy}` : 'seat left empty',
    });
  }
  rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return rows.slice(0, 8);
}

export function seatsModel(state: DashboardState): Array<SeatView | null> {
  const rosterSize = state.counters.rosterSize ?? 5;
  const byActivation = new Map(state.pipeline.roster.map((seat) => [seat.activationId, seat]));
  const seats: Array<SeatView | null> = Array.from({ length: rosterSize }, () => null);
  state.roster.forEach((seat, index) => {
    const pipelineSeat = byActivation.get(seat.activationId);
    const realized = BigInt(seat.realizedPnlUsdMicro);
    const unrealized = BigInt(seat.unrealizedPnlUsdMicro);
    const replacement = state.pipeline.exits.recent.find((fire) => fire.replacedBy === seat.handle);
    seats[index] = {
      seatIndex: index + 1,
      activationId: seat.activationId,
      candidateId: seat.candidateId,
      handle: seat.handle,
      realizedUsdMicro: realized,
      unrealizedUsdMicro: unrealized,
      totalUsdMicro: realized + unrealized,
      openPositions: seat.openPositions,
      streak: seat.streak,
      fireAfter: seat.fireAfter,
      status: pipelineSeat?.status ?? 'IDLE',
      idleFireHoursLeft: pipelineSeat?.idleFireHoursLeft ?? null,
      lastSignalAt: pipelineSeat?.lastSignalAt ?? null,
      sinceIso: seat.sinceIso,
      series: (seat.series ?? []).map((value) => BigInt(value)),
      replaces: replacement && replacement.replacedBy === seat.handle ? replacement.handle : null,
    };
  });
  return seats;
}

export function positionsModel(
  state: DashboardState,
  settings: SettingsView | null,
  nowMs = Date.now(),
): PositionView[] {
  const risk = settings?.risk ?? {};
  const stopDefault = numberRisk(risk, 'STOP_LOSS_BPS', 2500);
  const trailArm = numberRisk(risk, 'TRAIL_ARM_BPS', 1500);
  const trailDist = numberRisk(risk, 'TRAIL_DISTANCE_BPS', 1000);
  const tp = numberRisk(risk, 'PARTIAL_TP_BPS', 4000);
  const maxHoldDefault = numberRisk(risk, 'MAX_POSITION_AGE_HOURS', 5);
  return state.positions.map((position) => {
    const copy = BigInt(position.copyUsdMicro);
    const unrealized =
      position.unrealizedPnlUsdMicro === null ? null : BigInt(position.unrealizedPnlUsdMicro);
    const plan = position.exitPlan ?? null;
    const maxHold = plan?.maxHoldHours ?? maxHoldDefault;
    const timeLeftMs = Date.parse(position.openedIso) + maxHold * 3_600_000 - nowMs;
    return {
      positionId: position.positionId,
      symbol: position.symbol ?? position.mintShort,
      mintShort: position.mintShort,
      leaderHandle: position.leaderHandle ?? '—',
      status: position.status,
      copyUsdMicro: copy,
      unrealizedUsdMicro: unrealized,
      unrealizedPct: unrealized !== null && copy > 0n ? Number((unrealized * 10_000n) / copy) / 100 : null,
      markAgeSeconds: position.markAgeSeconds,
      openedIso: position.openedIso,
      stopBps: plan?.stopLossBps ?? stopDefault,
      trailArmBps: trailArm,
      trailDistanceBps: plan?.trailDistanceBps ?? trailDist,
      takeProfitBps: tp,
      maxHoldHours: maxHold,
      timeLeftMs,
      planSource: plan ? 'copytrader' : 'code',
      plan,
    };
  });
}

/**
 * What the "time left" cell means once the max-hold clock is spent. A green
 * position past max hold is due for the sell-on-green exit, not riding the
 * losing-position grace window; calling both "grace" mislabelled wins.
 */
export function positionTimeLeftPhase(
  position: Pick<PositionView, 'timeLeftMs' | 'unrealizedUsdMicro'>,
): 'hold' | 'exit_due' | 'grace' {
  if (position.timeLeftMs >= 0) return 'hold';
  return position.unrealizedUsdMicro !== null && position.unrealizedUsdMicro > 0n ? 'exit_due' : 'grace';
}

export function positionTimeLeftLabel(
  position: Pick<PositionView, 'timeLeftMs' | 'unrealizedUsdMicro'>,
  formatRemaining: (ms: number) => string = (ms) => `${Math.round(ms / 60_000)}m`,
): string {
  const phase = positionTimeLeftPhase(position);
  if (phase === 'hold') return formatRemaining(position.timeLeftMs);
  return phase === 'exit_due' ? 'exit due' : 'grace';
}

export function feedModel(events: AuditEvent[]): FeedItem[] {
  // Provider poll failures repeat every tick and would drown the desk feed.
  // The header's health dots and /api/health/providers carry that signal.
  const noisy =
    /^(poll failed for activation|activation .* tick failed|roster tick failed|watch tick failed|stream swap failed|gap-fill failed)/i;
  return events
    .filter((event) => !noisy.test(event.message))
    .slice(0, 18)
    .map((event) => {
      const text = event.message;
      const lower = `${event.category} ${text}`.toLowerCase();
      let type = 'info';
      if (lower.includes('copied entry filled')) type = 'buy';
      else if (lower.includes('shadow opened')) type = 'pass';
      else if (lower.includes('shadow closed') || lower.includes('win')) type = 'win';
      else if (lower.includes('ceiling closed') || lower.includes('code exit')) type = 'loss';
      else if (lower.includes('fired')) type = 'fire';
      else if (lower.includes('hired') || lower.includes('promoted')) type = 'hire';
      else if (lower.includes('rejected') || lower.includes('dropped') || lower.includes('archived'))
        type = 'drop';
      else if (lower.includes('admitted')) type = 'bench';
      else if (lower.includes('discovery run')) type = 'spawn';
      else if (lower.includes('watch list enabled') || lower.includes('runtime starting')) type = 'info';
      else if (event.category === 'watch') type = 'pass';
      else if (event.category === 'monitor') type = 'info';
      else if (event.category === 'firing') type = 'fire';
      else if (event.category === 'roster') type = 'hire';
      else if (event.category === 'settings' || event.category === 'control') type = 'you';
      else if (event.category === 'agent') type = 'agent';
      return { id: String(event.id), at: event.createdAt, type, text };
    });
}

export function successionModel(state: DashboardState) {
  return state.pipeline.exits.recent.map((fire) => ({
    handle: fire.handle,
    reason: fire.reason,
    firedAt: fire.firedAt,
    replacedBy: fire.replacedBy,
  }));
}

export function creditsModel(
  state: DashboardState,
  credits: CreditsView | null,
  settings: SettingsView | null,
) {
  const month = credits?.month ?? 0;
  const now = new Date(state.generatedAt || Date.now());
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = Math.max(1, now.getDate());
  const projection = Math.round((month / dayOfMonth) * daysInMonth);
  const reported = (credits?.reported ?? null) as { creditsUsed?: number; at?: string } | null;
  const reportedUsed = typeof reported?.creditsUsed === 'number' ? reported.creditsUsed : null;
  const paths = credits?.paths ?? {};
  const pathRows = Object.entries(paths)
    .map(([id, budget]) => ({
      id,
      used: credits?.byPath?.[id] ?? 0,
      cap: budget.capPerDay,
      expected: budget.expectedPerDay,
      exempt: budget.exempt,
    }))
    .sort((a, b) => b.used - a.used);
  const discovery = state.pipeline.discovery;
  return {
    month,
    dayTotal: credits?.dayTotal ?? 0,
    level: credits?.level ?? 'green',
    freePlan: credits?.freePlan ?? 1_000_000,
    dayCap: credits?.hardCap ?? 13_600,
    monthCaps: credits?.monthCaps ?? {
      amber: 450_000,
      red: 550_000,
      rosterOnly: 600_000,
      exitsOnly: 900_000,
    },
    projection,
    dayOfMonth,
    daysInMonth,
    admin: credits?.admin ?? 'unknown',
    adminDetail: credits?.adminDetail ?? null,
    reportedUsed,
    reportedAt: reported?.at ?? null,
    driftPct: reportedUsed !== null && month > 0 ? ((reportedUsed - month) / month) * 100 : null,
    pathRows,
    fomo: {
      configured: Boolean(settings?.providers.fomoApiConfigured),
      baseUrl: settings?.providers.fomoApiBaseUrl ?? '—',
      lastSyncAt: discovery.lastSyncAt,
      creditsRemaining: discovery.creditsRemaining,
      sources: discovery.sources,
    },
    jupiter: {
      health: state.health.jupiter,
      keyConfigured: Boolean(settings?.providers.jupiter.keyConfigured),
      baseUrl: settings?.providers.jupiter.baseUrl ?? '—',
    },
  };
}

export { ageLabel, pct, signedUsdFromMicro, usdFromMicro };
