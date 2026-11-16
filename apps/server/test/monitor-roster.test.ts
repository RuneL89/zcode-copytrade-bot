import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type RiskConfig } from '@zcode-bot/config';
import type { LeaderTxSummary } from '@zcode-bot/core';
import { LeaderMonitor } from '../src/services/monitor.js';
import type { CopyEngine } from '../src/services/engine.js';
import type { TraderLifecycle } from '../src/services/lifecycle.js';

/**
 * D4/plan 05 monitor: the roster tick polls every chair independently, and a
 * provider failure on one chair is audited without stopping the others.
 */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

let dir: string;
let handle: DbHandle;
let risk: RiskConfig;

interface Harness {
  monitor: LeaderMonitor;
  handled: Array<{ activationId: string; signature: string }>;
  fired: string[];
  failFor: Set<string>;
  closed: string[];
}

function txFor(leader: string, signature: string, usdMicro: bigint): LeaderTxSummary {
  return {
    chain: 'solana',
    leaderAddress: leader,
    signature,
    slot: 1,
    transactionIndex: 0,
    blockTime: Math.floor(Date.now() / 1000),
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas: [
      {
        mint: 'MonitorMint11111111111111111111111111111111111',
        decimals: 6,
        preBase: 0n,
        postBase: 9_000_000n,
        deltaBase: 9_000_000n,
      },
      { mint: USDC, decimals: 6, preBase: usdMicro, postBase: 0n, deltaBase: -usdMicro },
    ],
    programs: [JUP],
  };
}

function harness(): Harness {
  const handled: Array<{ activationId: string; signature: string }> = [];
  const fired: string[] = [];
  const failFor = new Set<string>();
  const closed: string[] = [];

  const engine = {
    handleLeaderTx: async (activationId: string, _candidateId: string, summary: LeaderTxSummary) => {
      handled.push({ activationId, signature: summary.signature });
    },
    closePosition: async (positionId: string) => {
      closed.push(positionId);
      return 'closed';
    },
  } as unknown as CopyEngine;

  const lifecycle = {
    fire: async (activationId: string) => {
      fired.push(activationId);
      repo.updateActivation(handle.db, activationId, {
        state: 'FIRED',
        endedAt: new Date().toISOString(),
        endReason: 'test fire',
      });
      return { status: 'NO_REPLACEMENT' as const, skipped: [] };
    },
  } as unknown as TraderLifecycle;

  const helius = {
    latestCursor: async () => ({
      lastSignature: '',
      lastSlot: 0,
      lastTransactionIndex: 0,
      lastBlockTime: null,
    }),
    signaturesSince: async (address: string) => {
      if (failFor.has(address)) throw new Error(`provider down for ${address}`);
      return [
        {
          signature: `sig_${address}`,
          slot: 1,
          blockTime: Math.floor(Date.now() / 1000),
          err: false,
        },
      ];
    },
    transactionSummary: async (address: string, signature: string) => txFor(address, signature, 40_000_000n),
  } as unknown as Parameters<(typeof LeaderMonitor.prototype)['constructor']>[1];

  const monitor = new LeaderMonitor(
    handle.db,
    helius as never,
    engine,
    risk,
    lifecycle,
    () => {},
    45_000,
    () => null,
  );
  return { monitor, handled, fired, failFor, closed };
}

let seatCounter = 0;
function seedChair(handleName: string, state = 'ACTIVE'): string {
  // Ids are unique per call; the ADDRESS is stable per handle, which is what the
  // cursor (keyed by address) is about.
  const n = seatCounter++;
  const candidateId = `cand_mon_${handleName}_${n}`;
  const activationId = `act_mon_${handleName}_${n}`;
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
    address: `MonWallet${handleName}`,
    verification: 'reported',
  });
  repo.createActivation(handle.db, {
    activationId,
    candidateId,
    state,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'test',
  });
  return activationId;
}

