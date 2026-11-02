/**
 * Freshness windows shared by the runtime and the monitor. They lived in the
 * retired eligibility module; the stall watcher and the activity refresh still
 * depend on them.
 */

/**
 * How fresh the candidate's on-chain activity check must be before the stall
 * watcher may act on it (matches the activity refresh cadence).
 */
export const ACTIVITY_FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * How fresh the latest board scan must be for any board-derived guard to act
 * on it (kept for callers that still read scan age; the roster itself no longer
 * hires from the board).
 */
export const SCAN_FRESH_MS = 2 * 60 * 60 * 1000;
