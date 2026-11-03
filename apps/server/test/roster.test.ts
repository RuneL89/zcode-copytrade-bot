import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type RiskConfig } from '@zcode-bot/config';
import { TraderLifecycle } from '../src/services/lifecycle.js';
import type { CopyEngine } from '../src/services/engine.js';

/**
 * D4/plan 05 roster rules: ROSTER_SIZE chairs sharing one budget pool, a fire
 * frees exactly one chair, the promotion queue fills them, an empty chair is
 * acceptable, and a stuck reconciliation freezes only its own seat.
 */

let dir: string;
let handle: DbHandle;
let risk: RiskConfig;

const TOKEN = 'RosterMint11111111111111111111111111111111111111';

function riskConfig(over: Partial<RiskConfig> = {}): RiskConfig {
  return { ...loadConfig({ SESSION_SECRET: 'r'.repeat(48) }).risk, ...over };
}

/** A lifecycle with a stubbed engine: headroom + the close-out a fire performs. */
function lifecycleFor(config: RiskConfig, headroomUsdMicro = 1_000_000_000n): TraderLifecycle {
  const engine = {
    headroomUsdMicro: () => headroomUsdMicro,
    closeAllForActivation: async () => ({ closed: 0, unknown: 0, failed: 0 }),
    closePosition: async () => 'closed',
  } as unknown as CopyEngine;
  return new TraderLifecycle(handle.db, config, engine, null as never);
}

let counter = 0;
function seedCandidateWithWallet(handleName: string): string {
  const candidateId = `cand_roster_${counter++}_${handleName}`;
  repo.upsertCandidate(handle.db, {
    candidateId,
    handle: handleName,
    weeklyRank: null,
    displayedWeeklyPnlUsdMicro: null,
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt: new Date().toISOString(),
  });
  repo.upsertCandidateAddress(handle.db, candidateId, {
    chain: 'solana',
    address: `Wallet${handleName}`,
    verification: 'reported',
  });
  return candidateId;
}

/** Put a wallet on the bench with a closed shadow record (the promotion queue). */
function seedBench(handleName: string, netPerTrade = 2_000_000n, closed = 8): string {
  const candidateId = seedCandidateWithWallet(handleName);
  repo.upsertWatchWallet(handle.db, {
    candidateId,
    address: `Wallet${handleName}`,
    status: 'promoted',
    reason: 'test bench',
  });
  // A bench wallet is only hirable while its last funded buy is fresh (4h).
  repo.insertWatchEvent(handle.db, {
    candidateId,
    address: `Wallet${handleName}`,
    signature: `seed-buy-${handleName}`,
    side: 'buy',
    mint: TOKEN,
    tokenAmountBase: '6000000',
    decimals: 6,
    usdMicro: '6000000',
    blockTime: Math.floor(Date.now() / 1000) - 600,
    observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    source: 'test',
  });
  for (let i = 0; i < closed; i++) {
    const id = repo.openShadowTrade(handle.db, {
      candidateId,
      mint: TOKEN,
      openedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      entryPriceUsdMicro: '1000000',
      notionalUsdMicro: '5000000',
    });
    repo.closeShadowTrade(handle.db, id, {
      closedAt: new Date(Date.now() - (i + 1) * 3_600_000 + 60_000).toISOString(),
      exitReason: 'leader_sell',
      exitPriceUsdMicro: '1000000',
      pnlUsdMicro: netPerTrade.toString(),
    });
  }
  return candidateId;
}

/** Every test starts from an empty roster and an empty bench. */
function reset(): void {
  for (const a of repo.listActiveActivations(handle.db)) {
    repo.updateActivation(handle.db, a.activationId, {
      state: 'FIRED',
      endedAt: new Date().toISOString(),
      endReason: 'test reset',
    });
  }
  for (const w of repo.listWatchWallets(handle.db, 'promoted')) {
    repo.setWatchStatus(handle.db, w.candidateId, 'archived', 'test reset');
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-roster-'));
  handle = openDatabase(dir);
  const migrationsFolder = resolve(
    fileURLToPath(new URL('..', import.meta.url)),
    '..',
    '..',
    'packages',
    'db',
    'drizzle',
  );
  void migrationsFolder;
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
  risk = riskConfig();
});