function reset(): void {
  for (const a of repo.listActiveActivations(handle.db)) {
    repo.updateActivation(handle.db, a.activationId, {
      state: 'FIRED',
      endedAt: new Date().toISOString(),
      endReason: 'test reset',
    });
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-monitor-roster-'));
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
  risk = loadConfig({ SESSION_SECRET: 'm'.repeat(48) }).risk;
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('roster monitor (AC8/AC9)', () => {
  it('does not fetch a signature the 300s poll already knows is outside the copy window', async () => {
    reset();
    seedChair('stalebuy');
    let fetched = 0;
    const helius = {
      latestCursor: async () => ({
        lastSignature: 'tip',
        lastSlot: 1,
        lastTransactionIndex: 0,
        lastBlockTime: Math.floor(Date.now() / 1000),
      }),
      signaturesSince: async () => [
        {
          signature: 'old-buy',
          slot: 2,
          blockTime: Math.floor(Date.now() / 1000) - 300,
          err: false,
        },
      ],
      transactionSummary: async () => {
        fetched++;
        return null;
      },
    };
    const monitor = new LeaderMonitor(
      handle.db,
      helius as never,
      { handleLeaderTx: async () => undefined, closePosition: async () => 'closed' } as never,
      risk,
      { fire: async () => ({ status: 'NO_REPLACEMENT', skipped: [] }) } as never,
      () => undefined,
      300_000,
      () => null,
    );
    await monitor.tick();
    repo.setCursor(handle.db, {
      address: 'MonWalletstalebuy',
      chain: 'solana',
      activationId: repo.listActiveActivations(handle.db)[0]!.activationId,
      lastSignature: 'tip',
      lastSlot: 1,
      lastTransactionIndex: 0,
      lastBlockTime: Math.floor(Date.now() / 1000) - 400,
    });
    await monitor.tick();
    expect(fetched).toBe(0);
  });

  it('polls every chair in one tick', async () => {
    reset();
    const a1 = seedChair('alpha');
    const a2 = seedChair('beta');
    const a3 = seedChair('gamma');
    const h = harness();
    await h.monitor.tick(); // first tick initialises the cursors
    await h.monitor.tick(); // second tick polls
    const seen = new Set(h.handled.map((x) => x.activationId));
    expect(seen.has(a1)).toBe(true);
    expect(seen.has(a2)).toBe(true);
    expect(seen.has(a3)).toBe(true);
    expect(h.handled).toHaveLength(3);
  });

  it('a provider failure on one chair is audited and the others still poll', async () => {
    reset();
    const a1 = seedChair('alpha');
    const a2 = seedChair('beta');
    const h = harness();
    // First tick walks the cursors (none exist yet).
    await h.monitor.tick();
    h.handled.length = 0;
    h.failFor.add('MonWalletalpha');
    await h.monitor.tick();
    // alpha failed; beta still produced its transaction, and the failure landed
    // in the audit trail.
    expect(h.handled.some((x) => x.activationId === a2)).toBe(true);
    expect(
      repo.listAudit(handle.db, 20).some((a) => /poll failed for activation .*provider down/.test(a.message)),
    ).toBe(true);
    expect(h.monitor.lastError).toMatch(/provider down/);
    // The failed chair is still ACTIVE — one bad poll never fires or drops it.
    expect(repo.getActivation(handle.db, a1)?.state).toBe('ACTIVE');
  });

  it('a re-hire of the same address starts at the tip (AC9)', async () => {
    reset();
    const first = seedChair('rehire');
    const h = harness();
    await h.monitor.tick(); // initialises the cursor for the address
    const cursor = repo.getCursor(handle.db, 'MonWalletrehire')!;
    expect(cursor.activationId).toBe(first);
    // Fire and re-hire the same address: the second chair must NOT replay the
    // backlog that accumulated between the two hires.
    reset();
    const second = seedChair('rehire');
    h.handled.length = 0;
    await h.monitor.tick();
    // The tick re-initialised the cursor for the new activation instead of
    // copying from the old one.
    const newCursor = repo.getCursor(handle.db, 'MonWalletrehire')!;
    expect(newCursor.activationId).toBe(second);
    expect(h.handled.filter((x) => x.activationId === second)).toHaveLength(0);
    expect(
      repo.listAudit(handle.db, 20).some((a) => /cursor initialized at activation/.test(a.message)),
    ).toBe(true);
  });
});

/**
 * The hourly discipline sweep is capped PER SEAT. One shared timestamp let the
 * first chair consume the hour and starve the rest, so an overdue position on
 * seat 3 stayed open for hours (live: ANONCOIN 14h past an 8h window).
 */
describe('the hourly sweep reaches every seat', () => {
  function seedOverduePosition(activationId: string, tag: string): string {
    const positionId = `pos_sweep_${tag}`;
    repo.insertPosition(handle.db, {
      positionId,
      activationId,
      candidateId: 'cand_mon',
      mint: `SweepMint${tag}`,
      mintSymbol: tag,
      status: 'open',
      entryIntentId: null,
      inputMint: USDC,
      inputUsdMicro: '5000000',
      copiedTokenBase: '1000',
      remainingTokenBase: '1000',
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: '1000',
      // Past max age (8h) + grace (3h): must sell regardless of the mark.
      openedAt: new Date(Date.now() - 12 * 3_600_000).toISOString(),
      closedAt: null,
      closeReason: null,
    });
    return positionId;
  }

  it('closes an overdue position on every chair in a single tick', async () => {
    reset();
    const a1 = seedChair('sweep_one');
    const a2 = seedChair('sweep_two');
    const p1 = seedOverduePosition(a1, 'ONE');
    const p2 = seedOverduePosition(a2, 'TWO');
    const h = harness();
    await h.monitor.tick();
    expect(h.closed).toContain(p1);
    expect(h.closed).toContain(p2);
  });
});

describe('roster safety poll in push mode', () => {
  it('advances the cursor without spending detail reads', async () => {
    reset();
    seedChair('pushskip');
    let fetched = 0;
    const helius = {
      latestCursor: async () => ({
        lastSignature: 'tip',
        lastSlot: 1,
        lastTransactionIndex: 0,
        lastBlockTime: Math.floor(Date.now() / 1000),
      }),
      signaturesSince: async () => [
        {
          signature: 'fresh-push',
          slot: 2,
          blockTime: Math.floor(Date.now() / 1000),
          err: false,
        },
      ],
      transactionSummary: async () => {
        fetched++;
        return null;
      },
    };
    const monitor = new LeaderMonitor(
      handle.db,
      helius as never,
      { handleLeaderTx: async () => undefined, closePosition: async () => 'closed' } as never,
      risk,
      { fire: async () => ({ status: 'NO_REPLACEMENT', skipped: [] }) } as never,
      () => undefined,
      600_000,
      () => null,
    );
    monitor.setStreamMode('push');
    await monitor.tick(); // initialise the cursor at the tip
    await monitor.tick(); // signature page only
    expect(fetched).toBe(0);
    expect(repo.getCursor(handle.db, 'MonWalletpushskip')?.lastSignature).toBe('fresh-push');
  });
});
