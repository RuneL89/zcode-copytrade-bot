import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './money.js';

// ---------------------------------------------------------------------------
// Sanitized research snapshot (produced by the server, consumed via MCP)
// ---------------------------------------------------------------------------

export const SUPPORTED_CHAINS = ['solana'] as const;
export type Chain = (typeof SUPPORTED_CHAINS)[number] | (string & {});

export interface SanitizedCandidateAddress {
  chain: string;
  address: string;
  /** 'verified' addresses were independently confirmed on-chain; 'reported' came from the leaderboard page only. */
  verification: 'reported' | 'verified';
}

export interface SanitizedCandidate {
  /** Stable server-generated ID. Recommendations may only reference these. */
  candidateId: string;
  handle: string;
  weeklyRank: number | null;
  /** Displayed weekly PnL as reported by the leaderboard (micro-USD, unverified). */
  displayedWeeklyPnlUsdMicro: string | null;
  profileUrl: string | null;
  avatarUrl: string | null;
  addresses: SanitizedCandidateAddress[];
  enabled: boolean;
  /** True only while this candidate is the just-fired exclusion (deriveJustFiredExclusion) — the engine refuses to hire him until a different trader is activated. */
  justFired: boolean;
  recentEligibilityFailures: string[];
  /** Aggregate PUBLIC trading statistics as reported; null when unavailable. */
  publicStats: {
    winRatePct: number | null;
    tradesCount: number | null;
    avgTradeUsdMicro: string | null;
    /** Day-trader signals from the Fomo/Dawn pipeline (null = unknown). */
    avgHoldHours: number | null;
    realizedOnchainUsd: number | null;
    swaps24h: number | null;
    lastSwapAt: string | null;
    /** Helius activity refresh stamp (6h server timer); freshness evidence for swaps24h/lastSwapAt. */
    activityCheckedAt: string | null;
    /**
     * Actively-trading signal (hire priority, not a gate): the most recent
     * on-chain BUY when it fell inside ACTIVE_BUY_WINDOW_HOURS at check time,
     * else null (no buy in window, or the direction check failed — the tier
     * then treats the candidate as not active and the merit order decides).
     */
    lastBuyAt: string | null;
    /** Computed at snapshot build from lastBuyAt vs the configured window. */
    activelyTrading: boolean;
    /** Dawn stats card stamp (GUI fetches only); NOT a freshness signal for the activity fields. */
    statsCheckedAt: string | null;
    /** Dawn compact card: PnL per period (unrealized marks, unverified). */
    pnl24hUsd: number | null;
    pnl7dUsd: number | null;
    pnl30dUsd: number | null;
    pnlAllTimeUsd: number | null;
    /** Dawn compact card: lifetime trades, recent buys/sells, activity age. */
    tradesTotal: number | null;
    recentBuys: number | null;
    recentSells: number | null;
    lastTradeAgeHours: number | null;
  };
  observedAt: string;
}

export interface ResearchSnapshot {
  snapshotId: string;
  createdAt: string;
  expiresAt: string;
  /** Age of the freshest underlying leaderboard observation, seconds. */
  sourceFreshnessSeconds: number;
  /** Oldest underlying leaderboard observation; null when the pool is empty. */
  oldestObservedAt?: string | null;
  /** Candidates whose observedAt is older than 24h — the pool may be partially stale. */
  staleCandidateCount?: number;
  /**
   * The most recent captured board scan. The engine refuses any hire whose
   * handle is not in latestScan.handles (NOT_ON_BOARD), so this list is the
   * researcher's hireable universe.
   */
  latestScan?: { observedAt: string; handles: string[] } | null;
  candidates: SanitizedCandidate[];
}

export function snapshotHash(snapshot: ResearchSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

const isoTimestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'malformed ISO-8601 timestamp');

// ---------------------------------------------------------------------------
// Recommendation payload (submitted by ZCode via MCP)
// ---------------------------------------------------------------------------

export const evidenceItemSchema = z
  .object({
    field: z.string().min(1).max(120),
    observedAt: isoTimestamp,
    note: z.string().max(500),
  })
  .strict();

export const orderedCandidateSchema = z
  .object({
    candidateId: z.string().min(1).max(120),
    rank: z.number().int().min(1).max(50),
    confidence: z.number().min(0).max(1),
    thesis: z.string().max(2000),
    evidence: z.array(evidenceItemSchema).max(20),
    concerns: z.array(z.string().max(500)).max(10),
  })
  .strict();

export const recommendationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    recommendationId: z.string().uuid(),
    snapshotId: z.string().min(1).max(120),
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/, 'snapshotHash must be sha256 hex'),
    createdAt: isoTimestamp,
    expiresAt: isoTimestamp,
    researchSessionId: z.string().max(120).nullable().optional(),
    modelLabel: z.string().max(100).nullable().optional(),
    orderedCandidates: z.array(orderedCandidateSchema).max(10),
    abstain: z.boolean(),
    abstainReason: z.string().max(1000).nullable(),
    /**
     * Ask the engine to rotate the active trader when it is flat: fire it and
     * hire the best candidate from this (fresh) ordering. The engine only acts
     * when no position is open, and only when a candidate is actually hireable.
     */
    rotateIfFlat: z.boolean().optional(),
  })
  .strict();

