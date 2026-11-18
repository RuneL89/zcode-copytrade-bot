import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig } from '@zcode-bot/config';
import { StaticPriceProvider, NoopNotifier } from '@zcode-bot/providers';
import type { LeaderTxSummary } from '@zcode-bot/core';
import { CopyEngine } from '../src/services/engine.js';
import { ControlService } from '../src/services/control.js';
import { PaperExecutor } from '../src/services/executors.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'MeowMint111111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const prices = new StaticPriceProvider(
  new Map([
    [USDC, 1_000_000n],
    [TOKEN, 500_000n],
  ]),
);

function leaderBuy(inputUsdMicro: bigint): LeaderTxSummary {
  return {
    chain: 'solana',
    leaderAddress: 'LeaderCap1111111111111111111111111111111111',
    signature: 'sig_' + Math.random().toString(36).slice(2),
    slot: 1000 + Math.floor(Math.random() * 100),
    transactionIndex: 1,
    blockTime: Math.floor(Date.now() / 1000),
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas: [
      { mint: TOKEN, decimals: 6, preBase: 0n, postBase: 9_000_000n, deltaBase: 9_000_000n },
      { mint: USDC, decimals: 6, preBase: inputUsdMicro, postBase: 0n, deltaBase: -inputUsdMicro },
    ],
    programs: [JUP],
  };
}

let dir: string;
let handle: DbHandle;
let config: ReturnType<typeof loadConfig>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-capital-'));
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
  config = loadConfig({ SESSION_SECRET: 'k'.repeat(48) });
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function engineFor(capitalUsd: number): CopyEngine {
  return new CopyEngine(
    handle.db,
    {
      ...config.risk,
      MIN_PER_BUY_USD: 2,
      MAX_PER_BUY_PCT: 10,
      MAX_OPEN_PER_TRADER_PCT: 35,
      MAX_DEPLOYED_PCT: 100,
    },
    prices,
    new PaperExecutor(null, async (mint, decimals) => (await prices.priceOf(mint, decimals)).priceUsdMicro),
    new ControlService(handle.db),
    new NoopNotifier(),
    { onFired: () => {}, onStateChanged: () => {} },
    null,
    BigInt(capitalUsd) * 1_000_000n,
  );
}

function seed(candidateId: string, activationId: string): void {
  repo.upsertCandidate(handle.db, {
    candidateId,
    handle: candidateId,
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
    address: 'Wallet' + candidateId,
    verification: 'reported',
  });
  repo.createActivation(handle.db, {
    activationId,
    candidateId,
    state: 'ACTIVE',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'test',
  });
}

describe('capital-relative exposure caps', () => {
  it('scales the per-trade ceiling with current capital', async () => {
    // 0.25 × $400 leader input = $100 desired at both bankrolls; the 10% cap
    // is what changes with capital.
    seed('cand_cap_100', 'act_cap_100');
    await engineFor(100).handleLeaderTx('act_cap_100', 'cand_cap_100', leaderBuy(400_000_000n));
    const p100 = repo.openPositions(handle.db).find((p) => p.activationId === 'act_cap_100')!;
    expect(p100.inputUsdMicro).toBe('10000000'); // 10% of $100

    seed('cand_cap_200', 'act_cap_200');
    await engineFor(200).handleLeaderTx('act_cap_200', 'cand_cap_200', leaderBuy(400_000_000n));
    const p200 = repo.openPositions(handle.db).find((p) => p.activationId === 'act_cap_200')!;
    expect(p200.inputUsdMicro).toBe('20000000'); // 10% of $200
  });
});
