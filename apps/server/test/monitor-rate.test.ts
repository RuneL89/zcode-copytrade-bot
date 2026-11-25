import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig } from '@zcode-bot/config';
import { TraderLifecycle } from '../src/services/lifecycle.js';
import { LeaderMonitor } from '../src/services/monitor.js';
import { ControlService } from '../src/services/control.js';

/**
 * The velocity fire (incident 2026-11-25, Qwerty54321: 549 leader events in
 * 10.1 min stopped the whole desk through credit burn):
 * - a seat whose observed-event count over 10 minutes crosses
 *   LEADER_MAX_EVENTS_PER_10MIN is fired on that tick;
 * - a seat inside the ceiling is never fired.
 */

const LEADER = 'LeaderRate111111111111111111111111111111111';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let lifecycle: TraderLifecycle;
let monitor: LeaderMonitor;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-rate-'));
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
  config.risk.LEADER_MAX_EVENTS_PER_10MIN = 100;
  lifecycle = new TraderLifecycle(handle.db, config.risk, null);
  monitor = new LeaderMonitor(
    handle.db,
    {} as never,
    null as never,
    config.risk,
    lifecycle,
    () => {},
    45_000,
    () => null,
  );
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedHire(): string {
  const observedAt = new Date().toISOString();
  repo.upsertCandidate(handle.db, {
    candidateId: 'cand_rate',
    handle: 'ratebot',
    weeklyRank: 1,
    displayedWeeklyPnlUsdMicro: '1000000',
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt,
  });
  repo.upsertCandidateAddress(handle.db, 'cand_rate', {
    chain: 'solana',
    address: LEADER,
    verification: 'verified',
  });
  const activationId = 'act_rate';
  repo.createActivation(handle.db, {
    activationId,
    candidateId: 'cand_rate',
    state: 'ACTIVE',
    startedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'watch_promotion',
  });
  repo.upsertWatchWallet(handle.db, {
    candidateId: 'cand_rate',
    address: LEADER,
    status: 'hired',
    reason: 'hired into the roster',
  });
  return activationId;
}

function seedEvents(activationId: string, count: number, withinLastMinutes = 5): void {
  const nowSec = Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i++) {
    repo.insertObservedEvent(handle.db, {
      dedupeKey: `evt_${activationId}_${i}_${Math.random().toString(36).slice(2)}`,
      activationId,
      candidateId: 'cand_rate',
      address: LEADER,
      signature: `sig_${i}_${Math.random().toString(36).slice(2)}`,
      slot: 1000 + i,
      transactionIndex: 0,
      blockTime: nowSec - Math.floor((Math.random() * withinLastMinutes * 60) / 2),
      kind: 'swap_buy',
      skipReason: null,
      detailJson: '{}',
      rawRef: null,
      parserVersion: 'test',
      processedAt: new Date(
        nowSec * 1000 - Math.floor((Math.random() * withinLastMinutes * 60) / 2) * 1000,
      ).toISOString(),
    });
  }
}

describe('velocity fire — an event machine on a chair (incident 2026-11-25)', () => {
  it('fires a seat whose 10-minute event count crosses the ceiling', async () => {
    const activationId = seedHire();
    seedEvents(activationId, 140);

    await monitor.tick(new Date());

    const act = repo.getActivation(handle.db, activationId)!;
    expect(act.state).toBe('FIRED');
    expect(act.firedReason).toContain('event rate over ceiling');
    expect(act.firedReason).toContain('140 events in 10 min');
    expect(repo.getWatchWallet(handle.db, 'cand_rate')?.status).toBe('cooling');
  });

  it('never fires a seat inside the ceiling', async () => {
    const activationId = seedHire();
    seedEvents(activationId, 40);

    await monitor.tick(new Date());

    const act = repo.getActivation(handle.db, activationId)!;
    expect(act.state).toBe('ACTIVE');
    expect(repo.listAudit(handle.db, 30).some((row) => row.message.includes('rate watcher'))).toBe(false);
  });
});
