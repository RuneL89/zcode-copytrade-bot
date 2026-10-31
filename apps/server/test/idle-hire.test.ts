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

describe('just-fired exclusion', () => {
  function seedScanTrader(candidateId: string, handleName: string, weeklyRank: number, observedAt: string) {
    repo.upsertCandidate(handle.db, {
      candidateId,
      handle: handleName,
      weeklyRank,
      displayedWeeklyPnlUsdMicro: '1000000000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt,
      pnl24hUsd: 1000,
      statsCheckedAt: observedAt,
      swaps24h: 19,
      lastSwapAt: new Date(Date.now() - 3600_000).toISOString(),
      activityCheckedAt: observedAt,
    });
    repo.upsertCandidateAddress(handle.db, candidateId, {
      chain: 'solana',
      address: handleName + 'Addr1111111111111111111111111111111',
      verification: 'verified',
    });
    repo.recordLeaderboardObservation(handle.db, {
      handle: handleName,
      weeklyRank,
      displayedPnlUsdMicro: '1000000000',
      source: 'test',
      observedAt,
    });
  }

  function insertFiredActivation(candidateId: string, endedAt = new Date().toISOString()) {
    repo.createActivation(handle.db, {
      activationId: 'act_' + crypto.randomUUID(),
      candidateId,
      state: 'FIRED',
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      endedAt,
      endReason: 'fired',
      lossStreak: 0,
      firedReason: 'idle: no open positions for 12h',
      source: 'zcode_shortlist',
    });
  }

  function ordering(entries: Array<{ candidateId: string; rank: number }>) {
    return {
      payload: {
        recommendationId: 'rec_' + crypto.randomUUID(),
        orderedCandidates: entries,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
  }

  it('the just-fired trader is not the immediate rehire, even when the fresh ordering ranks him first', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    insertFiredActivation('cand_jim');

    // The snapshot flags exactly the banned candidate.
    const snap = snapshots.build();
    expect(snap.candidates.find((c) => c.candidateId === 'cand_jim')!.justFired).toBe(true);
    expect(snap.candidates.find((c) => c.candidateId === 'cand_boardking')!.justFired).toBe(false);

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.latestValidRecommendation = ordering([{ candidateId: 'cand_jim', rank: 1 }]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('NO_CANDIDATE');
    expect(repo.activeActivation(handle.db)).toBeUndefined();

    const rejections = repo.listCandidateRejections(handle.db, 20);
    expect(rejections.some((r) => r.candidateId === 'cand_jim' && r.reason === 'JUST_FIRED')).toBe(true);
    expect(repo.listControlEvents(handle.db, 20).some((e) => e.type === 'research_request')).toBe(true);
  });

  it('skips the just-fired trader for the next candidate; the ban lifts once someone else holds the seat', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    seedScanTrader('cand_bob', 'bob', 3, observedAt);
    insertFiredActivation('cand_jim');

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_jim', rank: 1 },
      { candidateId: 'cand_bob', rank: 2 },
    ]);

    // Jim is rank 1 but just fired -> bob (rank 2) takes the seat.
    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_bob');
    const bob = repo.activeActivation(handle.db)!;

    // Jim's ban is lifted (bob holds the seat). Fire bob: the walk must skip
    // bob and may hire jim again.
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_bob', rank: 1 },
      { candidateId: 'cand_jim', rank: 2 },
    ]);
    await lifecycle.fire(bob.activationId, 'test: two losing units');
    expect(repo.getActivation(handle.db, bob.activationId)!.state).toBe('FIRED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_jim');

    // The seat was filled immediately by a different trader (jim took over in
    // the same handoff), so bob is an ordinary candidate again — nobody is
    // excluded right now. A persisting ban only exists when the handoff pauses.
    const snap2 = snapshots.build();
    expect(snap2.candidates.find((c) => c.candidateId === 'cand_jim')!.justFired).toBe(false);
    expect(snap2.candidates.find((c) => c.candidateId === 'cand_bob')!.justFired).toBe(false);
  });

  it('manual activation overrides the exclusion', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    insertFiredActivation('cand_jim');

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([{ candidateId: 'cand_jim', rank: 1 }]);
    expect((await lifecycle.coldStartHire()).status).toBe('NO_CANDIDATE');

    const manual = await lifecycle.activate('cand_jim', 'manual', true);
    expect(manual.ok).toBe(true);
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_jim');
  });
});