beforeEach(() => reset());

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('roster chairs (AC1/AC4)', () => {
  it('fills ROSTER_SIZE chairs and refuses the next with NO_SLOT', async () => {
    const config = riskConfig({ ROSTER_SIZE: 3 });
    const lifecycle = lifecycleFor(config);
    for (let i = 0; i < 3; i++) {
      const candidateId = seedCandidateWithWallet(`chair_${i}`);
      const result = await lifecycle.activate(candidateId, 'manual', false);
      expect(result.ok).toBe(true);
    }
    expect(repo.activeActivationCount(handle.db)).toBe(3);
    const refused = await lifecycle.activate(seedCandidateWithWallet('chair_extra'), 'manual', false);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/NO_SLOT/);
    expect(repo.freeRosterSlots(handle.db, 3)).toBe(0);
  });

  it('a REQUIRES_RECONCILIATION chair is occupied but the others keep trading', async () => {
    // Self-contained: three chairs of its own, one of which gets stuck.
    const config = riskConfig({ ROSTER_SIZE: 3 });
    const lifecycle = lifecycleFor(config);
    for (let i = 0; i < 3; i++) {
      const result = await lifecycle.activate(seedCandidateWithWallet(`stuck_${i}`), 'manual', false);
      expect(result.ok).toBe(true);
    }
    const stuck = repo.listActiveActivations(handle.db)[0]!;
    repo.updateActivation(handle.db, stuck.activationId, { state: 'REQUIRES_RECONCILIATION' });
    expect(repo.activeActivationCount(handle.db)).toBe(3);
    // The other two chairs are untouched.
    const stillActive = repo.listActiveActivations(handle.db).filter((a) => a.state === 'ACTIVE');
    expect(stillActive).toHaveLength(2);
    // Fire one of them: the queue fills that single chair.
    const bench = seedBench('bench_one');
    const fired = await lifecycle.fire(stillActive[0]!.activationId, 'manual test fire');
    expect(fired.status).toBe('ACTIVATED');
    expect(repo.getWatchWallet(handle.db, bench)?.status).toBe('hired'); // in the roster, off the bench
    const active = repo.listActiveActivations(handle.db);
    expect(active).toHaveLength(3); // the stuck one + the surviving one + the new hire
    expect(active.some((a) => a.candidateId === bench)).toBe(true);
    expect(active.some((a) => a.state === 'REQUIRES_RECONCILIATION')).toBe(true);
    // Cleanup for the next tests: leave the roster in a known state.
    for (const a of repo.listActiveActivations(handle.db)) {
      repo.updateActivation(handle.db, a.activationId, {
        state: 'FIRED',
        endedAt: new Date().toISOString(),
        endReason: 'test',
      });
    }
  });
});

