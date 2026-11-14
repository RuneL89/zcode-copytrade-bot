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
import { TraderLifecycle } from '../src/services/lifecycle.js';
import { LeaderMonitor } from '../src/services/monitor.js';

const LEADER = 'LeaderA11111111111111111111111111111111111';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
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
  lifecycle = new TraderLifecycle(handle.db, config.risk, null);
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

function seedAndHire(stallHours: number, activityFreshHours: number, startedHoursAgo = stallHours): string {
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
    lastBuyAt: null,
    buys24h: 0,
    sells24h: 0,
    status: 'ok',
    checkedAt: new Date(Date.now() - activityFreshHours * 3600_000).toISOString(),
  });

  const activationId = 'act_' + crypto.randomUUID();
  repo.createActivation(handle.db, {
    activationId,
    candidateId: 'cand_ape',
    state: 'ACTIVE',
    startedAt: new Date(Date.now() - startedHoursAgo * 3600_000).toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'manual',
  });
  return activationId;
}

describe('stall watcher (8h, fresh evidence only)', () => {
  it('fires when the leader wallet is silent longer than the stall threshold', async () => {
    const activationId = seedAndHire(9, 1);
    await (monitor as unknown as { sweep: (a: string, n: Date) => Promise<void> }).sweep(
      activationId,
      new Date(),
    );
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('FIRED');
    expect(repo.listAudit(handle.db, 50).some((e) => e.message.includes('stall watcher'))).toBe(true);
  });

  it('does not fire while the leader traded within the threshold', async () => {
    const activationId = seedAndHire(7, 1);
    await (monitor as unknown as { sweep: (a: string, n: Date) => Promise<void> }).sweep(
      activationId,
      new Date(),
    );
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('ACTIVE');
  });

  it('does not fire a just-hired seat on an older activity sample when the funded buy is recent', async () => {
    const activationId = seedAndHire(11, 0.1, 5 / 60);
    repo.upsertWatchWallet(handle.db, {
      candidateId: 'cand_ape',
      address: LEADER,
      status: 'hired',
      reason: 'test',
    });
    repo.insertWatchEvent(handle.db, {
      candidateId: 'cand_ape',
      address: LEADER,
      signature: 'recent-buy',
      side: 'buy',
      mint: 'Mint111111111111111111111111111111111111111111',
      tokenAmountBase: '1',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: Math.floor(Date.now() / 1000) - 50 * 60,
      observedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      source: 'test',
    });
    await (monitor as unknown as { sweep: (a: string, n: Date) => Promise<void> }).sweep(
      activationId,
      new Date(),
    );
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('ACTIVE');
  });

  it('does not judge staleness from an out-of-date activity check', async () => {
    // Wallet silent 12h, but the last Helius check itself is 12h old — the
    // watcher must not act on evidence it cannot trust.
    const activationId = seedAndHire(12, 12);
    await (monitor as unknown as { sweep: (a: string, n: Date) => Promise<void> }).sweep(
      activationId,
      new Date(),
    );
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('ACTIVE');
  });
});

describe('a stall fire refills from the watching pool', () => {
  const MINT = 'Mint111111111111111111111111111111111111111111';

  function seedWatcher(id: string): void {
    repo.upsertCandidate(handle.db, {
      candidateId: id,
      handle: id,
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(handle.db, id, {
      chain: 'solana',
      address: `wallet-${id}`,
      verification: 'reported',
    });
    repo.upsertWatchWallet(handle.db, {
      candidateId: id,
      address: `wallet-${id}`,
      status: 'watching',
      reason: 'test',
    });
    repo.insertWatchEvent(handle.db, {
      candidateId: id,
      address: `wallet-${id}`,
      signature: `buy-${id}`,
      side: 'buy',
      mint: MINT,
      tokenAmountBase: '1',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: Math.floor(Date.now() / 1000) - 600,
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      source: 'test',
    });
    for (let i = 0; i < 8; i++) {
      const tradeId = repo.openShadowTrade(handle.db, {
        candidateId: id,
        mint: MINT,
        openedAt: new Date(Date.now() - (i + 2) * 3_600_000).toISOString(),
        entryPriceUsdMicro: '1000000',
        notionalUsdMicro: '5000000',
      });
      repo.closeShadowTrade(handle.db, tradeId, {
        closedAt: new Date(Date.now() - (i + 2) * 3_600_000 + 60_000).toISOString(),
        exitReason: 'leader_sell',
        exitPriceUsdMicro: '1000000',
        pnlUsdMicro: '1000000',
      });
    }
  }

  it('auto mode hires a qualified watcher into the freed seat', async () => {
    const activationId = seedAndHire(9, 1);
    seedWatcher('cand_next');
    const outcome = await lifecycle.fire(activationId, 'stall: leader inactive 9.0h');
    expect(outcome.status).toBe('ACTIVATED');
    expect(repo.getWatchWallet(handle.db, 'cand_next')?.status).toBe('hired');
    expect(repo.listActiveActivations(handle.db).some((row) => row.candidateId === 'cand_next')).toBe(true);
  });

  it('agent mode leaves the seat empty and posts the opening', async () => {
    const activationId = seedAndHire(9, 1);
    seedWatcher('cand_agent');
    const openings: string[] = [];
    lifecycle.hireApproval = 'agent';
    lifecycle.onSeatOpen = (event) => openings.push(event.activationId);
    const outcome = await lifecycle.fire(activationId, 'stall: leader inactive 9.0h');
    expect(outcome.status).toBe('NO_REPLACEMENT');
    expect(openings).toEqual([activationId]);
    expect(repo.getWatchWallet(handle.db, 'cand_agent')?.status).toBe('bench');
    expect(repo.getActivation(handle.db, activationId)?.state).toBe('FIRED');
    expect(repo.listActiveActivations(handle.db).some((row) => row.candidateId === 'cand_agent')).toBe(false);
  });
});
