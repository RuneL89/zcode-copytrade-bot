import type { DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { Notifier } from '@zcode-bot/providers';

/**
 * Push reports to the operator's Telegram (opt-in via TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID; no-op when unset). Two streams only, per operator choice:
 *  - anomalies: audit rows that indicate something needs attention
 *    (rejected recommendations, adapter failures, reconciliation cases)
 *  - one daily PnL summary (local 09:00)
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

/** Pure selection: audit rows newer than lastSeenId that look like anomalies. */
export function selectAnomalies(rows: AuditLike[], lastSeenId: number): AuditLike[] {
  return rows.filter(
    (r) => r.id > lastSeenId && ANOMALY_CATEGORIES.has(r.category) && ANOMALY_PATTERN.test(r.message),
  );
}

/** Micro-USD bigint to a compact signed USD string ("-$93.60", "$1,234.50"). */
export function formatMicroUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const dollars = Number(abs / 1_000_000n) + Number(abs % 1_000_000n) / 1e6;
  const formatted = dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return negative ? `-$${formatted}` : `$${formatted}`;
}

export function dailyReportText(input: {
  mode: string;
  realizedUsdMicro24h: bigint;
  trades24h: number;
  openPositions: number;
  activeCandidateId: string | null;
}): string {
  const lines = [
    `ZCode Bot daily report (${input.mode})`,
    `Realized PnL (24h): ${formatMicroUsd(input.realizedUsdMicro24h)} across ${input.trades24h} trade(s)`,
    `Open positions: ${input.openPositions}`,
  ];
  lines.push(input.activeCandidateId ? `Active trader: ${input.activeCandidateId}` : 'Active trader: none');
  return lines.join('\n');
}

/** Milliseconds until the next occurrence of a local wall-clock time. */
export function msUntilNextLocalTime(hour: number, minute: number, now = new Date()): number {
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

export class ReportsService {
  private anomalyTimer: ReturnType<typeof setInterval> | null = null;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  private dailyRepeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: DbHandle,
    private notifier: Notifier,
    private mode: string,
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
    await this.notifier.notify(`⚠️ ZCode Bot anomalies\n${body}`);
  }

  /** One PnL summary per local day, pushed around 09:00. */
  async sendDailyReport(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (repo.kvGet(this.db.db, 'reports.lastDailyDate') === today) return;
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const activation = repo.activeActivation(this.db.db);
    const text = dailyReportText({
      mode: this.mode,
      realizedUsdMicro24h: repo.realizedPnlSince(this.db.db, since),
      trades24h: repo.tradesSince(this.db.db, since),
      openPositions: repo.openPositions(this.db.db).length,
      activeCandidateId: activation ? (activation as unknown as { candidateId: string }).candidateId : null,
    });
    repo.kvSet(this.db.db, 'reports.lastDailyDate', today);
    await this.notifier.notify(text);
  }
}
