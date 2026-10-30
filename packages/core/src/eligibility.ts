import type { SanitizedCandidate } from './recommendation.js';
import { SUPPORTED_CHAINS } from './recommendation.js';

/**
 * How fresh the candidate's on-chain activity check must be for the candidate
 * to stay usable when its leaderboard observation has gone stale. Matches the
 * Helius activity refresh cadence (6h server timer).
 */
export const ACTIVITY_FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * How fresh the latest board scan must be for the board-presence hire guard
 * (and the rank-fire rule) to act on it. With 30-minute sweep refreshes this
 * tolerates four missed runs; during a capture outage the guards stand down.
 */
export const SCAN_FRESH_MS = 2 * 60 * 60 * 1000;

export type EligibilityReason =
  | 'ELIGIBLE'
  | 'DISABLED'
  | 'STALE_DATA'
  | 'NOT_ON_BOARD'
  | 'MISSING_ADDRESS'
  | 'UNSUPPORTED_CHAIN'
  | 'AMBIGUOUS_ADDRESS'
  | 'RECURRING_ELIGIBILITY_FAILURE';

export interface LatestScanContext {
  observedAt: string;
  handles: readonly string[];
}

export interface EligibilityContext {
  now: number;
  /** Max age of the candidate's observation, seconds. */
  leaderboardMaxAgeSeconds: number;
  /** Max age of the candidate's last on-chain activity check, seconds. Default 6h. */
  activityFreshSeconds?: number;
  /** Max age of the latest scan for the board-presence guard, seconds. Default 2h. */
  scanFreshSeconds?: number;
  /** Latest captured board scan, when one exists. */
  latestScan?: LatestScanContext | null;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  detail?: string;
}

/**
 * Deterministic eligibility. Runs identically in tests, after firing, and on
 * restart. Confidence values from the model NEVER enter this function.
 */
export function checkEligibility(candidate: SanitizedCandidate, ctx: EligibilityContext): EligibilityResult {
  if (!candidate.enabled) {
    return { eligible: false, reason: 'DISABLED', detail: 'candidate disabled by operator' };
  }
  // Board-presence hire guard: a hire must be on the latest captured board.
  // Fired traders carry no penalty here — if the board says they are back and
  // fresh, they are hireable again immediately.
  if (ctx.latestScan) {
    const scanMs = Date.parse(ctx.latestScan.observedAt);
    const scanFreshSeconds = (ctx.scanFreshSeconds ?? SCAN_FRESH_MS / 1000) * 1000;
    if (Number.isFinite(scanMs) && ctx.now - scanMs <= scanFreshSeconds) {
      if (!ctx.latestScan.handles.includes(candidate.handle)) {
        return {
          eligible: false,
          reason: 'NOT_ON_BOARD',
          detail: `not on the latest scan (${ctx.latestScan.observedAt})`,
        };
      }
    }
  }
  // Two independent clocks: the leaderboard observation and the on-chain
  // activity check. A stale observation alone must not disqualify a candidate
  // whose wallet activity was verified recently — the board rotates daily,
  // while a resolved wallet is permanent and Helius re-verifies activity every
  // few hours.
  const observedAt = Date.parse(candidate.observedAt);
  const observationStale =
    Number.isNaN(observedAt) || ctx.now - observedAt > ctx.leaderboardMaxAgeSeconds * 1000;
  const activityFreshSeconds = (ctx.activityFreshSeconds ?? ACTIVITY_FRESH_MS / 1000) * 1000;
  const activityCheckedAt = candidate.publicStats.activityCheckedAt
    ? Date.parse(candidate.publicStats.activityCheckedAt)
    : NaN;
  const activityFresh =
    Number.isFinite(activityCheckedAt) && ctx.now - activityCheckedAt <= activityFreshSeconds;
  if (observationStale && !activityFresh) {
    return {
      eligible: false,
      reason: 'STALE_DATA',
      detail:
        'both stamps stale: leaderboard observation older than LEADERBOARD_MAX_AGE_SECONDS' +
        (Number.isFinite(activityCheckedAt)
          ? ' and on-chain activity check older than the freshness window'
          : ' and no fresh on-chain activity check'),
    };
  }
  if (candidate.recentEligibilityFailures.length >= 3) {
    return {
      eligible: false,
      reason: 'RECURRING_ELIGIBILITY_FAILURE',
      detail: `recent failures: ${candidate.recentEligibilityFailures.slice(0, 3).join(', ')}`,
    };
  }
  const addresses = candidate.addresses ?? [];
  if (addresses.length === 0) {
    return { eligible: false, reason: 'MISSING_ADDRESS', detail: 'no leader address supplied' };
  }
  const supported = addresses.filter((a) => (SUPPORTED_CHAINS as readonly string[]).includes(a.chain));
  if (supported.length === 0) {
    return {
      eligible: false,
      reason: 'UNSUPPORTED_CHAIN',
      detail: `supported chains: ${SUPPORTED_CHAINS.join(', ')}; got ${[...new Set(addresses.map((a) => a.chain))].join(', ')}`,
    };
  }
  // Unambiguous = exactly one supported-chain address.
  if (supported.length > 1) {
    return {
      eligible: false,
      reason: 'AMBIGUOUS_ADDRESS',
      detail: 'multiple supported-chain addresses mapped',
    };
  }
  return { eligible: true, reason: 'ELIGIBLE' };
}
