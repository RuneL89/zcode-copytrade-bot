import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type RiskConfig } from '@zcode-bot/config';
import { NoopNotifier, StaticPriceProvider } from '@zcode-bot/providers';
import type { LeaderTxSummary } from '@zcode-bot/core';
import { CopyEngine, COALESCE_SAME_MINT_MS } from '../src/services/engine.js';
import { ControlService } from '../src/services/control.js';
import { PaperExecutor } from '../src/services/executors.js';

/**
 * D4/plan 05 entry shaping: same-mint bursts are one position (60 s window) and
 * the per-mint cap is configurable (0 = off).
 */

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEOW = 'MeowMint111111111111111111111111111111111111111';
// One mint per scenario: the coalescing window and the per-mint cap are
// per-MINT, so sharing one mint across tests would leak state between them.
const MEOW_AFTER = 'MeowAfter1111111111111111111111111111111111111';
const MEOW_CAP_OFF = 'MeowCapOff111111111111111111111111111111111111';
const MEOW_CAP_ON = 'MeowCapOn1111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const LEADER = 'LeaderRoster111111111111111111111111111111111';

let dir: string;
let handle: DbHandle;
let risk: RiskConfig;

const prices = new StaticPriceProvider(
  new Map([
    [USDC, 1_000_000n],
    [MEOW, 500_000n],
  ]),
);

function tx(over: Partial<LeaderTxSummary>): LeaderTxSummary {
  return {
    chain: 'solana',
    leaderAddress: LEADER,
    signature: 'sig_' + Math.random().toString(36).slice(2),
    slot: 1000 + Math.floor(Math.random() * 100),
    transactionIndex: 1,
    blockTime: Math.floor(Date.now() / 1000),
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas: [],
    programs: [JUP],
    ...over,
  };
}

/** A funded buy: 9 MEOW in, `usdMicro` USDC out. */
function leaderBuy(usdMicro: bigint, mint = MEOW): LeaderTxSummary {
  return tx({
    tokenDeltas: [
      { mint, decimals: 6, preBase: 0n, postBase: 9_000_000n, deltaBase: 9_000_000n },
      { mint: USDC, decimals: 6, preBase: usdMicro, postBase: 0n, deltaBase: -usdMicro },
    ],
  });
}

function engineFor(overrides: Partial<RiskConfig> = {}): CopyEngine {
  const config = loadConfig({ SESSION_SECRET: 'c'.repeat(48) });
  const merged = { ...config.risk, ...overrides };
  return new CopyEngine(
    handle.db,
    merged,
    prices,
    new PaperExecutor(null, async (mint, decimals) => (await prices.priceOf(mint, decimals)).priceUsdMicro),
    new ControlService(handle.db),
    new NoopNotifier(),
    { onFired: () => {}, onStateChanged: () => {} },
    null,
    1_000_000_000n,
  );
}

