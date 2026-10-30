import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig } from '@zcode-bot/config';
import { SnapshotService } from '../src/services/research.js';
import { RecommendationService } from '../src/services/research.js';
import { ControlService } from '../src/services/control.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';
import { StateBuilder } from '../src/services/builder.js';

/**
 * The post-fire pause loop: after a fire the bot must NOT hire from an
 * ordering that predates the newest board scan — it pauses, leaves a
 * research_request signal for the sweep, and the validated fresh ordering
 * auto-hires the best candidate. These tests pin the guard, the audit
 * evidence it writes, and the dashboard payload that displays the loop.
 */

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let snapshots: SnapshotService;
let control: ControlService;
let recommendations: RecommendationService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-hiring-pause-'));
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
  control = new ControlService(handle.db);
  recommendations = new RecommendationService(handle.db, snapshots, config.risk);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedBoardCandidate(observedAt: string) {
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
}

/** Persist a validated ordering with an explicit createdAt (ISO). */
function seedRecommendation(recommendationId: string, createdAt: string) {
  repo.saveRecommendation(
    handle.db,
    {
      recommendationId,
      snapshotId: 'snap_test',
      snapshotHash: '0'.repeat(64),
      createdAt,
      receivedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 6 * 3600_000).toISOString(),
      modelLabel: 'test-model',
      researchSessionId: null,
      abstain: false,
      abstainReason: null,
      status: 'validated',
      validationError: null,
      rawJson: '{}',
      normalizedJson: JSON.stringify({
        recommendationId,
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.parse(createdAt) + 6 * 3600_000).toISOString(),
      }),
    },
    [{ recommendationId, candidateId: 'cand_boardking', rank: 1, confidence: '0.9', thesis: 't', concernsJson: '[]', evidenceJson: '[]' }],
  );
}

function setActiveActivation(activationId: string, candidateId: string) {
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
}

function makeLifecycle(): TraderLifecycle {
  return new TraderLifecycle(handle.db, config.risk, null, snapshots);
}

function researchRequestCount(): number {
  return repo
    .listControlEvents(handle.db, 50)
    .filter((e) => e.type === 'research_request').length;
}

describe('ordering-freshness pause after a fire', () => {
  it('stale ordering: fire pauses with fresh-research evidence instead of hiring', async () => {
    const scanAt = new Date().toISOString();
    seedBoardCandidate(scanAt);
    snapshots.build();
    seedRecommendation('rec_stale', new Date(Date.now() - 30 * 60_000).toISOString()); // predates scan
    const lifecycle = makeLifecycle();
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_stale',
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    setActiveActivation('act_stale', 'cand_firedguy');
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_firedguy',
      handle: 'firedguy',
      weeklyRank: 2,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: scanAt,
    });

    const outcome = await lifecycle.fire('act_stale', 'rank: test fire');

    expect(outcome.status).toBe('PAUSED_WAITING_FOR_ZCODE');
    // No rehire: the only activation is the fired one, now FIRED.
    expect(repo.activeActivation(handle.db)).toBeUndefined();
    expect(repo.getActivation(handle.db, 'act_stale')?.state).toBe('FIRED');
    // Handoff event carries the pause + reason for the dashboard.
    const handoff = repo.listHandoffEvents(handle.db, 5)[0]!;
    expect(handoff.status).toBe('paused_for_fresh_research');
    expect(handoff.detail).toContain('predates the latest scan');
    // The firing event records how the handoff ended.
    const firing = repo.latestFiringEventForActivation(handle.db, 'act_stale');
    expect(firing?.handoffStatus).toBe('paused_for_fresh_research');
    // The sweep gets a research_request signal.
    expect(researchRequestCount()).toBe(1);
  });

  it('fresh ordering (postdates the scan): fire activates the top candidate', async () => {
    const scanAt = new Date(Date.now() - 60_000).toISOString();
    seedBoardCandidate(scanAt);
    snapshots.build();
    seedRecommendation('rec_fresh', new Date().toISOString()); // postdates scan
    const lifecycle = makeLifecycle();
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_fresh',
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    setActiveActivation('act_fresh', 'cand_firedguy');
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_firedguy',
      handle: 'firedguy',
      weeklyRank: 2,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: scanAt,
    });

    const outcome = await lifecycle.fire('act_fresh', 'rank: test fire');

    expect(outcome.status).toBe('ACTIVATED');
    expect(outcome.candidateId).toBe('cand_boardking');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_boardking');
    const handoff = repo.listHandoffEvents(handle.db, 5)[0]!;
    expect(handoff.status).toBe('activated');
    expect(repo.latestFiringEventForActivation(handle.db, 'act_fresh')?.handoffStatus).toBe('activated');
  });

  it('stale board scan: the guard stands down and a predating ordering is still spent', async () => {
    const scanAt = new Date(Date.now() - 3 * 3600_000).toISOString(); // older than SCAN_FRESH_MS (2h)
    seedBoardCandidate(scanAt);
    snapshots.build();
    seedRecommendation('rec_old', new Date(Date.now() - 2.5 * 3600_000).toISOString());
    const lifecycle = makeLifecycle();
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_old',
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    setActiveActivation('act_stalescan', 'cand_firedguy');
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_firedguy',
      handle: 'firedguy',
      weeklyRank: 2,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: scanAt,
    });

    const outcome = await lifecycle.fire('act_stalescan', 'rank: test fire');

    // A broken capture pipeline must not freeze hiring forever.
    expect(outcome.status).toBe('ACTIVATED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_boardking');
  });
});

