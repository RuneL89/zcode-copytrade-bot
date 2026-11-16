import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { isoWeekOf } from '@zcode-bot/core';
import { buildWeeklyReview } from '../src/services/weeklyReview.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let dir: string;
let handle: DbHandle;
// Second-aligned so the fixture's second-precision blockTime does not make the
// expected 60s leader-to-fill delay flaky (60.0–61.0s).
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const candidateId = 'cand_weekly_fixture';
const activationId = 'act_weekly_fixture';
const positionId = 'pos_weekly_fixture';
const mint = 'MintWeeklyFixture1111111111111111111111111111';
const signature = 'SigWeeklyFixture1111111111111111111111111111111111111111111111111111111';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-weekly-'));
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

  repo.upsertCandidate(handle.db, {
    candidateId,
    handle: 'fixture',
    weeklyRank: null,
    displayedWeeklyPnlUsdMicro: null,
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt: at(180),
  });
  repo.upsertWatchWallet(handle.db, {
    candidateId,
    address: 'WalletWeeklyFixture',
    status: 'watching',
    reason: 'test',
    admittedAt: at(180),
  });
  repo.createActivation(handle.db, {
    activationId,
    candidateId,
    state: 'FIRED',
    startedAt: at(120),
    endedAt: at(0),
    endReason: 'fired',
    lossStreak: 0,
    firedReason: 'fixture',
    source: 'watch_promotion',
  });
  repo.insertPosition(handle.db, {
    positionId,
    activationId,
    candidateId,
    mint,
    mintSymbol: 'FIX',
    status: 'closed',
    entryIntentId: 'intent_weekly_fixture',
    inputMint: USDC,
    inputUsdMicro: '5000000',
    copiedTokenBase: '1000000000',
    remainingTokenBase: '0',
    leaderTokenBase: null,
    realizedPnlUsdMicro: '1000000',
    feesUsdMicro: '10000',
    openedAt: at(90),
    closedAt: at(0),
    closeReason: 'time_exit',
  });
  repo.insertIntent(handle.db, {
    intentId: 'intent_weekly_fixture',
    kind: 'entry',
    mode: 'paper',
    activationId,
    candidateId,
    positionId,
    mint,
    inputMint: USDC,
    inputAmountBase: '5000000',
    inputUsdMicro: '5000000',
    minOutputBase: null,
    slippageBps: null,
    priceImpactBps: null,
    state: 'confirmed',
    idempotencyKey: `entry:${activationId}:${signature}:${mint}`,
    quoteJson: null,
    txSignature: null,
    reason: null,
    createdAt: at(90),
    updatedAt: at(90),
  });
  repo.insertFill(handle.db, {
    fillId: 'fill_weekly_fixture',
    intentId: 'intent_weekly_fixture',
    positionId,
    mode: 'paper',
    txSignature: null,
    inputAmountBase: '5000000',
    outputAmountBase: '1960784313',
    priceUsdMicro: null,
    feeEstimateUsdMicro: '0',
    balanceEvidenceJson: null,
    commitment: 'confirmed',
    confirmedAt: at(89),
  });
  repo.insertPnlLot(handle.db, {
    positionId,
    closedBase: '1000000000',
    proceedsUsdMicro: '6000000',
    costBasisUsdMicro: '5000000',
    feesUsdMicro: '10000',
    pnlUsdMicro: '1000000',
    unitType: 'position_closed',
    closedAt: at(0),
    signature: null,
  });
  repo.insertObservedEvent(handle.db, {
    dedupeKey: `test:${signature}`,
    activationId,
    candidateId,
    address: 'WalletWeeklyFixture',
    signature,
    slot: 1,
    transactionIndex: 0,
    blockTime: Math.floor(Date.parse(at(90)) / 1000),
    kind: 'swap_buy',
    skipReason: null,
    detailJson: JSON.stringify({
      signature,
      mint,
      mintDecimals: 6,
      tokenDeltaBase: '10000000000n',
      fundingMint: USDC,
      fundingDecimals: 6,
      fundingDeltaBase: '25000000n',
      kind: 'swap_buy',
    }),
    rawRef: signature,
    parserVersion: 'test',
    processedAt: at(90),
  });
  const shadowId = repo.openShadowTrade(handle.db, {
    candidateId,
    mint: 'MintShadowFixture',
    openedAt: at(180),
    entryPriceUsdMicro: '1000',
    notionalUsdMicro: '5000000',
  });
  repo.closeShadowTrade(handle.db, shadowId, {
    closedAt: at(150),
    exitReason: 'leader_sell',
    exitPriceUsdMicro: '1200',
    pnlUsdMicro: '2000000',
  });
  repo.audit(handle.db, 'monitor', `code exit: ${mint} held 1.5h (stop_loss)`, {});
  repo.insertFiringEvent(handle.db, {
    activationId,
    candidateId,
    reason: 'fixture firing',
    lossStreak: 0,
    positionPolicy: 'close_all_before_switch',
    firedAt: at(10),
    closeCompletedAt: null,
    handoffStatus: 'none',
  });
  repo.setWatchStatus(handle.db, candidateId, 'cooling', 'fired: fixture firing');
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('weekly review service', () => {
  it('builds the report from persisted evidence without writing trading state', () => {
    const week = isoWeekOf(now, 'Europe/Helsinki');
    const report = buildWeeklyReview({
      sqlite: handle.sqlite,
      mode: 'paper',
      dbPath: join(dir, 'zcode-bot.db'),
      week,
      now,
      resetAt: null,
    });

    expect(report.summary.seats).toBe(1);
    expect(report.summary.copies).toBe(1);
    expect(report.summary.realizedPnlUsdMicro).toBe(1_000_000n);
    expect(report.traders).toHaveLength(1);
    const trader = report.traders[0]!;
    expect(trader.handle).toBe('fixture');
    expect(trader.promised.preHireShadow.closedTrades).toBe(1);
    expect(trader.promised.preHireShadow.netPnlUsdMicro).toBe(2_000_000n);
    expect(trader.actual.realizedPnlUsdMicro).toBe(1_000_000n);
    expect(trader.gapUsdMicro).toBe(-1_000_000n);

    const byKey = Object.fromEntries(
      trader.attribution.components.map((component) => [component.key, component]),
    );
    expect(byKey.copy_delay.detail).toMatch(/60\.\d+s/);
    expect(byKey.entry_price.amountUsdMicro).not.toBeNull();
    expect(byKey.entry_price.detail).toContain('bps');

    expect(report.exitGroups).toHaveLength(1);
    expect(report.exitGroups[0]).toMatchObject({
      reason: 'stop_loss',
      positions: 1,
      lots: 1,
      pnlUsdMicro: 1_000_000n,
    });
    expect(report.exitGroups[0]!.postExitOneHour).toEqual({ known: 0, unknown: 1 });
    expect(report.hiringRule.sample).toBe(1);
    expect(report.hiringRule.verdict).toContain('Insufficient sample');
    expect(report.firedTraders).toHaveLength(1);
    expect(report.firedTraders[0]!.status).toBe('unknown');
    expect(report.proposals[0]!.direction).toBe('NO CHANGE');
    expect(report.dataGaps.length).toBeGreaterThan(0);
  });

  it('infers the paper reset from the standard backup filename', () => {
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'zcode-bot-before-paper-reset-20261115-095433.db'), '', 'utf8');
    const report = buildWeeklyReview({
      sqlite: handle.sqlite,
      mode: 'paper',
      dbPath: join(dir, 'zcode-bot.db'),
      week: isoWeekOf(now, 'Europe/Helsinki'),
      now,
    });
    expect(report.source.resetAt).toBe('2026-11-15T07:54:33.000Z');
    expect(report.source.resetBasis).toContain('before-paper-reset backup');
  });
});
