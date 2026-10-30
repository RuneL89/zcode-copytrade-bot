import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig } from '@zcode-bot/config';
import { snapshotHash, type RecommendationPayload } from '@zcode-bot/core';
import { SnapshotService } from '../src/services/research.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';

const LEADER_A = 'LeaderA11111111111111111111111111111111111';
const LEADER_B = 'LeaderB11111111111111111111111111111111111';
const LEADER_C = 'LeaderC11111111111111111111111111111111111';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let snapshots: SnapshotService;
let lifecycle: TraderLifecycle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-rotation-'));
  handle = openDatabase(dir);
  migrate(handle.db, {
    migrationsFolder: resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      '..',
      '..',
      'packages',
      'db',
      'drizzle',
    ),
  });
  config = loadConfig({ SESSION_SECRET: 'x'.repeat(40) });
  snapshots = new SnapshotService(handle.db, dir, config.risk);
  // No engine: the flat path never needs to close anything.
  lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  for (const [cid, h, rank, addr] of [
    ['cand_ape', 'ape_vasco', 1, LEADER_A],
    ['cand_moon', 'moonpie_max', 2, LEADER_B],
    ['cand_star', 'star_gazer', 3, LEADER_C],
  ] as const) {
    repo.upsertCandidate(handle.db, {
      candidateId: cid,
      handle: h,
      weeklyRank: rank,
      displayedWeeklyPnlUsdMicro: '1000000000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(handle.db, cid, { chain: 'solana', address: addr, verification: 'reported' });
  }
  return snapshots.build();
}

function recommendation(
  snapshot: { snapshotId: string },
  ordered: Array<{ candidateId: string; rank: number }>,
  over: Partial<RecommendationPayload> = {},
): RecommendationPayload {
  const now = Date.now();
  return {
    schemaVersion: 1,
    recommendationId: crypto.randomUUID(),
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshotHash(snapshot as never),
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3 * 3600_000).toISOString(),
    researchSessionId: 'sess-rotation',
    modelLabel: 'deepseek-flash',
    orderedCandidates: ordered.map((c) => ({
      candidateId: c.candidateId,
      rank: c.rank,
      confidence: 0.6,
      thesis: 'rotation test',
      evidence: [],
      concerns: [],
    })),
    abstain: false,
    abstainReason: null,
    rotateIfFlat: true,
    ...over,
  };
}

function activateDirect(candidateId: string): string {
  const activationId = 'act_' + crypto.randomUUID();
  repo.createActivation(handle.db, {
    activationId,
    candidateId,
    state: 'ACTIVE',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'zcode_shortlist',
  });
  return activationId;
}

function openPosition(activationId: string, status = 'open') {
  repo.insertPosition(handle.db, {
    positionId: 'pos_' + crypto.randomUUID(),
    activationId,
    candidateId: 'cand_ape',
    mint: 'MintX',
    mintSymbol: 'X',
    status,
    entryIntentId: null,
    inputMint: 'USDC',
    inputUsdMicro: '1000000',
    copiedTokenBase: '1000',
    remainingTokenBase: status === 'requires_reconciliation' ? '0' : '1000',
    leaderTokenBase: '4000',
    realizedPnlUsdMicro: '0',
    feesUsdMicro: '0',
    openedAt: new Date().toISOString(),
    closedAt: null,
    closeReason: null,
  });
}

/** Rotation acts only within the post-refresh window; tests opt in explicitly. */
function markBoardRefreshed() {
  repo.kvSet(handle.db, 'board.refreshed_at', new Date().toISOString());
}

/** Seed one captured board scan (one observed_at group) with the given ranks. */
function seedScan(entries: Array<{ handle: string; rank: number }>) {
  const observedAt = new Date().toISOString();
  for (const e of entries) {
    repo.recordLeaderboardObservation(handle.db, {
      handle: e.handle,
      weeklyRank: e.rank,
      displayedPnlUsdMicro: null,
      source: 'test',
      observedAt,
    });
  }
}

