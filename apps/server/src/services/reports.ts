import type { DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { Notifier } from '@zcode-bot/providers';
import type { DashboardState } from './state.js';

/**
 * Push reports to the operator's Telegram (opt-in via TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID; no-op when unset). Two streams only, per operator choice:
 *  - anomalies: audit rows that indicate something needs attention
 *    (rejected recommendations, adapter failures, reconciliation cases)
 *  - one compact desk summary (local 09:00; Mondays it is the weekly, which
 *    carries the same 24h figures plus the 7-day view, so a day never produces
 *    two messages).
 * The notifier lives server-side by design: the research subagent and the MCP
 * process never see notification credentials.
 */

export interface AuditLike {
  id: number;
  category: string;
  message: string;
  created_at?: string | null;
}

const ANOMALY_CATEGORIES = new Set(['recommendation', 'fomo-web', 'dawn-lookup', 'reconciliation', 'risk']);
const ANOMALY_PATTERN =
  /rejected|failed|unreadable|fail closed|needs-login|session missing|expired|PAUSED_NO_TRADER|LEADER_STALLED|LOW_ACTIVITY/i;

/** An open loss below this is noise, not something the operator must look at. */
const ATTENTION_LOSS_FLOOR_USD_MICRO = 1_000_000n; // $1.00

/** Pure selection: audit rows newer than lastSeenId that look like anomalies. */
export function selectAnomalies(rows: AuditLike[], lastSeenId: number): AuditLike[] {
  return rows.filter(
    (r) => r.id > lastSeenId && ANOMALY_CATEGORIES.has(r.category) && ANOMALY_PATTERN.test(r.message),
  );
}

/** Micro-USD bigint to a compact USD string ("$93.60", "$1,234.50"). */
export function formatMicroUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const dollars = Number(abs / 1_000_000n) + Number(abs % 1_000_000n) / 1e6;
  const formatted = dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return negative ? `-$${formatted}` : `$${formatted}`;
}

/** Micro-USD bigint to a signed compact USD string ("+$14.81", "-$35.60"). */
export function formatSignedMicroUsd(micro: bigint): string {
  if (micro > 0n) return `+${formatMicroUsd(micro)}`;
  return formatMicroUsd(micro); // negative already carries its minus; zero stays "$0.00"
}

/** Milliseconds to a compact "1h 20m" / "18m" label. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Realized lots in a window: the total plus its win/loss/flat split. */
export interface ClosedRecord {
  total: number;
  wins: number;
  losses: number;
  /** Lots that closed exactly flat; shown only when non-zero. */
  flat: number;
  sumUsdMicro: bigint;
}

/** One chair's record for the weekly message. */
export interface ChairRecord {
  handle: string;
  realizedUsdMicro: bigint;
  wins: number;
  losses: number;
  openPositions: number;
}

/** Everything the message needs; assembled by the service, formatted purely. */
export interface ReportFacts {
  mode: string;
  armed: boolean;
  appState: string;
  /** The last 24h, always present (the weekly carries it too). */
  realizedUsdMicro: bigint;
  closed: ClosedRecord;
  /** Confirmed orders (entries + exits) placed in the window. */
  orders: number;
  equityUsdMicro: bigint;
  equityChangeUsdMicro: bigint;
  cashUsdMicro: bigint;
  deployedPct: number;
  maxDeployedPct: number;
  openPositions: number;
  openUnrealizedUsdMicro: bigint;
  /** Positions whose mark is missing/stale — their PnL is not in the sum. */
  marksPending: number;
  /** Milliseconds until the next day-trader time exit; null with no positions. */
  nextTimeExitMs: number | null;
  /** True when the next exit is already past max age (riding its grace window). */
  nextExitInGrace: boolean;
  chairs: number;
  chairsHolding: number;
  benchDepth: number;
  benchTop: { handle: string; netUsdMicro: bigint } | null;
  /** The largest open loss, when there is one. */
  worstPosition: { symbol: string; pnlUsdMicro: bigint } | null;
  /** A flat seat whose idle fire is close enough to matter. */
  idleSoon: { handle: string; hoursLeft: number } | null;
  hired: string[];
  fired: Array<{ handle: string; reason: string }>;
  walletUsdcUsdMicro: bigint | null;
  feeSolBalance: string | null;
  feesPaidUsdMicro: bigint | null;
  pendingReconciliations: number;
  /** Weekly only: the 7-day view. */
  weekly: {
    realizedUsdMicro: bigint;
    closed: ClosedRecord;
    orders: number;
    chairs: ChairRecord[];
  } | null;
}

