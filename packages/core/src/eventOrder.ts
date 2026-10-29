import type { LeaderClassifiedEvent } from './events.js';

/** Stable ordering key: slot, then transaction index, then leg. */
export function compareClassifiedEvents(
  a: { slot: number; transactionIndex: number; legIndex?: number },
  b: { slot: number; transactionIndex: number; legIndex?: number },
): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  return (a.legIndex ?? 0) - (b.legIndex ?? 0);
}

/** Deduplicate by (chain, leader address, signature, leg). */
export function eventDedupeKey(
  chain: string,
  leaderAddress: string,
  signature: string,
  legIndex: number,
): string {
  return `${chain}:${leaderAddress}:${signature}:${legIndex}`;
}

/** True when the event is too old to copy (MAX_COPY_EVENT_AGE_SECONDS). */
export function isEventTooOld(blockTime: number | null, nowMs: number, maxAgeSeconds: number): boolean {
  if (blockTime === null || blockTime <= 0) return true; // unknown time -> never enter late
  return nowMs - blockTime * 1000 > maxAgeSeconds * 1000;
}
