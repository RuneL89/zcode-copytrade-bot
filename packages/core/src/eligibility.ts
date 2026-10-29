import type { SanitizedCandidate } from './recommendation.js';
import { SUPPORTED_CHAINS } from './recommendation.js';

export type EligibilityReason =
  | 'ELIGIBLE'
  | 'DISABLED'
  | 'STALE_DATA'
  | 'MISSING_ADDRESS'
  | 'UNSUPPORTED_CHAIN'
  | 'AMBIGUOUS_ADDRESS'
  | 'FIRED_COOLDOWN'
  | 'RECENTLY_FIRED'
  | 'RECURRING_ELIGIBILITY_FAILURE';

export interface EligibilityContext {
  now: number;
  /** candidateId -> epoch ms until which the candidate is cooling down after a firing. */
  cooldownUntilMs: ReadonlyMap<string, number>;
  /** Max age of the candidate's observation, seconds. */
  leaderboardMaxAgeSeconds: number;
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
  const cooldown = ctx.cooldownUntilMs.get(candidate.candidateId);
  if (cooldown !== undefined && cooldown > ctx.now) {
    return {
      eligible: false,
      reason: 'FIRED_COOLDOWN',
      detail: `cooling down until ${new Date(cooldown).toISOString()}`,
    };
  }
  if (candidate.recentlyFired) {
    return { eligible: false, reason: 'RECENTLY_FIRED', detail: 'fired in the current session' };
  }
  const observedAt = Date.parse(candidate.observedAt);
  if (Number.isNaN(observedAt) || ctx.now - observedAt > ctx.leaderboardMaxAgeSeconds * 1000) {
    return {
      eligible: false,
      reason: 'STALE_DATA',
      detail: 'leaderboard observation older than LEADERBOARD_MAX_AGE_SECONDS',
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