describe('idle hire deferral signals the sweep once per scan', () => {
  it('deferred idle hire writes exactly one research_request per scan', async () => {
    const scanAt = new Date().toISOString();
    seedBoardCandidate(scanAt);
    snapshots.build();
    seedRecommendation('rec_idle_stale', new Date(Date.now() - 30 * 60_000).toISOString());
    const lifecycle = makeLifecycle();
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_idle_stale',
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };

    // The idle-hire path runs on every state rebuild while paused.
    const first = await lifecycle.coldStartHire();
    const second = await lifecycle.coldStartHire();
    const third = await lifecycle.coldStartHire();

    expect(first.status).toBe('NO_CANDIDATE');
    expect(second.status).toBe('NO_CANDIDATE');
    expect(third.status).toBe('NO_CANDIDATE');
    expect(repo.activeActivation(handle.db)).toBeUndefined();
    expect(researchRequestCount()).toBe(1); // throttled: one per scan, not per rebuild
  });
});

describe('dashboard payload exposes the hiring loop', () => {
  it('paused state surfaces pausedForResearch, the reason, and the research request', async () => {
    const scanAt = new Date().toISOString();
    seedBoardCandidate(scanAt);
    snapshots.build();
    seedRecommendation('rec_ui', new Date(Date.now() - 30 * 60_000).toISOString());
    const lifecycle = makeLifecycle();
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_ui',
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    setActiveActivation('act_ui', 'cand_firedguy');
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_firedguy',
      handle: 'firedguy',
      weeklyRank: 2,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: scanAt,
    });
    await lifecycle.fire('act_ui', 'rank: left the board');

    const builder = new StateBuilder(
      handle.db,
      { mode: 'paper', risk: config.risk } as never,
      control,
      null,
      recommendations,
      lifecycle,
      120_000_000n,
    );
    const s = builder.build();

    expect(s.appState).toBe('PAUSED_WAITING_FOR_ZCODE');
    expect(s.hiring.pausedForResearch).toBe(true);
    expect(s.hiring.autoResume).toBe(true);
    expect(s.hiring.researchRequested).toBe(true);
    expect(s.hiring.reason).toContain('predates the latest scan');
    expect(s.hiring.latestScanAt).toBe(scanAt);
    expect(s.hiring.recommendationAt).toBeTruthy();
    // Fresh handoff event (seconds old) drives the fired overlay.
    expect(s.handoff?.phase).toBe('PAUSED_FOR_FRESH_RESEARCH');
    expect(s.handoff?.fromHandle).toBe('firedguy');
    expect(s.handoff?.fromReason).toBe('rank: left the board');
  });

  it('active trader: hiring block reports no pause', async () => {
    const scanAt = new Date().toISOString();
    seedBoardCandidate(scanAt);
    snapshots.build();
    setActiveActivation('act_running', 'cand_boardking');

    const builder = new StateBuilder(
      handle.db,
      { mode: 'paper', risk: config.risk } as never,
      control,
      null,
      recommendations,
      makeLifecycle(),
      120_000_000n,
    );
    const s = builder.build();

    expect(s.appState).toBe('RUNNING');
    expect(s.hiring.pausedForResearch).toBe(false);
    expect(s.hiring.reason).toBeNull();
    expect(s.hiring.latestScanAt).toBe(scanAt);
    expect(s.handoff).toBeNull();
  });
});