describe('promotion queue fills the chairs (AC2/AC3/AC5)', () => {
  it('fillRoster hires the best bench record first and stops when full', async () => {
    const weaker = seedBench('bench_weak', 1_000_000n);
    const stronger = seedBench('bench_strong', 5_000_000n);
    const lifecycle = lifecycleFor(riskConfig({ ROSTER_SIZE: 2 }));
    const filled = await lifecycle.fillRoster();
    expect(filled.hired, `fillRoster: ${filled.reason}`).toHaveLength(2);
    expect(filled.hired[0]).toBe(stronger); // best net shadow record first
    expect(filled.hired[1]).toBe(weaker);
    expect(repo.activeActivationCount(handle.db)).toBe(2);
    for (const a of repo.listActiveActivations(handle.db)) {
      repo.updateActivation(handle.db, a.activationId, {
        state: 'FIRED',
        endedAt: new Date().toISOString(),
        endReason: 'test',
      });
    }
  });

  it('an empty queue leaves the chair empty, without an error', async () => {
    // Take every bench wallet out of the queue.
    for (const wallet of repo.listWatchWallets(handle.db, 'promoted')) {
      repo.setWatchStatus(handle.db, wallet.candidateId, 'archived', 'test cleanup');
    }
    const lifecycle = lifecycleFor(riskConfig({ ROSTER_SIZE: 3 }));
    const filled = await lifecycle.fillRoster();
    expect(filled.hired).toEqual([]);
    expect(filled.reason).toMatch(/no promotable wallet/);
    expect(repo.activeActivationCount(handle.db)).toBe(0);
  });

  it('hires on record alone: zero capital headroom is not a reason to refuse (operator decision)', async () => {
    const candidateId = seedBench('bench_headroom');
    // The deployed cap is already reached; the chair must still be filled so the
    // leader copies as soon as room frees (entries stay capped meanwhile).
    const lifecycle = lifecycleFor(riskConfig({ ROSTER_SIZE: 3 }), 0n);
    const attempt = await lifecycle.hireFromWatch(candidateId);
    expect(attempt.ok).toBe(true);
    expect(repo.activeActivationCount(handle.db)).toBe(1);
    expect(repo.getActivation(handle.db, attempt.activationId!)?.state).toBe('ACTIVE');
    // The watch row follows him into the chair: off the bench, shadow running.
    expect(repo.getWatchWallet(handle.db, candidateId)?.status).toBe('hired');
  });

  it('never activates the same leader twice while his watch record stays on the bench', async () => {
    const candidateId = seedBench('bench_dup');
    const lifecycle = lifecycleFor(riskConfig({ ROSTER_SIZE: 3 }));
    expect((await lifecycle.hireFromWatch(candidateId)).ok).toBe(true);
    const second = await lifecycle.hireFromWatch(candidateId);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/ALREADY_ACTIVE/);
    expect(repo.activeActivationCount(handle.db)).toBe(1);
  });

  it('fillRoster skips a seated bench wallet and hires the next candidate', async () => {
    // The best net on the bench already holds a chair: the free one must go to
    // the next wallet, not to a duplicate activation of the leader we have.
    const seated = seedBench('bench_seated', 9_000_000n);
    const next = seedBench('bench_next', 2_000_000n);
    const lifecycle = lifecycleFor(riskConfig({ ROSTER_SIZE: 3 }));
    expect((await lifecycle.hireFromWatch(seated)).ok).toBe(true);

    const filled = await lifecycle.fillRoster();
    expect(filled.hired).toEqual([next]);
    expect(repo.activeActivationCount(handle.db)).toBe(2);
    expect(repo.listActiveActivations(handle.db).filter((a) => a.candidateId === seated)).toHaveLength(1);
  });

  it('a firing cools the leader and never re-hires him from the chair he just freed', async () => {
    const fired = seedBench('bench_fired', 9_000_000n); // best record on the bench
    const other = seedBench('bench_other', 2_000_000n);
    const lifecycle = lifecycleFor(riskConfig({ ROSTER_SIZE: 3 }));
    const hire = await lifecycle.hireFromWatch(fired);
    expect(hire.ok).toBe(true);

    await lifecycle.fire(hire.activationId!, 'idle: test');

    // The fired leader is in the cooling rotation (a post-fire buy may bring
    // him back), not still on the bench.
    expect(repo.getWatchWallet(handle.db, fired)?.status).toBe('cooling');
    const active = repo.listActiveActivations(handle.db).filter((a) => a.state === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(active[0]!.candidateId).toBe(other);
  });
});

describe('fire frees exactly one chair (AC3)', () => {
  it('closes only that leader’s positions and fills the freed chair', async () => {
    for (const a of repo.listActiveActivations(handle.db)) {
      repo.updateActivation(handle.db, a.activationId, {
        state: 'FIRED',
        endedAt: new Date().toISOString(),
        endReason: 'test',
      });
    }
    const first = seedCandidateWithWallet('fire_first');
    const second = seedCandidateWithWallet('fire_second');
    const lifecycle = lifecycleFor(riskConfig({ ROSTER_SIZE: 2 }));
    const a1 = await lifecycle.activate(first, 'manual', false);
    const a2 = await lifecycle.activate(second, 'manual', false);
    expect(a1.ok && a2.ok).toBe(true);

    const replacement = seedBench('bench_replacement');
    const outcome = await lifecycle.fire(a1.activationId!, 'manual test fire');
    expect(outcome.status).toBe('ACTIVATED');
    const active = repo.listActiveActivations(handle.db);
    expect(active).toHaveLength(2); // the surviving chair + its replacement
    expect(active.some((x) => x.activationId === a2.activationId)).toBe(true);
    expect(active.some((x) => x.candidateId === replacement)).toBe(true);
    expect(repo.getActivation(handle.db, a1.activationId!)!.state).toBe('FIRED');
  });
});