function inFlightEntry(activationId: string) {
  repo.insertIntent(handle.db, {
    intentId: 'int_' + crypto.randomUUID(),
    kind: 'entry',
    mode: 'paper',
    activationId,
    candidateId: 'cand_ape',
    positionId: null,
    mint: 'MintY',
    inputMint: 'USDC',
    inputAmountBase: '1000',
    inputUsdMicro: '1000000',
    minOutputBase: null,
    slippageBps: null,
    priceImpactBps: null,
    state: 'confirmed',
    idempotencyKey: 'idem_' + crypto.randomUUID(),
    quoteJson: null,
    txSignature: null,
    reason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('flat-only rotation after a leaderboard refresh', () => {
  it('rotates a flat trader to the fresh ordering', async () => {
    const snap = seed();
    const oldId = activateDirect('cand_ape');
    markBoardRefreshed();
    const rec = recommendation(snap, [
      { candidateId: 'cand_moon', rank: 1 },
      { candidateId: 'cand_star', rank: 2 },
    ]);

    const result = await lifecycle.rotateIfFlat(rec);
    expect(result.rotated).toBe(true);

    expect(repo.getActivation(handle.db, oldId)?.state).toBe('FIRED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_moon');
  });

  it('skips when no board refresh is in the post-refresh window', async () => {
    const snap = seed();
    const activeId = activateDirect('cand_ape');
    const rec = recommendation(snap, [{ candidateId: 'cand_star', rank: 1 }]);

    // No board.refreshed_at marker at all.
    const absent = await lifecycle.rotateIfFlat(rec);
    expect(absent.rotated).toBe(false);
    expect(absent.reason).toBe('no fresh board refresh');

    // A marker older than the 45-minute window is equally stale.
    repo.kvSet(handle.db, 'board.refreshed_at', new Date(Date.now() - 60 * 60_000).toISOString());
    const expired = await lifecycle.rotateIfFlat(rec);
    expect(expired.rotated).toBe(false);
    expect(expired.reason).toBe('no fresh board refresh');
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('ACTIVE');
  });

  it('keeps the incumbent while it sits in the scan top-3', async () => {
    const snap = seed();
    const activeId = activateDirect('cand_ape');
    markBoardRefreshed();
    seedScan([
      { handle: 'other_trader', rank: 1 },
      { handle: 'ape_vasco', rank: 2 },
      { handle: 'moonpie_max', rank: 3 },
    ]);
    const rec = recommendation(snap, [
      { candidateId: 'cand_moon', rank: 1 },
      { candidateId: 'cand_star', rank: 2 },
    ]);

    const result = await lifecycle.rotateIfFlat(rec);

    expect(result.rotated).toBe(false);
    expect(result.reason).toBe('incumbent in board top-3');
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('ACTIVE');
  });

  it('rotates when the incumbent has left the latest scan (decay)', async () => {
    const snap = seed();
    const oldId = activateDirect('cand_ape');
    markBoardRefreshed();
    // Fresh scan: the incumbent is gone; the ordering entries are present.
    seedScan([
      { handle: 'moonpie_max', rank: 1 },
      { handle: 'star_gazer', rank: 2 },
    ]);
    const rec = recommendation(snap, [
      { candidateId: 'cand_moon', rank: 1 },
      { candidateId: 'cand_star', rank: 2 },
    ]);

    const result = await lifecycle.rotateIfFlat(rec);

    expect(result.rotated).toBe(true);
    expect(repo.getActivation(handle.db, oldId)?.state).toBe('FIRED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_moon');
  });

  it('refuses to rotate while a position is open', async () => {
    const snap = seed();
    const activeId = activateDirect('cand_ape');
    openPosition(activeId, 'open');
    markBoardRefreshed();

    const rec = recommendation(snap, [{ candidateId: 'cand_star', rank: 1 }]);
    const result = await lifecycle.rotateIfFlat(rec);

    expect(result.rotated).toBe(false);
    expect(result.reason).toBe('not flat');
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('ACTIVE');
  });

  it('treats a requires_reconciliation position as not flat', async () => {
    const snap = seed();
    const activeId = activateDirect('cand_ape');
    openPosition(activeId, 'requires_reconciliation');
    markBoardRefreshed();

    const rec = recommendation(snap, [{ candidateId: 'cand_star', rank: 1 }]);
    const result = await lifecycle.rotateIfFlat(rec);

    expect(result.rotated).toBe(false);
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('ACTIVE');
  });

  it('treats an in-flight entry intent as not flat', async () => {
    const snap = seed();
    const activeId = activateDirect('cand_ape');
    inFlightEntry(activeId);
    markBoardRefreshed();

    const rec = recommendation(snap, [{ candidateId: 'cand_star', rank: 1 }]);
    const result = await lifecycle.rotateIfFlat(rec);

    expect(result.rotated).toBe(false);
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('ACTIVE');
  });

  it('refuses to fire when no candidate on the fresh ordering is hireable', async () => {
    const snap = seed();
    const activeId = activateDirect('cand_ape');
    markBoardRefreshed();
    const rec = recommendation(snap, [{ candidateId: 'cand_missing', rank: 1 }]);
    const result = await lifecycle.rotateIfFlat(rec);

    expect(result.rotated).toBe(false);
    expect(result.reason).toBe('no hireable candidate');
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('ACTIVE');
  });

  it('is idempotent per recommendationId', async () => {
    const snap = seed();
    const activeId = activateDirect('cand_ape');
    markBoardRefreshed();
    const rec = recommendation(snap, [{ candidateId: 'cand_star', rank: 1 }]);

    const first = await lifecycle.rotateIfFlat(rec);
    const second = await lifecycle.rotateIfFlat(rec);

    expect(first.rotated).toBe(true);
    expect(second.rotated).toBe(false);
    expect(second.reason).toBe('already handled');
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('FIRED');
  });

  it('falls through to the next candidate when the first one cannot be activated', async () => {
    seed();
    const activeId = activateDirect('cand_ape');
    markBoardRefreshed();
    // cand_moon is disabled, so activation must skip it and use cand_star.
    // The snapshot must be rebuilt so eligibility sees the disabled flag.
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_moon',
      handle: 'moonpie_max',
      weeklyRank: 2,
      displayedWeeklyPnlUsdMicro: '1000000000',
      profileUrl: null,
      avatarUrl: null,
      enabled: false,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    const snap = snapshots.build();
    const rec = recommendation(snap, [
      { candidateId: 'cand_moon', rank: 1 },
      { candidateId: 'cand_star', rank: 2 },
    ]);

    const result = await lifecycle.rotateIfFlat(rec);

    expect(result.rotated).toBe(true);
    expect(repo.getActivation(handle.db, activeId)?.state).toBe('FIRED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_star');
  });
});
