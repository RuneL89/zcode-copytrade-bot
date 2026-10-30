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
import { SnapshotService } from '../src/services/research.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let snapshots: SnapshotService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-hire-guards-'));
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
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedScanCandidate() {
  const observedAt = new Date().toISOString();
  repo.upsertCandidate(handle.db, {
    candidateId: 'cand_boardking',
    handle: 'boardking',
    weeklyRank: 1,
    displayedWeeklyPnlUsdMicro: '262897540000',
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt,
    pnl24hUsd: 262897.54,
    statsCheckedAt: observedAt,
    swaps24h: 19,
    lastSwapAt: new Date(Date.now() - 3600_000).toISOString(),
    activityCheckedAt: observedAt,
  });
  repo.upsertCandidateAddress(handle.db, 'cand_boardking', {
    chain: 'solana',
    address: 'BoardKing1111111111111111111111111111111',
    verification: 'verified',
  });
  repo.recordLeaderboardObservation(handle.db, {
    handle: 'boardking',
    weeklyRank: 1,
    displayedPnlUsdMicro: '262897540000',
    source: 'test',
    observedAt,
  });
  return observedAt;
}

describe('snapshot exposes the latest scan', () => {
  it('carries latestScan handles so the researcher can rank board-first', () => {
    seedScanCandidate();
    const snap = snapshots.build();
    expect(snap.latestScan).not.toBeNull();
    expect(snap.latestScan!.handles).toEqual(['boardking']);
    expect(snap.latestScan!.observedAt).toBe(snap.candidates[0]!.observedAt);
  });

  it('latestScan is null before any scan exists', () => {
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_x',
      handle: 'x',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    const snap = snapshots.build();
    expect(snap.latestScan).toBeNull();
  });
});

describe('idle hire guards', () => {
  it('hires from a validated ordering when idle', async () => {
    seedScanCandidate();
    const snap = snapshots.build();
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_' + crypto.randomUUID(),
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_boardking');
    expect(snap).toBeTruthy();
  });

  it('refuses to hire while a fire is stuck in reconciliation', async () => {
    seedScanCandidate();
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_' + crypto.randomUUID(),
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    repo.createActivation(handle.db, {
      activationId: 'act_' + crypto.randomUUID(),
      candidateId: 'cand_pointfarmcap',
      state: 'REQUIRES_RECONCILIATION',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: 'rank: left the board',
      source: 'zcode_shortlist',
    });

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('IDLE');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_pointfarmcap');
  });
});
