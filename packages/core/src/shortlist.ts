import type { SanitizedCandidate } from './recommendation.js';
import { checkEligibility, type EligibilityContext, type EligibilityReason } from './eligibility.js';

export type SkipReason = EligibilityReason | 'RECOMMENDATION_EXPIRED' | 'UNKNOWN_CANDIDATE';

export interface ShortlistEntry {
  candidateId: string;
  rank: number;
}

export interface ShortlistOutcome {
  /** First eligible candidate in the model-provided order, if any. */
  activatedCandidateId: string | null;
  /** Every skipped candidate with its reason, for the audit trail. */
  skipped: Array<{ candidateId: string; rank: number; reason: SkipReason }>;
  result: 'ACTIVATE' | 'PAUSED_WAITING_FOR_ZCODE';
  /** Visible label whenever deterministic_fallback was used. */
  source: 'zcode_shortlist' | 'deterministic_fallback';
}

export interface ConsumeShortlistContext extends EligibilityContext {
  recommendation: { orderedCandidates: ShortlistEntry[]; expiresAt: string } | null;
  candidatesById: ReadonlyMap<string, SanitizedCandidate>;
}

/**
 * Consume an ordered recommendation after a firing: walk the model-provided
 * order, skip ineligible candidates with recorded reasons, activate the first
 * eligible one. No eligible candidate (or none/expired recommendation) ->
 * PAUSED_WAITING_FOR_ZCODE. Never silently falls back to deterministic mode.
 */
export function consumeShortlist(ctx: ConsumeShortlistContext): ShortlistOutcome {
  const skipped: ShortlistOutcome['skipped'] = [];
  const rec = ctx.recommendation;
  if (!rec) {
    return {
      activatedCandidateId: null,
      skipped,
      result: 'PAUSED_WAITING_FOR_ZCODE',
      source: 'zcode_shortlist',
    };
  }
  if (Date.parse(rec.expiresAt) <= ctx.now) {
    return {
      activatedCandidateId: null,
      skipped,
      result: 'PAUSED_WAITING_FOR_ZCODE',
      source: 'zcode_shortlist',
    };
  }
  const ordered = [...rec.orderedCandidates].sort((a, b) => a.rank - b.rank);
  for (const entry of ordered) {
    const candidate = ctx.candidatesById.get(entry.candidateId);
    if (!candidate) {
      skipped.push({ candidateId: entry.candidateId, rank: entry.rank, reason: 'UNKNOWN_CANDIDATE' });
      continue;
    }
    const eligibility = checkEligibility(candidate, ctx);
    if (eligibility.eligible) {
      return {
        activatedCandidateId: candidate.candidateId,
        skipped,
        result: 'ACTIVATE',
        source: 'zcode_shortlist',
      };
    }
    skipped.push({ candidateId: entry.candidateId, rank: entry.rank, reason: eligibility.reason });
  }
  return {
    activatedCandidateId: null,
    skipped,
    result: 'PAUSED_WAITING_FOR_ZCODE',
    source: 'zcode_shortlist',
  };
}

/**
 * Opt-in deterministic fallback ranking (CANDIDATE_REPLACEMENT_MODE=deterministic_fallback).
 * Disabled by default and must be visibly labeled whenever used.
 * Scoring is a pure function of the sanitized snapshot so it is testable:
 *   + supported-chain address present
 *   + fresher observation wins
 *   + more complete public stats win
 *   + lower weekly rank wins
 * Ties break lexicographically by candidateId for full determinism.
 */
export function rankCandidatesDeterministically(
  candidates: readonly SanitizedCandidate[],
  ctx: EligibilityContext,
): Array<{ candidate: SanitizedCandidate; score: number }> {
  return candidates
    .map((candidate) => {
      const eligibility = checkEligibility(candidate, ctx);
      if (!eligibility.eligible) return { candidate, score: -Infinity };
      const hasAddress = candidate.addresses.some((a) => a.chain === 'solana');
      const freshnessSeconds = Math.max(0, (ctx.now - Date.parse(candidate.observedAt)) / 1000);
      const freshnessScore = Math.max(0, 1 - freshnessSeconds / Math.max(1, ctx.leaderboardMaxAgeSeconds));
      const completeness =
        (candidate.publicStats.winRatePct !== null ? 1 : 0) +
        (candidate.publicStats.tradesCount !== null ? 1 : 0) +
        (candidate.displayedWeeklyPnlUsdMicro !== null ? 1 : 0);
      const rankScore = candidate.weeklyRank ? 1 / candidate.weeklyRank : 0;
      const score = (hasAddress ? 10 : 0) + 3 * freshnessScore + completeness + rankScore;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score || (a.candidate.candidateId < b.candidate.candidateId ? -1 : 1));
}

/**
 * Actively-trading tier (operator decision, 2026-10-31): candidates whose
 * snapshot says `activelyTrading` are hired before the rest, each side
 * preserving its original order. When nobody is active the whole ordering
 * lands in `inactive` and the existing merit order decides — the fallback.
 * Fails open by construction: unknown/missing activity counts as not active.
 */
export function partitionByActivelyTrading<T>(
  entries: readonly T[],
  isActive: (entry: T) => boolean,
): { active: T[]; inactive: T[] } {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const entry of entries) {
    (isActive(entry) ? active : inactive).push(entry);
  }
  return { active, inactive };
}