function seedActivation(activationId: string): void {
  repo.upsertCandidate(handle.db, {
    candidateId: 'cand_roster',
    handle: 'roster',
    weeklyRank: null,
    displayedWeeklyPnlUsdMicro: null,
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt: new Date().toISOString(),
  });
  repo.createActivation(handle.db, {
    activationId,
    candidateId: 'cand_roster',
    state: 'ACTIVE',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'test',
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-coalesce-'));
  handle = openDatabase(dir);
  const migrationsFolder = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    '..',
    '..',
    'packages',
    'db',
    'drizzle',
  );
  migrate(handle.db, { migrationsFolder });
  risk = loadConfig({ SESSION_SECRET: 'c'.repeat(48) }).risk;
  void risk;
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('same-mint burst coalescing (AC6)', () => {
  it('six buys inside the window are one position and five skip records', async () => {
    seedActivation('act_coalesce');
    const engine = engineFor({ MAX_PER_BUY_PCT: 1, MIN_PER_BUY_USD: 5, MAX_DEPLOYED_PCT: 80 });
    for (let i = 0; i < 6; i++) {
      await engine.handleLeaderTx('act_coalesce', 'cand_roster', leaderBuy(40_000_000n));
    }
    const open = repo.openPositions(handle.db).filter((p) => p.activationId === 'act_coalesce');
    expect(open).toHaveLength(1);
    expect(open[0]!.inputUsdMicro).toBe('10000000'); // one $10 copy, not six
    const skips = repo
      .listRiskRejections(handle.db, 50)
      .filter((r) => r.rule === 'COALESCED_SAME_MINT_BURST');
    expect(skips).toHaveLength(5);
    expect(skips[0]!.limitValue).toBe(String(COALESCE_SAME_MINT_MS));
  });

  it('a buy after the window is copied (the position pyramids)', async () => {
    seedActivation('act_after');
    const engine = engineFor({ MAX_PER_BUY_PCT: 1, MIN_PER_BUY_USD: 5, MAX_DEPLOYED_PCT: 80 });
    await engine.handleLeaderTx('act_after', 'cand_roster', leaderBuy(40_000_000n, MEOW_AFTER));
    const pos = repo.openPositions(handle.db).find((p) => p.activationId === 'act_after')!;
    // Age the position past the coalescing window.
    handle.sqlite
      .prepare('update copied_positions set opened_at = ? where position_id = ?')
      .run(new Date(Date.now() - COALESCE_SAME_MINT_MS - 5_000).toISOString(), pos.positionId);
    await engine.handleLeaderTx('act_after', 'cand_roster', leaderBuy(40_000_000n, MEOW_AFTER));
    const open = repo.openPositions(handle.db).filter((p) => p.activationId === 'act_after');
    expect(open).toHaveLength(1);
    expect(open[0]!.inputUsdMicro).toBe('20000000'); // both copies pyramided into one position
  });
});

describe('per-mint cap (AC7)', () => {
  it('PER_MINT_CAP_USD = 0 disables the cap', async () => {
    seedActivation('act_cap_off');
    const engine = engineFor({ MAX_PER_BUY_PCT: 1, MIN_PER_BUY_USD: 5, PER_MINT_CAP_USD: 0 });
    await engine.handleLeaderTx('act_cap_off', 'cand_roster', leaderBuy(40_000_000n, MEOW_CAP_OFF));
    expect(repo.listRiskRejections(handle.db, 50).filter((r) => r.rule === 'PER_MINT_CAP')).toHaveLength(0);
    expect(repo.openPositions(handle.db).filter((p) => p.activationId === 'act_cap_off')).toHaveLength(1);
  });

  it('a positive cap skips the entry that would exceed the roster-wide total', async () => {
    seedActivation('act_cap_on');
    // $10 copy with a $10 cap: the first entry fills the mint, the second is
    // refused with PER_MINT_CAP (aged past the coalescing window first).
    const engine = engineFor({
      MAX_PER_BUY_PCT: 1,
      MIN_PER_BUY_USD: 5,
      PER_MINT_CAP_USD: 10,
      MAX_OPEN_PER_TRADER_PCT: 100,
    });
    await engine.handleLeaderTx('act_cap_on', 'cand_roster', leaderBuy(40_000_000n, MEOW_CAP_ON));
    const pos = repo.openPositions(handle.db).find((p) => p.activationId === 'act_cap_on')!;
    handle.sqlite
      .prepare('update copied_positions set opened_at = ? where position_id = ?')
      .run(new Date(Date.now() - COALESCE_SAME_MINT_MS - 5_000).toISOString(), pos.positionId);
    await engine.handleLeaderTx('act_cap_on', 'cand_roster', leaderBuy(40_000_000n, MEOW_CAP_ON));
    const capSkips = repo.listRiskRejections(handle.db, 50).filter((r) => r.rule === 'PER_MINT_CAP');
    expect(capSkips).toHaveLength(1);
    expect(capSkips[0]!.limitValue).toBe('10000000');
    // The cap is judged against open + proposed, not "already at the cap".
    expect(BigInt(capSkips[0]!.actualValue)).toBeGreaterThan(BigInt(capSkips[0]!.limitValue));
  });
});