export type RecommendationPayload = z.infer<typeof recommendationPayloadSchema>;

export type RecommendationRejectionCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_RANK'
  | 'DUPLICATE_CANDIDATE'
  | 'UNKNOWN_CANDIDATE'
  | 'SNAPSHOT_MISMATCH'
  | 'EXPIRED'
  | 'MALFORMED_TIMESTAMPS'
  | 'ABSTAIN_SHAPE_INVALID'
  | 'EMPTY_ORDERING'
  | 'REPLAYED_RECOMMENDATION_ID';

export type RecommendationValidationResult =
  | { ok: true; recommendation: RecommendationPayload; normalizedAt: string }
  | { ok: false; code: RecommendationRejectionCode; message: string };

export interface ValidateRecommendationContext {
  snapshot: ResearchSnapshot;
  now: Date;
  /** Recommendation IDs already accepted (replay protection). */
  seenRecommendationIds: ReadonlySet<string>;
}

/**
 * Fail-closed validation of a submitted recommendation.
 * Every rejection path here is tested; none of them can activate a trader —
 * activation is a separate server-side action.
 */
export function validateRecommendation(
  payload: unknown,
  ctx: ValidateRecommendationContext,
): RecommendationValidationResult {
  const parsed = recommendationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'SCHEMA_INVALID',
      message: parsed.error.issues[0]?.message ?? 'schema invalid',
    };
  }
  const rec = parsed.data;

  if (ctx.seenRecommendationIds.has(rec.recommendationId)) {
    return {
      ok: false,
      code: 'REPLAYED_RECOMMENDATION_ID',
      message: `recommendationId ${rec.recommendationId} was already accepted`,
    };
  }

  if (rec.snapshotId !== ctx.snapshot.snapshotId) {
    return {
      ok: false,
      code: 'SNAPSHOT_MISMATCH',
      message: 'snapshotId does not match the current research snapshot',
    };
  }
  if (rec.snapshotHash !== snapshotHash(ctx.snapshot)) {
    return {
      ok: false,
      code: 'SNAPSHOT_MISMATCH',
      message: 'snapshotHash does not match the canonical snapshot hash',
    };
  }

  const created = Date.parse(rec.createdAt);
  const expires = Date.parse(rec.expiresAt);
  if (Number.isNaN(created) || Number.isNaN(expires) || expires <= created) {
    return {
      ok: false,
      code: 'MALFORMED_TIMESTAMPS',
      message: 'createdAt/expiresAt malformed or expiresAt <= createdAt',
    };
  }
  if (expires <= ctx.now.getTime()) {
    return { ok: false, code: 'EXPIRED', message: 'recommendation expiresAt is in the past' };
  }
  if (created > ctx.now.getTime() + 5 * 60 * 1000) {
    return { ok: false, code: 'MALFORMED_TIMESTAMPS', message: 'createdAt is unreasonably in the future' };
  }

  if (rec.abstain) {
    if (rec.orderedCandidates.length !== 0) {
      return {
        ok: false,
        code: 'ABSTAIN_SHAPE_INVALID',
        message: 'abstain must not include ordered candidates',
      };
    }
    if (!rec.abstainReason || rec.abstainReason.trim() === '') {
      return { ok: false, code: 'ABSTAIN_SHAPE_INVALID', message: 'abstain requires abstainReason' };
    }
    return { ok: true, recommendation: rec, normalizedAt: ctx.now.toISOString() };
  }

  if (rec.orderedCandidates.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_ORDERING',
      message: 'non-abstaining recommendation has no ordered candidates',
    };
  }

  const ranks = new Set<number>();
  const ids = new Set<string>();
  const known = new Set(ctx.snapshot.candidates.map((c) => c.candidateId));
  for (const cand of rec.orderedCandidates) {
    if (ranks.has(cand.rank)) {
      return { ok: false, code: 'DUPLICATE_RANK', message: `duplicate rank ${cand.rank}` };
    }
    ranks.add(cand.rank);
    if (ids.has(cand.candidateId)) {
      return { ok: false, code: 'DUPLICATE_CANDIDATE', message: `duplicate candidateId ${cand.candidateId}` };
    }
    ids.add(cand.candidateId);
    if (!known.has(cand.candidateId)) {
      return {
        ok: false,
        code: 'UNKNOWN_CANDIDATE',
        message: `candidateId ${cand.candidateId} is not in snapshot ${ctx.snapshot.snapshotId}`,
      };
    }
  }

  return { ok: true, recommendation: rec, normalizedAt: ctx.now.toISOString() };
}

/** Stored/normalized audit view of a validated recommendation. */
export interface StoredRecommendation {
  payload: RecommendationPayload;
  snapshotHash: string;
  receivedAt: string;
  validation: 'validated' | 'rejected';
  rejection?: { code: RecommendationRejectionCode; message: string };
}

export function recommendationAgeMs(rec: { createdAt: string }, now: number): number {
  return Math.max(0, now - Date.parse(rec.createdAt));
}

export function recommendationExpired(rec: { expiresAt: string }, now: number): boolean {
  return Date.parse(rec.expiresAt) <= now;
}
