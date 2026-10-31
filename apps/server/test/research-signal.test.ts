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
import { snapshotHash } from '@zcode-bot/core';
import { RecommendationService, SnapshotService } from '../src/services/research.js';

const LEADER = 'LeaderA11111111111111111111111111111111111';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let snapshots: SnapshotService;
let recommendations: RecommendationService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-signal-'));
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
  recommendations = new RecommendationService(handle.db, snapshots, config.risk);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function buildSnapshot() {
  repo.upsertCandidate(handle.db, {
    candidateId: 'cand_ape',
    handle: 'ape_vasco',
    weeklyRank: 1,
    displayedWeeklyPnlUsdMicro: '1000000000',
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt: new Date().toISOString(),
  });
  repo.upsertCandidateAddress(handle.db, 'cand_ape', {
    chain: 'solana',
    address: LEADER,
    verification: 'reported',
  });
  return snapshots.build();
}

function abstention(snapshot: { snapshotId: string }, reason: string) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    recommendationId: crypto.randomUUID(),
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshotHash(snapshot as never),
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3 * 3600_000).toISOString(),
    researchSessionId: 'sess-signal',
    modelLabel: 'deepseek-flash',
    orderedCandidates: [],
    abstain: true,
    abstainReason: reason,
  };
}

describe('POOL_STALE abstention raises a durable refresh request', () => {
  it('records a leaderboard_refresh_request control event', () => {
    const snap = buildSnapshot();
    const verdict = recommendations.ingest(
      abstention(snap, 'POOL_STALE: freshest observedAt 2026-10-28T06:32Z, 23/23 stale'),
    );

    expect(verdict.ok).toBe(true);
    const events = repo.listControlEvents(handle.db, 20);
    expect(events.some((e) => e.type === 'leaderboard_refresh_request')).toBe(true);
  });

  it('does not raise a request for a plain abstention', () => {
    const snap = buildSnapshot();
    const verdict = recommendations.ingest(abstention(snap, 'only one eligible candidate'));

    expect(verdict.ok).toBe(true);
    const events = repo.listControlEvents(handle.db, 20);
    expect(events.some((e) => e.type === 'leaderboard_refresh_request')).toBe(false);
  });
});

describe('snapshot freshness semantics', () => {
  it('reports the age of the NEWEST observation, plus oldest and stale count', () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    for (const [cid, h, addr, observedAt] of [
      ['cand_old', 'old_one', 'LeaderB11111111111111111111111111111111111', old],
      ['cand_new', 'new_one', 'LeaderC11111111111111111111111111111111111', fresh],
    ] as const) {
      repo.upsertCandidate(handle.db, {
        candidateId: cid,
        handle: h,
        weeklyRank: 1,
        displayedWeeklyPnlUsdMicro: '1000000',
        profileUrl: null,
        avatarUrl: null,
        enabled: true,
        source: 'test',
        observedAt,
      });
      repo.upsertCandidateAddress(handle.db, cid, {
        chain: 'solana',
        address: addr,
        verification: 'reported',
      });
    }

    const snap = snapshots.build();

    expect(snap.sourceFreshnessSeconds).toBeLessThan(300);
    expect(snap.staleCandidateCount).toBe(1);
    expect(Date.parse(snap.oldestObservedAt ?? '')).toBe(Date.parse(old));
  });

  it('does not count a stale-observation candidate as stale when its wallet activity is fresh', () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_old',
      handle: 'old_one',
      weeklyRank: 1,
      displayedWeeklyPnlUsdMicro: '1000000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: old,
    });
    // Helius re-verified this wallet an hour ago: the candidate stays usable
    // even though its leaderboard observation is 30h old.
    repo.updateCandidateActivity(handle.db, 'cand_old', {
      swaps24h: 12,
      lastSwapAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      lastBuyAt: null,
      checkedAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    repo.upsertCandidateAddress(handle.db, 'cand_old', {
      chain: 'solana',
      address: 'LeaderB11111111111111111111111111111111111',
      verification: 'reported',
    });
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_new',
      handle: 'new_one',
      weeklyRank: 2,
      displayedWeeklyPnlUsdMicro: '1000000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: fresh,
    });
    repo.upsertCandidateAddress(handle.db, 'cand_new', {
      chain: 'solana',
      address: 'LeaderC11111111111111111111111111111111111',
      verification: 'reported',
    });

    const snap = snapshots.build();

    expect(snap.staleCandidateCount).toBe(0);
    expect(snap.oldestObservedAt).toBe(old);
  });
});