/** Handles list capped so a busy day cannot flood the message. */
/**
 * A digest entry stays readable on a busy week: a few names when the list is
 * short, otherwise the count with the newest few (never a wall of handles).
 */
function digestEntry(verb: string, names: string[], cap = 3): string {
  if (names.length <= cap) return `${verb} ${names.join(', ')}`;
  return `${verb} ${names.length} (latest ${names.slice(0, cap).join(', ')})`;
}

function closedLabel(c: ClosedRecord): string {
  const base = `${c.total} close${c.total === 1 ? '' : 's'} (${c.wins}W/${c.losses}L`;
  return c.flat > 0 ? `${base}/${c.flat} flat)` : `${base})`;
}

/** A firing reason is prose; the message wants the gist. */
export function shortReason(reason: string): string {
  const r = reason.toLowerCase();
  if (/losing units|loss streak/.test(r)) return 'loss streak';
  if (/^idle/.test(r)) return 'idle';
  if (/stall/.test(r)) return 'stalled';
  if (/manual fire/.test(r)) return 'manual';
  if (/left the board|absent from the top/.test(r)) return 'left the board';
  return reason.length > 28 ? `${reason.slice(0, 27)}…` : reason;
}

/**
 * The desk summary. Compact by operator choice: aggregates only, one line per
 * concern. A missing figure is never rendered as a zero — pending marks are
 * stated, and a line with nothing to say is omitted.
 */
export function reportText(facts: ReportFacts, window: 'daily' | 'weekly' = 'daily'): string {
  const weekly = window === 'weekly' && facts.weekly !== null;
  const lines: string[] = [];

  const state = [facts.mode, facts.armed ? 'armed' : 'disarmed'];
  if (facts.appState !== 'RUNNING') state.push(facts.appState);
  lines.push(`Copydesk${weekly ? ' weekly' : ''} · ${state.join(' · ')}`);

  if (weekly && facts.weekly) {
    lines.push(
      `7d realized: ${formatSignedMicroUsd(facts.weekly.realizedUsdMicro)} · ${closedLabel(
        facts.weekly.closed,
      )} · ${facts.weekly.orders} orders`,
    );
  }
  lines.push(
    `Realized 24h: ${formatSignedMicroUsd(facts.realizedUsdMicro)} · ${closedLabel(facts.closed)} · ${
      facts.orders
    } orders`,
  );
  lines.push(
    `Equity ${formatMicroUsd(facts.equityUsdMicro)} (${formatSignedMicroUsd(
      facts.equityChangeUsdMicro,
    )}) · cash ${formatMicroUsd(facts.cashUsdMicro)} · deployed ${facts.deployedPct}% of ${
      facts.maxDeployedPct
    }%`,
  );

  const allPending = facts.marksPending > 0 && facts.marksPending === facts.openPositions;
  const openParts = [
    `Open ${facts.openPositions}`,
    `unrealized ${allPending ? 'pending' : formatSignedMicroUsd(facts.openUnrealizedUsdMicro)}`,
  ];
  if (facts.nextTimeExitMs !== null) {
    openParts.push(
      facts.nextExitInGrace ? 'next exit in grace' : `next time exit ${formatDuration(facts.nextTimeExitMs)}`,
    );
  }
  if (facts.marksPending > 0 && !allPending) openParts.push(`marks pending ${facts.marksPending}`);
  lines.push(openParts.join(' · '));

  const chairParts = [
    `Chairs ${facts.chairs}${facts.chairsHolding > 0 ? ` (${facts.chairsHolding} holding)` : ''}`,
  ];
  chairParts.push(
    facts.benchTop
      ? `bench ${facts.benchDepth} ready · top ${facts.benchTop.handle} ${formatSignedMicroUsd(
          facts.benchTop.netUsdMicro,
        )}`
      : `bench ${facts.benchDepth} ready`,
  );
  lines.push(chairParts.join(' · '));

  const attention: string[] = [];
  // Only a loss worth the operator's attention is named: a rounding-level dip
  // is noise, and the open line already carries the net figure.
  if (facts.worstPosition && facts.worstPosition.pnlUsdMicro <= -ATTENTION_LOSS_FLOOR_USD_MICRO) {
    attention.push(
      `${facts.worstPosition.symbol} ${formatSignedMicroUsd(facts.worstPosition.pnlUsdMicro)} (biggest open)`,
    );
  }
  if (facts.idleSoon) {
    const h = facts.idleSoon.hoursLeft;
    attention.push(
      `@${facts.idleSoon.handle} idle ${h <= 0 ? 'fires now' : `fires in ${formatDuration(h * 3_600_000)}`}`,
    );
  }
  if (facts.pendingReconciliations > 0) {
    attention.push(`${facts.pendingReconciliations} reconciliation(s) open`);
  }
  if (attention.length > 0) lines.push(`Needs attention: ${attention.join(' · ')}`);

  const digest: string[] = [];
  if (facts.hired.length > 0) digest.push(digestEntry('hired', facts.hired));
  if (facts.fired.length > 0) {
    digest.push(
      digestEntry(
        'fired',
        facts.fired.map((f) => `${f.handle} (${shortReason(f.reason)})`),
        2,
      ),
    );
  }
  const windowLabel = weekly ? '7d' : '24h';
  if (digest.length > 0) lines.push(`${windowLabel}: ${digest.join(' · ')}`);

  // Health line: only what is actually known. The chain-side reads (wallet
  // USDC, fee SOL) can go unread when the provider rate-limits, and the report
  // says nothing rather than inventing a figure.
  const walletParts: string[] = [];
  if (facts.walletUsdcUsdMicro !== null) {
    walletParts.push(`Wallet ${formatMicroUsd(facts.walletUsdcUsdMicro)} free USDC`);
  }
  if (facts.feeSolBalance !== null) walletParts.push(`${facts.feeSolBalance} SOL for fees`);
  if (facts.feesPaidUsdMicro !== null) {
    walletParts.push(`fees paid ${formatMicroUsd(facts.feesPaidUsdMicro)}`);
  }
  if (walletParts.length > 0) lines.push(walletParts.join(' · '));

  if (weekly && facts.weekly && facts.weekly.chairs.length > 0) {
    lines.push('Chairs (7d realized · record · open):');
    for (const c of facts.weekly.chairs) {
      lines.push(
        `• ${c.handle}  ${formatSignedMicroUsd(c.realizedUsdMicro)} · ${c.wins}W/${c.losses}L · ${c.openPositions} open`,
      );
    }
  }

  return lines.join('\n');
}

