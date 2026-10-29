import { describe, expect, it } from 'vitest';
import {
  validateRecommendation,
  snapshotHash,
  type ResearchSnapshot,
  type RecommendationPayload,
} from '../src/recommendation.js';
import { DEFAULT_RISK } from '@zcode-bot/config';
import { consumeShortlist } from '../src/shortlist.js';
import { checkEligibility } from '../src/eligibility.js';

function snapshotFixture(): ResearchSnapshot {
  const now = Date.now();
  return {
    snapshotId: 'snap-1',
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 3 * 3600_000).toISOString(),
    sourceFreshnessSeconds: 300,
    candidates: [
      cand('c-alpha', 'alpha_trader', 1, true),
      cand('c-beta', 'beta_trader', 2, true),
      cand('c-gamma', 'gamma_trader', 3, false),
    ],
  };
}

function cand(candidateId: string, handle: string, weeklyRank: number, enabled: boolean) {
  return {
    candidateId,
    handle,
    weeklyRank,
    displayedWeeklyPnlUsdMicro: '1234560000',
    profileUrl: 'https://fomo.example/' + handle,
    avatarUrl: null,
    addresses: [
      {
        chain: 'solana',
        address: 'Leader' + candidateId + 'Addr1111111111111111111111',
        verification: 'reported' as const,
      },
    ],
    enabled,
    recentlyFired: false,
    recentEligibilityFailures: [],
    publicStats: {
      winRatePct: 61,
      tradesCount: 120,
      avgTradeUsdMicro: '4000000',
      activityCheckedAt: null,
    },
    observedAt: new Date(Date.now() - 600_000).toISOString(),
  };
}

function payloadFixture(
  snapshot: ResearchSnapshot,
  over: Partial<RecommendationPayload> = {},
): RecommendationPayload {
  const now = Date.now();
  return {
    schemaVersion: 1,
    recommendationId: '0b7f8f6e-1c2d-4e5f-9a7b-3c4d5e6f7a8b',
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshotHash(snapshot),
    createdAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 3 * 3600_000).toISOString(),
    researchSessionId: 'sess-123',
    modelLabel: 'GLM (ZCode)',
    orderedCandidates: [
      {
        candidateId: 'c-beta',
        rank: 1,
        confidence: 0.72,
        thesis: 'Fresh complete data, verified-eligible address, consistent activity.',
        evidence: [
          {
            field: 'weeklyRank',
            observedAt: new Date(now - 600_000).toISOString(),
            note: 'rank 2 with full stats',
          },
        ],
        concerns: ['displayed PnL unverified'],
      },
      {
        candidateId: 'c-alpha',
        rank: 2,
        confidence: 0.61,
        thesis: 'Supported address but thinner evidence.',
        evidence: [],
        concerns: [],
      },
    ],
    abstain: false,
    abstainReason: null,
    ...over,
  };
}

