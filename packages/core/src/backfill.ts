/**
 * Hire and reconnect backfill. A fresh seat used to pull the last 25
 * signatures and call getTransaction on each of them at once. Two seats did
 * that in the same minute and the session's day-projection jumped off the
 * 5,796 design. The selector keeps a short lookback and a hard count; the
 * minute ceiling spreads whatever still has to be paid.
 */

/** Short enough that a fetched buy is still inside the 90s copy window. */
export const HIRE_BACKFILL_LOOKBACK_MS = 60_000;
export const HIRE_BACKFILL_MAX_TX = 4;
/** Helius getTransaction calls allowed for a hire/reconnect backfill in one minute. */
export const HIRE_BACKFILL_PER_MINUTE = 6;
/**
 * Watch-list detail fallback. One tick is a few seconds, so this is also the
 * per-tick cap. At a 5-minute poll that is 576 Helius getTransaction credits
 * a day when the public node cannot read a transaction, inside the 800-credit
 * watch expectation.
 */
export const WATCH_DETAIL_PER_MINUTE = 2;

export interface BackfillSignature {
  signature: string;
  blockTime: number | null;
  err?: boolean;
}

export function selectHireBackfill(args: {
  signatures: readonly BackfillSignature[];
  nowMs: number;
  cursorSignature?: string | null;
  lookbackMs?: number;
  maxTx?: number;
}): BackfillSignature[] {
  const lookbackMs = args.lookbackMs ?? HIRE_BACKFILL_LOOKBACK_MS;
  const maxTx = args.maxTx ?? HIRE_BACKFILL_MAX_TX;
  const cutoffSec = Math.floor((args.nowMs - lookbackMs) / 1000);
  const newestFirst = [...args.signatures].sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
  const picked: BackfillSignature[] = [];
  for (const row of newestFirst) {
    if (!row.signature) continue;
    if (args.cursorSignature && row.signature === args.cursorSignature) break;
    if (row.err) continue;
    if (row.blockTime === null || row.blockTime < cutoffSec) continue;
    picked.push(row);
    if (picked.length >= maxTx) break;
  }
  return picked.reverse();
}

/** Newest-first page. Stops at the cursor so a poll does not re-read history. */
export function signaturesAfterCursor<T extends { signature: string }>(
  page: readonly T[],
  cursorSignature: string | null | undefined,
): T[] {
  const fresh: T[] = [];
  for (const row of page) {
    if (!row.signature) continue;
    if (cursorSignature && row.signature === cursorSignature) break;
    fresh.push(row);
  }
  return fresh;
}

/** Fixed window. `allow` records the call; a refusal does not. */
export class MinuteCeiling {
  private stamps: number[] = [];

  constructor(
    private max: number,
    private windowMs = 60_000,
  ) {}

  allow(atMs: number): boolean {
    this.stamps = this.stamps.filter((stamp) => atMs - stamp < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(atMs);
    return true;
  }
}