/** Milliseconds until the next occurrence of a local wall-clock time. */
export function msUntilNextLocalTime(hour: number, minute: number, now = new Date()): number {
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/** Local weekday check, 0 = Sunday: Mondays send the weekly summary. */
export function isWeeklyDay(now = new Date()): boolean {
  return now.getDay() === 1;
}

export class ReportsService {
  private anomalyTimer: ReturnType<typeof setInterval> | null = null;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  private dailyRepeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: DbHandle,
    private notifier: Notifier,
    private mode: string,
    /** The dashboard state to describe (the runtime refreshes marks first). */
    private state: () => Promise<DashboardState>,
  ) {}

  start(): void {
    this.anomalyTimer = setInterval(() => void this.sweepAnomalies().catch(() => undefined), 10 * 60_000);
    const first = msUntilNextLocalTime(9, 0);
    this.dailyTimer = setTimeout(() => {
      void this.sendDailyReport();
      this.dailyRepeat = setInterval(
        () => void this.sendDailyReport().catch(() => undefined),
        24 * 60 * 60_000,
      );
    }, first);
  }

  stop(): void {
    if (this.anomalyTimer) clearInterval(this.anomalyTimer);
    if (this.dailyTimer) clearTimeout(this.dailyTimer);
    if (this.dailyRepeat) clearInterval(this.dailyRepeat);
    this.anomalyTimer = this.dailyTimer = this.dailyRepeat = null;
  }

  /** Push unseen anomaly audit rows; the high-water mark persists in kv. */
  async sweepAnomalies(): Promise<void> {
    const lastSeenId = Number(repo.kvGet(this.db.db, 'reports.lastAnomalyId') ?? '0');
    const rows = repo.listAudit(this.db.db, 200) as unknown as AuditLike[];
    const anomalies = selectAnomalies(rows, lastSeenId);
    if (anomalies.length === 0) return;
    const maxId = Math.max(...anomalies.map((a) => a.id));
    repo.kvSet(this.db.db, 'reports.lastAnomalyId', String(maxId));
    const body = anomalies
      .slice(0, 5)
      .map((a) => `• [${a.category}] ${a.message.slice(0, 120)}`)
      .join('\n');
    await this.notifier.notify(`⚠️ Copydesk anomalies\n${body}`);
  }

  /**
   * One summary per local day, pushed around 09:00. Mondays send the weekly
   * instead (it carries the same 24h figures plus the 7-day view), so a day
   * never produces two messages. A failed send is audited; the day is marked
   * regardless, so a Telegram outage cannot turn into a message storm.
   */
  async sendDailyReport(now = new Date()): Promise<void> {
    const today = now.toISOString().slice(0, 10);
    if (repo.kvGet(this.db.db, 'reports.lastDailyDate') === today) return;
    const window: 'daily' | 'weekly' = isWeeklyDay(now) ? 'weekly' : 'daily';
    const facts = this.collectFacts(await this.state(), window, now);
    const text = reportText(facts, window);
    repo.kvSet(this.db.db, 'reports.lastDailyDate', today);
    if (window === 'weekly') repo.kvSet(this.db.db, 'reports.lastWeeklyDate', today);
    try {
      await this.notifier.notify(text);
    } catch (e) {
      repo.audit(this.db.db, 'reports', `${window} report send failed: ${(e as Error).message}`, {});
    }
  }

  /** Assemble the message's inputs from the built state + the window's records. */
  collectFacts(state: DashboardState, window: 'daily' | 'weekly', now = new Date()): ReportFacts {
    const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const sinceWindow = new Date(
      now.getTime() - (window === 'weekly' ? 7 : 1) * 24 * 3_600_000,
    ).toISOString();

    const positions = state.positions;
    const marksPending = positions.filter((p) => p.markUsdMicro === null).length;
    const openUnrealized = positions.reduce((acc, p) => acc + BigInt(p.unrealizedPnlUsdMicro ?? '0'), 0n);

    // Next day-trader time exit among the positions we hold.
    const maxAgeMs = state.counters.maxPositionAgeHours * 3_600_000;
    const graceMs = state.counters.positionGraceHours * 3_600_000;
    let nextTimeExitMs: number | null = null;
    let nextExitInGrace = false;
    for (const p of positions) {
      const openedMs = Date.parse(p.openedIso);
      const deadline = openedMs + maxAgeMs;
      const left =
        deadline > now.getTime() ? deadline - now.getTime() : Math.max(0, deadline + graceMs - now.getTime());
      if (nextTimeExitMs === null || left < nextTimeExitMs) {
        nextTimeExitMs = left;
        nextExitInGrace = deadline <= now.getTime();
      }
    }

    const losses = positions
      .filter((p) => p.unrealizedPnlUsdMicro !== null && BigInt(p.unrealizedPnlUsdMicro) < 0n)
      .sort((a, b) => Number(BigInt(a.unrealizedPnlUsdMicro!) - BigInt(b.unrealizedPnlUsdMicro!)));
    const worst = losses[0];

    const seats = state.pipeline.roster.filter((s) => s.handle !== null);
    const idleSoonSeat = seats
      .filter((s) => s.openPositions === 0 && s.idleFireHoursLeft !== null && s.idleFireHoursLeft <= 2)
      .sort((a, b) => (a.idleFireHoursLeft ?? 0) - (b.idleFireHoursLeft ?? 0))[0];

    const benchRows = state.watchlist.rows.filter((r) => r.status === 'bench');
    const benchTop = benchRows[0]
      ? { handle: benchRows[0].handle, netUsdMicro: BigInt(benchRows[0].netShadowPnlUsdMicro) }
      : null;

    // Newest first, so "latest" in the digest is literal (listActivations is
    // ordered by startedAt descending).
    const hires = (sinceIso: string): string[] =>
      repo
        .listActivations(this.db.db, 500)
        .filter((a) => a.startedAt >= sinceIso)
        .map((a) => repo.getCandidate(this.db.db, a.candidateId)?.handle ?? a.candidateId);
    const firings = (sinceIso: string): Array<{ handle: string; reason: string }> =>
      repo
        .listFiringEventsSince(this.db.db, sinceIso)
        .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
        .map((f) => ({
          handle: repo.getCandidate(this.db.db, f.candidateId)?.handle ?? f.candidateId,
          reason: f.reason,
        }));

    const closed24h = closedRecord(
      repo
        .listPnlLots(this.db.db, 500)
        .filter((l) => l.closedAt >= since24h)
        .map((l) => BigInt(l.pnlUsdMicro)),
    );

    return {
      mode: this.mode,
      armed: state.armed,
      appState: state.appState,
      realizedUsdMicro: closed24h.sumUsdMicro,
      closed: closed24h,
      orders: repo.tradesSince(this.db.db, since24h),
      equityUsdMicro: BigInt(state.equity.currentUsdMicro),
      equityChangeUsdMicro: BigInt(state.equity.changeUsdMicro),
      cashUsdMicro: BigInt(state.counters.cashUsdMicro),
      deployedPct: state.counters.deployedPct,
      maxDeployedPct: state.counters.maxDeployedPct,
      openPositions: positions.length,
      openUnrealizedUsdMicro: openUnrealized,
      marksPending,
      nextTimeExitMs,
      nextExitInGrace,
      chairs: seats.length,
      chairsHolding: seats.filter((s) => s.openPositions > 0).length,
      benchDepth: benchRows.length,
      benchTop,
      worstPosition: worst
        ? {
            symbol: worst.symbol ?? worst.mintShort,
            pnlUsdMicro: BigInt(worst.unrealizedPnlUsdMicro!),
          }
        : null,
      idleSoon: idleSoonSeat
        ? { handle: idleSoonSeat.handle, hoursLeft: idleSoonSeat.idleFireHoursLeft ?? 0 }
        : null,
      hired: hires(sinceWindow),
      fired: firings(sinceWindow),
      walletUsdcUsdMicro:
        state.health.walletUsdcUsdMicro === null ? null : BigInt(state.health.walletUsdcUsdMicro),
      feeSolBalance: state.health.feeSolBalance,
      feesPaidUsdMicro:
        state.counters.feesPaidUsdMicro === null ? null : BigInt(state.counters.feesPaidUsdMicro),
      pendingReconciliations: state.health.pendingReconciliations,
      weekly:
        window === 'weekly'
          ? {
              realizedUsdMicro: repo.realizedPnlSince(this.db.db, sinceWindow),
              closed: closedRecord(
                repo
                  .listPnlLots(this.db.db, 500)
                  .filter((l) => l.closedAt >= sinceWindow)
                  .map((l) => BigInt(l.pnlUsdMicro)),
              ),
              orders: repo.tradesSince(this.db.db, sinceWindow),
              chairs: this.chairRecords(sinceWindow, state),
            }
          : null,
    };
  }

  /** Per-chair record over the window: lots map back through their position. */
  private chairRecords(sinceIso: string, state: DashboardState): ChairRecord[] {
    const activationByPosition = new Map(
      repo.listPositions(this.db.db, 200).map((p) => [p.positionId, p.activationId]),
    );
    const byActivation = new Map<string, { realized: bigint; wins: number; losses: number }>();
    for (const lot of repo.listPnlLots(this.db.db, 500)) {
      if (lot.closedAt < sinceIso) continue;
      const activationId = activationByPosition.get(lot.positionId);
      if (!activationId) continue;
      const cur = byActivation.get(activationId) ?? { realized: 0n, wins: 0, losses: 0 };
      cur.realized += BigInt(lot.pnlUsdMicro);
      if (BigInt(lot.pnlUsdMicro) > 0n) cur.wins++;
      else if (BigInt(lot.pnlUsdMicro) < 0n) cur.losses++;
      byActivation.set(activationId, cur);
    }
    return state.pipeline.roster
      .filter((s) => s.handle !== null)
      .map((s) => {
        const rec = byActivation.get(s.activationId) ?? { realized: 0n, wins: 0, losses: 0 };
        return {
          handle: s.handle,
          realizedUsdMicro: rec.realized,
          wins: rec.wins,
          losses: rec.losses,
          openPositions: s.openPositions,
        };
      })
      .sort((a, b) => Number(b.realizedUsdMicro - a.realizedUsdMicro));
  }
}

/** Win/loss/flat split plus the total, so one scan feeds both. */
function closedRecord(pnls: bigint[]): ClosedRecord {
  let sum = 0n;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  for (const pnl of pnls) {
    sum += pnl;
    if (pnl > 0n) wins++;
    else if (pnl < 0n) losses++;
    else flat++;
  }
  return { total: pnls.length, wins, losses, flat, sumUsdMicro: sum };
}