describe('recommendation validation', () => {
  it('accepts a well-formed ordered recommendation', () => {
    const snap = snapshotFixture();
    const res = validateRecommendation(payloadFixture(snap), {
      snapshot: snap,
      now: new Date(),
      seenRecommendationIds: new Set(),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects unexpected fields (strict schema)', () => {
    const snap = snapshotFixture();
    const bad = { ...payloadFixture(snap), activateNow: true };
    const res = validateRecommendation(bad, {
      snapshot: snap,
      now: new Date(),
      seenRecommendationIds: new Set(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('SCHEMA_INVALID');
  });

  it('rejects duplicate ranks', () => {
    const snap = snapshotFixture();
    const p = payloadFixture(snap);
    p.orderedCandidates[1]!.rank = 1;
    const res = validateRecommendation(p, {
      snapshot: snap,
      now: new Date(),
      seenRecommendationIds: new Set(),
    });
    expect(res).toMatchObject({ ok: false, code: 'DUPLICATE_RANK' });
  });

  it('rejects duplicate candidates', () => {
    const snap = snapshotFixture();
    const p = payloadFixture(snap);
    p.orderedCandidates[1] = { ...p.orderedCandidates[0]!, rank: 2 };
    const res = validateRecommendation(p, {
      snapshot: snap,
      now: new Date(),
      seenRecommendationIds: new Set(),
    });
    expect(res).toMatchObject({ ok: false, code: 'DUPLICATE_CANDIDATE' });
  });

  it('rejects unknown candidate ids', () => {
    const snap = snapshotFixture();
    const p = payloadFixture(snap, {});
    p.orderedCandidates[0] = { ...p.orderedCandidates[0]!, candidateId: 'c-not-in-snapshot' };
    const res = validateRecommendation(p, {
      snapshot: snap,
      now: new Date(),
      seenRecommendationIds: new Set(),
    });
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_CANDIDATE' });
  });

  it('rejects snapshot id and hash mismatches', () => {
    const snap = snapshotFixture();
    const wrongId = payloadFixture(snap, { snapshotId: 'snap-other' });
    expect(
      validateRecommendation(wrongId, { snapshot: snap, now: new Date(), seenRecommendationIds: new Set() }),
    ).toMatchObject({ ok: false, code: 'SNAPSHOT_MISMATCH' });

    const wrongHash = payloadFixture(snap, { snapshotHash: 'a'.repeat(64) });
    expect(
      validateRecommendation(wrongHash, {
        snapshot: snap,
        now: new Date(),
        seenRecommendationIds: new Set(),
      }),
    ).toMatchObject({ ok: false, code: 'SNAPSHOT_MISMATCH' });
  });

  it('rejects malformed timestamps and expiry inversion', () => {
    const snap = snapshotFixture();
    const now = new Date();
    const malformed = payloadFixture(snap, { createdAt: 'not-a-date' });
    expect(
      validateRecommendation(malformed, { snapshot: snap, now, seenRecommendationIds: new Set() }),
    ).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });

    const inverted = payloadFixture(snap, {
      createdAt: new Date(now.getTime() + 3600_000).toISOString(),
      expiresAt: new Date(now.getTime() + 1800_000).toISOString(),
    });
    expect(
      validateRecommendation(inverted, { snapshot: snap, now, seenRecommendationIds: new Set() }),
    ).toMatchObject({
      ok: false,
      code: 'MALFORMED_TIMESTAMPS',
    });
  });

  it('rejects expired recommendations', () => {
    const snap = snapshotFixture();
    const expired = payloadFixture(snap, {
      createdAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(
      validateRecommendation(expired, { snapshot: snap, now: new Date(), seenRecommendationIds: new Set() }),
    ).toMatchObject({ ok: false, code: 'EXPIRED' });
  });

  it('rejects replayed recommendation ids', () => {
    const snap = snapshotFixture();
    const p = payloadFixture(snap);
    const seen = new Set([p.recommendationId]);
    expect(
      validateRecommendation(p, { snapshot: snap, now: new Date(), seenRecommendationIds: seen }),
    ).toMatchObject({
      ok: false,
      code: 'REPLAYED_RECOMMENDATION_ID',
    });
  });

  it('permits a clean abstention and rejects a malformed one', () => {
    const snap = snapshotFixture();
    const abstain = payloadFixture(snap, {
      abstain: true,
      abstainReason: 'no candidate has complete fresh data',
      orderedCandidates: [],
    });
    expect(
      validateRecommendation(abstain, { snapshot: snap, now: new Date(), seenRecommendationIds: new Set() })
        .ok,
    ).toBe(true);

    const badShape = payloadFixture(snap, { abstain: true, abstainReason: null, orderedCandidates: [] });
    expect(
      validateRecommendation(badShape, { snapshot: snap, now: new Date(), seenRecommendationIds: new Set() }),
    ).toMatchObject({
      ok: false,
      code: 'ABSTAIN_SHAPE_INVALID',
    });
  });

  it('excessive text is rejected by length caps', () => {
    const snap = snapshotFixture();
    const p = payloadFixture(snap);
    p.orderedCandidates[0] = { ...p.orderedCandidates[0]!, thesis: 'x'.repeat(5000) };
    expect(
      validateRecommendation(p, { snapshot: snap, now: new Date(), seenRecommendationIds: new Set() }),
    ).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
  });
});

describe('ordered shortlist consumption', () => {
  const ctxBase = {
    now: Date.now(),
    cooldownUntilMs: new Map<string, number>(),
    leaderboardMaxAgeSeconds: DEFAULT_RISK.LEADERBOARD_MAX_AGE_SECONDS,
  };

  it('activates the first eligible candidate in model order', () => {
    const snap = snapshotFixture();
    const rec = payloadFixture(snap); // rank1 = c-beta (eligible), rank2 = c-alpha
    const candidatesById = new Map(snap.candidates.map((c) => [c.candidateId, c]));
    const out = consumeShortlist({ ...ctxBase, recommendation: rec, candidatesById });
    expect(out.result).toBe('ACTIVATE');
    expect(out.activatedCandidateId).toBe('c-beta');
  });

  it('skips ineligible candidates with recorded reasons and pauses when exhausted', () => {
    const snap = snapshotFixture();
    const rec = payloadFixture(snap);
    rec.orderedCandidates = [
      { ...rec.orderedCandidates[0]!, candidateId: 'c-gamma' }, // disabled
      { ...rec.orderedCandidates[1]!, candidateId: 'c-alpha' },
    ];
    const candidatesById = new Map(snap.candidates.map((c) => [c.candidateId, c]));
    // Put c-alpha in cooldown.
    const cooldowns = new Map([['c-alpha', ctxBase.now + 60_000]]);
    const out = consumeShortlist({
      ...ctxBase,
      cooldownUntilMs: cooldowns,
      recommendation: rec,
      candidatesById,
    });
    expect(out.result).toBe('PAUSED_WAITING_FOR_ZCODE');
    expect(out.skipped.map((s) => s.reason)).toEqual(['DISABLED', 'FIRED_COOLDOWN']);
  });

  it('pauses when no recommendation exists or it expired', () => {
    const snap = snapshotFixture();
    const candidatesById = new Map(snap.candidates.map((c) => [c.candidateId, c]));
    expect(consumeShortlist({ ...ctxBase, recommendation: null, candidatesById }).result).toBe(
      'PAUSED_WAITING_FOR_ZCODE',
    );
    const expired = payloadFixture(snap, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(consumeShortlist({ ...ctxBase, recommendation: expired, candidatesById }).result).toBe(
      'PAUSED_WAITING_FOR_ZCODE',
    );
  });

  it('deterministic fallback ranking is stable and eligibility-gated', async () => {
    const { rankCandidatesDeterministically } = await import('../src/shortlist.js');
    const snap = snapshotFixture();
    const ranked = rankCandidatesDeterministically(snap.candidates, ctxBase);
    // disabled candidate never ranks
    expect(ranked.find((r) => r.candidate.candidateId === 'c-gamma')!.score).toBe(-Infinity);
    const eligible = ranked.filter((r) => r.score > -Infinity);
    expect(eligible.length).toBe(2);
    // stable: same input -> same output
    const ranked2 = rankCandidatesDeterministically(snap.candidates, ctxBase);
    expect(ranked2.map((r) => r.candidate.candidateId)).toEqual(ranked.map((r) => r.candidate.candidateId));
  });
});

describe('eligibility', () => {
  const ctx = {
    now: Date.now(),
    cooldownUntilMs: new Map<string, number>(),
    leaderboardMaxAgeSeconds: DEFAULT_RISK.LEADERBOARD_MAX_AGE_SECONDS,
  };

  it('requires a supported unambiguous address', () => {
    const snap = snapshotFixture();
    expect(checkEligibility(snap.candidates[0]!, ctx).eligible).toBe(true);

    const noAddress = { ...snap.candidates[0]!, addresses: [] };
    expect(checkEligibility(noAddress, ctx).reason).toBe('MISSING_ADDRESS');

    const wrongChain = {
      ...snap.candidates[0]!,
      addresses: [{ chain: 'ethereum', address: '0xabc', verification: 'reported' as const }],
    };
    expect(checkEligibility(wrongChain, ctx).reason).toBe('UNSUPPORTED_CHAIN');

    const ambiguous = {
      ...snap.candidates[0]!,
      addresses: [
        {
          chain: 'solana',
          address: 'Addr1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          verification: 'reported' as const,
        },
        {
          chain: 'solana',
          address: 'Addr2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          verification: 'reported' as const,
        },
      ],
    };
    expect(checkEligibility(ambiguous, ctx).reason).toBe('AMBIGUOUS_ADDRESS');
  });

  it('enforces cooldown, disabled, staleness, and recurring failures', () => {
    const snap = snapshotFixture();
    const cooldowns = new Map([[snap.candidates[0]!.candidateId, ctx.now + 3600_000]]);
    expect(checkEligibility(snap.candidates[0]!, { ...ctx, cooldownUntilMs: cooldowns }).reason).toBe(
      'FIRED_COOLDOWN',
    );
    expect(checkEligibility(snap.candidates[2]!, ctx).reason).toBe('DISABLED');
    const stale = { ...snap.candidates[0]!, observedAt: new Date(ctx.now - 10 * 86400_000).toISOString() };
    expect(checkEligibility(stale, ctx).reason).toBe('STALE_DATA');
    const failing = {
      ...snap.candidates[0]!,
      recentEligibilityFailures: ['STALE_DATA', 'MISSING_ADDRESS', 'DISABLED'],
    };
    expect(checkEligibility(failing, ctx).reason).toBe('RECURRING_ELIGIBILITY_FAILURE');
  });
});
