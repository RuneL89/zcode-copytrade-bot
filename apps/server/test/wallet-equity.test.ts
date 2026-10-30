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
import { WalletEquityService, type WalletReader } from '../src/services/wallet-equity.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PURR = '8RNUw4N655VSrZKuhGdywhbSMDTrheguFPfxbpE2NZHQ';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;

const prices = {
  priceOf: async (mint: string) => ({
    // SOL ($150) and memecoins at $0.001/base unit; USDC never asked.
    priceUsdMicro: mint === PURR ? 1000n : 150_000_000n,
    observedAt: new Date().toISOString(),
    source: 'test',
  }),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-wallet-equity-'));
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
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function service(balances: { sol: bigint; usdc: bigint; tokens: Record<string, bigint> }) {
  const reader: WalletReader = {
    getSolLamports: async () => balances.sol,
    getTokenBalanceBase: async (mint) => (mint === USDC ? balances.usdc : (balances.tokens[mint] ?? 0n)),
  };
  return new WalletEquityService(
    handle.db,
    prices as never,
    'http://fake',
    'Fksjc9dLJHtCXCqXbJfRjQUmBUKtqivYFte2kGCLsV4i',
    () => reader,
  );
}

function seedOpenPosition(mint: string, remaining: string, inputUsd = '10000000') {
  repo.insertPosition(handle.db, {
    positionId: 'pos_' + crypto.randomUUID(),
    activationId: 'act_' + crypto.randomUUID(),
    candidateId: 'cand_test',
    mint,
    mintSymbol: 'TEST',
    status: 'open',
    entryIntentId: null,
    inputMint: USDC,
    inputUsdMicro: inputUsd,
    copiedTokenBase: remaining,
    remainingTokenBase: remaining,
    leaderTokenBase: null,
    realizedPnlUsdMicro: '0',
    feesUsdMicro: '0',
    openedAt: new Date().toISOString(),
    closedAt: null,
    closeReason: null,
  });
}

function seedLiveFill(kind: 'entry' | 'exit', usdBase: string, at: Date, mode: 'live' | 'paper' = 'live') {
  const intentId = 'intent_' + crypto.randomUUID();
  repo.insertIntent(handle.db, {
    intentId,
    kind,
    mode,
    activationId: 'act_x',
    candidateId: 'cand_test',
    positionId: null,
    mint: PURR,
    inputMint: kind === 'entry' ? USDC : PURR,
    inputAmountBase: usdBase,
    minOutputBase: null,
    slippageBps: null,
    priceImpactBps: null,
    state: 'confirmed',
    idempotencyKey: 'idem_' + crypto.randomUUID(),
    quoteJson: null,
    txSignature: 'sig' + crypto.randomUUID(),
    reason: null,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
  });
  repo.insertFill(handle.db, {
    fillId: 'fill_' + crypto.randomUUID(),
    intentId,
    positionId: null,
    mode,
    txSignature: 'sig' + crypto.randomUUID(),
    inputAmountBase: usdBase,
    outputAmountBase: usdBase,
    priceUsdMicro: null,
    feeEstimateUsdMicro: '0',
    balanceEvidenceJson: '{}',
    commitment: 'confirmed',
    confirmedAt: at.toISOString(),
  });
}

describe('wallet equity', () => {
  it('composes equity from USDC, priced SOL, and tracked positions', async () => {
    seedOpenPosition(PURR, '3696130585599');
    const svc = service({ sol: 41_873_000n, usdc: 121_030_191n, tokens: { [PURR]: 3_696_130_585_599n } });

    const snap = await svc.refresh();
    expect(snap).not.toBeNull();
    // USDC 121.030191 + SOL 0.04187303 * 150 + PURR base * $0.001/whole token
    expect(snap!.usdcMicro).toBe('121030191');
    expect(snap!.solUsdMicro).toBe('6280950'); // 0.041873 SOL * $150
    expect(snap!.positionsUsdMicro).toBe('3696130585'); // base * 1000 / 1e6
    expect(BigInt(snap!.equityUsdMicro)).toBe(121_030_191n + 6_280_950n + 3_696_130_585n);
    // First refresh captures the baseline; headline PnL starts at zero.
    expect(snap!.baselineUsdMicro).toBe(snap!.equityUsdMicro);
    expect(snap!.headlinePnlUsdMicro).toBe('0');
    // Real bankroll: cash = USDC only; capital adds the open position cost.
    expect(svc.currentBankroll()).toEqual({
      cashUsdMicro: '121030191',
      capitalUsdMicro: '131030191', // + $10 open cost
    });
  });

  it('detects an unexplained USDC jump as a deposit without breaking PnL', async () => {
    seedOpenPosition(PURR, '3696130585599');
    const balances = { sol: 41_873_000n, usdc: 121_030_191n, tokens: { [PURR]: 3_696_130_585_599n } };
    const svc = service(balances);
    await svc.refresh();

    balances.usdc = 221_030_191n; // +$100 from outside
    const snap = await svc.refresh();
    // Headline PnL ignores the deposit: equity rose but PnL stays 0.
    expect(BigInt(snap!.equityUsdMicro)).toBe(221_030_191n + 6_280_950n + 3_696_130_585n);
    expect(snap!.externalNetUsdMicro).toBe('100000000');
    expect(snap!.headlinePnlUsdMicro).toBe('0');
    const ledger = JSON.parse(repo.kvGet(handle.db, 'wallet.external')!);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].deltaMicro).toBe('100000000');
  });

  it('does not count our own live exit as a deposit', async () => {
    seedOpenPosition(PURR, '3696130585599');
    const balances = { sol: 41_873_000n, usdc: 121_030_191n, tokens: { [PURR]: 3_696_130_585_599n } };
    const svc = service(balances);
    const first = await svc.refresh();

    // Our exit lands: +$13.31 USDC (base units), position stays tracked here.
    seedLiveFill('exit', '13313248', new Date());
    balances.usdc += 13_313_248n;
    const second = await svc.refresh();

    expect(
      second.externalNetUsdMicro,
      JSON.stringify({
        first: { usdc: first.usdcMicro, asOf: first.asOf },
        second: { usdc: second.usdcMicro, asOf: second.asOf },
        fills: repo
          .listFills(handle.db, 10)
          .map((f) => ({ mode: f.mode, out: f.outputAmountBase, at: f.confirmedAt })),
        ledger: JSON.parse(repo.kvGet(handle.db, 'wallet.external') ?? '[]'),
      }),
    ).toBe('0');
  });

  it('counts a paper fill as nothing (live wallet only)', async () => {
    const svc = service({ sol: 41_873_000n, usdc: 121_030_191n, tokens: {} });
    await svc.refresh();
    seedLiveFill('exit', '13313248', new Date(), 'paper');
    // Paper fill (mode paper) must not offset: same balances, no trades.
    const second = await svc.refresh();
    expect(second.externalNetUsdMicro).toBe('0');
  });

  it('samples the series at most once per minute and prunes to 24h', async () => {
    const svc = service({ sol: 41_873_000n, usdc: 121_030_191n, tokens: {} });
    await svc.refresh(new Date('2026-10-30T00:00:00Z'));
    await svc.refresh(new Date('2026-10-30T00:00:10Z')); // too soon: dropped
    await svc.refresh(new Date('2026-10-30T00:01:00Z')); // kept
    let series = svc.series();
    expect(series).toHaveLength(2);

    await svc.refresh(new Date('2026-10-31T12:00:00Z')); // >24h later: prunes old
    series = svc.series();
    expect(series).toHaveLength(1);
    expect(series[0]!.t).toBe('2026-10-31T12:00:00.000Z');
  });

  it('keeps the last snapshot when the RPC read fails', async () => {
    const balances = { sol: 41_873_000n, usdc: 121_030_191n, tokens: {} };
    const svc = service(balances);
    await svc.refresh();
    const before = svc.current();

    const broken: WalletReader = {
      getSolLamports: async () => null,
      getTokenBalanceBase: async () => null,
    };
    // Swap the reader via a fresh service sharing the same DB.
    const brokenSvc = new WalletEquityService(
      handle.db,
      prices as never,
      'http://fake',
      'Fksjc9dLJHtCXCqXbJfRjQUmBUKtqivYFte2kGCLsV4i',
      () => broken,
    );
    const after = await brokenSvc.refresh();
    expect(after).not.toBeNull();
    expect(after!.usdcMicro).toBe(before!.usdcMicro);
    expect(after!.asOf).toBe(before!.asOf);
  });
});
