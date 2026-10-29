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
import { LeaderMonitor } from '../src/services/monitor.js';

const LEADER = 'LeaderA11111111111111111111111111111111111';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let snapshots: SnapshotService;
let lifecycle: TraderLifecycle;
let monitor: LeaderMonitor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-stall-'));
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
  lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
  monitor = new LeaderMonitor(
    handle.db,
    {} as never, // the sweep path under test never touches Helius
    null as never, // time exits are not exercised here (positions are minutes old)
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

function seedAndHire(stallHours: number, activityFreshHours: number): string {
  repo.upsertCandidate(handle.db, {
    candidateId: 'cand_ape',
    handle: 'ape_vasco',
    weeklyRank: 1,
    displayedWeeklyPnlUsdMicro: '1000000',
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
  repo.updateCandidateActivity(handle.db, 'cand_ape', {
    swaps24h: 12,
    lastSwapAt: new Date(Date.now() - stallHours * 3600_000).toISOString(),
    checkedAt: new Date(Date.now() - activityFreshHours * 3600_000).toISOString(),
  });
  snapshots.build();

  const activationId = 'act_' + crypto.randomUUID();
  repo.createActivation(handle.db, {
    activationId,
    candidateId: 'cand_ape',
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

describe('stall watcher (8h, fresh evidence only)', () => {
  it('fires when the leader wallet is silent longer than the stall threshold', async () => {
    const activationId = seedAndHire(9, 1);
    await (monitor as unknown as { sweep: (a: string, s: string, n: Date) => Promise<void> }).sweep(
      activationId,
      new Date().toISOString(),
      new Date(),
    );
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('FIRED');
    expect(repo.listAudit(handle.db, 50).some((e) => e.message.includes('stall watcher'))).toBe(true);
  });

  it('does not fire while the leader traded within the threshold', async () => {
    const activationId = seedAndHire(7, 1);
    await (monitor as unknown as { sweep: (a: string, s: string, n: Date) => Promise<void> }).sweep(
      activationId,
      new Date().toISOString(),
      new Date(),
    );
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('ACTIVE');
  });

  it('does not judge staleness from an out-of-date activity check', async () => {
    // Wallet silent 12h, but the last Helius check itself is 12h old — the
    // watcher must not act on evidence it cannot trust.
    const activationId = seedAndHire(12, 12);
    await (monitor as unknown as { sweep: (a: string, s: string, n: Date) => Promise<void> }).sweep(
      activationId,
      new Date().toISOString(),
      new Date(),
    );
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('ACTIVE');
  });
});
