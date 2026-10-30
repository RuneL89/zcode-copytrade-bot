/**
 * Rank-stability firing rule (day-trader momentum).
 *
 * The captured visible top-7 of the 24h FOMO board IS the board: a trader not
 * present in a scan is off the board as far as this system can observe.
 *
 * Fire the active trader when either:
 * - he is absent from the latest scan (one scan is enough: absence is decay),
 * - or he is outside the top N in two consecutive scans.
 *
 * Both branches stand down when the latest scan is older than the scan
 * freshness window: a dead capture pipeline must not drive fires.
 */

export interface BoardScan {
  /** Scan timestamp (ISO). */
  observedAt: string;
  /** handle -> displayed board rank for that scan. */
  ranks: ReadonlyMap<string, number>;
}

export type RankStabilityVerdict =
  | { action: 'none'; strikes: 0 | 1; latestRank: number | null }
  | { action: 'fire'; reason: string; strikes: 1 | 2; latestRank: number | null }
  | { action: 'stand_down'; detail: string; strikes: 0; latestRank: number | null };

export interface RankStabilityInput {
  /** Scans newest first (index 0 = latest). */
  scans: readonly BoardScan[];
  /** Active trader's handle, or null when unknown/unresolvable. */
  incumbentHandle: string | null;
  nowMs: number;
  /** Max age of the latest scan for the rule to act at all. */
  scanFreshMs: number;
  /** Board ranks at or above this count as "top" (3 = displayed ranks 1..3). */
  topN: number;
}

export function evaluateRankStability(input: RankStabilityInput): RankStabilityVerdict {
  const { scans, incumbentHandle, nowMs, scanFreshMs, topN } = input;
  if (!incumbentHandle) {
    return { action: 'stand_down', detail: 'incumbent handle unknown', strikes: 0, latestRank: null };
  }
  const latest = scans[0];
  if (!latest) {
    return { action: 'stand_down', detail: 'no scans captured yet', strikes: 0, latestRank: null };
  }
  const latestMs = Date.parse(latest.observedAt);
  if (!Number.isFinite(latestMs) || nowMs - latestMs > scanFreshMs) {
    return {
      action: 'stand_down',
      detail: 'latest scan older than the freshness window',
      strikes: 0,
      latestRank: null,
    };
  }
  const latestRank = latest.ranks.get(incumbentHandle) ?? null;
  if (latestRank === null) {
    return {
      action: 'fire',
      reason: `rank: left the board (absent from the top-7 scan of ${latest.observedAt})`,
      strikes: 1,
      latestRank: null,
    };
  }
  if (latestRank <= topN) {
    return { action: 'none', strikes: 0, latestRank };
  }
  const previous = scans[1];
  const previousRank = previous?.ranks.get(incumbentHandle) ?? null;
  if (previousRank === null || previousRank > topN) {
    const prevDesc =
      previousRank === null
        ? 'absent'
        : `rank ${previousRank}${previous ? ` at ${previous.observedAt}` : ''}`;
    return {
      action: 'fire',
      reason: `rank: outside top-${topN} in 2 consecutive scans (rank ${latestRank} at ${latest.observedAt}, ${prevDesc} before)`,
      strikes: 2,
      latestRank,
    };
  }
  return { action: 'none', strikes: 1, latestRank };
}
