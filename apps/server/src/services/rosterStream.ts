import { logsLookLikeSwap, parseLogsNotification } from '@zcode-bot/core';

/**
 * Roster push. One logs subscription per hired seat. Only logs that name a
 * known swap program become a getTransaction. If the socket stays down for
 * more than 60s the seat falls back to the signature-first safety poll.
 */
export class RosterStream {
  private downSince: number | null = null;

  handleLogs(
    address: string,
    notice: { signature: string; err: boolean; logs: readonly string[] },
    onSwap: (address: string, signature: string) => void,
  ): void {
    if (notice.err || !logsLookLikeSwap(notice.logs)) return;
    onSwap(address, notice.signature);
  }

  ingest(address: string, message: unknown, onSwap: (address: string, signature: string) => void): void {
    const notice = parseLogsNotification(message);
    if (!notice) return;
    this.handleLogs(address, notice, onSwap);
  }

  markUp(): void {
    this.downSince = null;
  }

  markDown(nowMs: number): void {
    this.downSince ??= nowMs;
  }

  /** `outage` means the signature-first fallback, never a full-history poll. */
  mode(nowMs: number): 'push' | 'outage' {
    if (this.downSince === null) return 'push';
    return nowMs - this.downSince > 60_000 ? 'outage' : 'push';
  }
}
