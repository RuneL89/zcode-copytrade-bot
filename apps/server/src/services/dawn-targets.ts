/**
 * Dawn lookup target selection — pure and unit-tested.
 *
 * Two queues, each sorted so the run serves the day-trading strategy:
 *  - walletless candidates first, freshest board observation first (the current
 *    leaders get wallets before the back catalogue);
 *  - then known wallets with stale stats, OLDEST stats first. The old unsorted
 *    queue starved its tail: with 29 candidates and a 25 cap, the same four
 *    candidates were skipped on every run and their PnL marks froze for 32h+
 *    (that is exactly how DumbCrayonEater's week looked -507k when it may not
 *    have been).
 */

export interface DawnTargetInput {
  candidateId: string;
  handle: string;
  observedAt: string;
  statsCheckedAt: string | null;
}

export function selectDawnTargets<T extends DawnTargetInput>(
  candidates: readonly T[],
  walletsWithSolana: ReadonlySet<string>,
  staleCutoffIso: string,
  limit: number,
): T[] {
  const walletless = candidates
    .filter((c) => !walletsWithSolana.has(c.candidateId))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const staleStats = candidates
    .filter(
      (c) =>
        walletsWithSolana.has(c.candidateId) &&
        (c.statsCheckedAt == null || c.statsCheckedAt < staleCutoffIso),
    )
    .sort((a, b) => (a.statsCheckedAt ?? '').localeCompare(b.statsCheckedAt ?? ''));
  return [...walletless, ...staleStats].slice(0, Math.max(0, limit));
}
