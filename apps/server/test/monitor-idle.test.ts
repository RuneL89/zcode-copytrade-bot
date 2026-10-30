import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig } from '@zcode-bot/config';
import type { DashboardState } from '../src/services/state.js';
import { SnapshotService } from '../src/services/research.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';
import { LeaderMonitor } from '../src/services/monitor.js';
import { StateBuilder } from '../src/services/builder.js';
import { ControlService } from '../src/services/control.js';
import { RecommendationService } from '../src/services/research.js';

/**
 * The idle → fire → research → hire pipeline:
 * - the idle fire lands on the monitor tick that crosses the deadline, not on
 *   the next hourly discipline sweep (the dashboard countdown must mean it);
 * - the dashboard payload carries one explicit stage per step so the same box
 *   that shows the countdown can show the handoff after the fire.
 */

const LEADER = 'LeaderA11111111111111111111111111111111111';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let snapshots: SnapshotService;
let lifecycle: TraderLifecycle;
let monitor: LeaderMonitor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-idle-'));
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
  config.risk.IDLE_FIRE_HOURS = 6;
  snapshots = new SnapshotService(handle.db, dir, config.risk);
  lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
  monitor = new LeaderMonitor(
    handle.db,
    {} as never,
    null as never,
    config.risk,
    lifecycle,
    () => {},
    8000,
    () => null,
  );
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedHire(startedHoursAgo: number, withPosition = false): string {
  const observedAt = new Date().toISOString();
  repo.upsertCandidate(handle.db, {
    candidateId: 'cand_idler',
    handle: 'idler',
    weeklyRank: 1,
    displayedWeeklyPnlUsdMicro: '1000000',
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt,
  });
  repo.upsertCandidateAddress(handle.db, 'cand_idler', {
    chain: 'solana',
    address: LEADER,
    verification: 'reported',
  });
  snapshots.build();
  const activationId = 'act_idle_' + Math.random().toString(36).slice(2, 8);
  repo.createActivation(handle.db, {
    activationId,
    candidateId: 'cand_idler',
    state: 'ACTIVE',
    startedAt: new Date(Date.now() - startedHoursAgo * 3_600_000).toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'zcode_shortlist',
  });
  if (withPosition) {
    repo.insertPosition(handle.db, {
      positionId: 'pos_idle_' + Math.random().toString(36).slice(2, 8),
      activationId,
      candidateId: 'cand_idler',
      mint: 'Meow111111111111111111111111111111111111111',
      mintSymbol: 'MEOW',
      status: 'open',
      entryIntentId: null,
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inputUsdMicro: '1000000',
      copiedTokenBase: '1000',
      remainingTokenBase: '1000',
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: '1000',
      openedAt: new Date().toISOString(),
      closedAt: null,
      closeReason: null,
    });
  }
  return activationId;
}

describe('idle fire runs on every monitor tick', () => {
  it('fires the flat hire the moment the deadline has passed, hourly sweep or not', async () => {
    const activationId = seedHire(7); // 7h idle, limit 6h
    // Pretend the hourly discipline sweep just ran: the idle fire must not wait.
    (monitor as unknown as { lastSweepCheckAt: number }).lastSweepCheckAt = Date.now();

    await monitor.tick(new Date());

    expect(repo.getActivation(handle.db, activationId)?.state).toBe('FIRED');
    expect(repo.activeActivation(handle.db)).toBeUndefined();
  });

  it('does not fire while the timer still has time left', async () => {
    const activationId = seedHire(5); // 5h idle, limit 6h
    (monitor as unknown as { lastSweepCheckAt: number }).lastSweepCheckAt = Date.now();

    await monitor.tick(new Date());

    expect(repo.getActivation(handle.db, activationId)?.state).toBe('ACTIVE');
  });

  it('does not fire while a position is held', async () => {
    const activationId = seedHire(9, true);
    (monitor as unknown as { lastSweepCheckAt: number }).lastSweepCheckAt = Date.now();

    await monitor.tick(new Date());

    expect(repo.getActivation(handle.db, activationId)?.state).toBe('ACTIVE');
  });
});

describe('pipeline stage in the dashboard payload', () => {
  function builder(): StateBuilder {
    return new StateBuilder(
      handle.db,
      { mode: 'paper', risk: config.risk } as never,
      new ControlService(handle.db),
      null,
      new RecommendationService(handle.db, snapshots, config.risk),
      lifecycle,
      120_000_000n,
    );
  }

  it('IDLE_COUNTDOWN while a flat hire counts down, with the deadline', async () => {
    seedHire(1);
    const s: DashboardState = builder().build();
    expect(s.hiring.stage).toBe('IDLE_COUNTDOWN');
    expect(s.hiring.idleFireAtIso).toBeTruthy();
    expect(Date.parse(s.hiring.idleFireAtIso!)).toBeGreaterThan(Date.now());
  });

  it('HIRED with no deadline while a position is open', async () => {
    seedHire(2, true);
    const s = builder().build();
    expect(s.hiring.stage).toBe('HIRED');
    expect(s.hiring.idleFireAtIso).toBeNull();
  });

  it('FIRED, then RESEARCH_REQUESTED, then RESEARCH_RUNNING after a pause', async () => {
    const activationId = seedHire(8);
    repo.updateActivation(handle.db, activationId, {
      state: 'FIRED',
      endedAt: new Date().toISOString(),
      endReason: 'fired',
    });
    repo.insertHandoffEvent(handle.db, {
      fromCandidateId: 'cand_idler',
      toCandidateId: null,
      status: 'paused_for_fresh_research',
      recommendationId: null,
      source: 'zcode_shortlist',
      detail: 'ordering written 2026-10-30T12:36:07.132Z predates the latest scan 2026-10-30T13:05:12.703Z',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    let s = builder().build();
    expect(s.hiring.stage).toBe('FIRED');
    expect(s.hiring.firedAt).toBeTruthy();
    expect(s.hiring.pausedForResearch).toBe(true);

    repo.controlEvent(handle.db, 'research_request', 'ordering predates the latest scan', 'worker');
    s = builder().build();
    expect(s.hiring.stage).toBe('RESEARCH_REQUESTED');
    expect(s.hiring.researchRequested).toBe(true);
    expect(s.hiring.researchDispatched).toBe(false);

    repo.controlEvent(handle.db, 'research_dispatched', 'dispatcher started the run', 'worker');
    s = builder().build();
    expect(s.hiring.stage).toBe('RESEARCH_RUNNING');
    expect(s.hiring.researchDispatched).toBe(true);
  });
});
