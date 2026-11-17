import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig } from '@zcode-bot/config';
import type { HeliusProvider } from '@zcode-bot/providers';
import { ControlService } from '../src/services/control.js';
import {
  WithdrawalService,
  splTransferCheckedData,
  type Broadcaster,
  type TransferOutcome,
} from '../src/services/withdraw.js';
import { b58Encode, generateWalletFile, walletPublicKey } from '../src/wallet.js';
import { createTradingLocks } from '../src/services/locks.js';

const SECRET = 'test-secret-1234567890';
const VALID_DESTINATION = b58Encode(nacl.sign.keyPair().publicKey);

let dir: string;
let handle: DbHandle;
let config: AppConfig;
let control: ControlService;
let service: WithdrawalService;

/** Chain balances the fake Helius reports (mutated per test). */
const chain = { solLamports: 50_000_000, usdcBase: 120_000_000n };
/** Everything the broadcaster was asked to do. */
const broadcasts: Array<{ asset: string; destination: string; amountBase: bigint; secretLen: number }> = [];
let nextOutcome: TransferOutcome = { kind: 'filled', signature: 'sig_fake_1' };

const heliusFake = {
  solBalanceLamports: async () => chain.solLamports,
  tokenBalanceBase: async () => chain.usdcBase,
} as unknown as HeliusProvider;

const broadcaster: Broadcaster = async (request) => {
  broadcasts.push({
    asset: request.asset,
    destination: request.destination,
    amountBase: request.amountBase,
    secretLen: request.secretKey.length,
  });
  if (nextOutcome.kind !== 'failed') {
    request.onSigned?.({
      signature: nextOutcome.signature,
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 9,
    });
  }
  return nextOutcome;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-withdraw-'));
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
  generateWalletFile(dir, SECRET);
  config = loadConfig({
    SESSION_SECRET: 'x'.repeat(40),
    DATA_DIR: dir,
    MODE: 'live',
    LIVE_TRADING: 'true',
  });
  control = new ControlService(handle.db);
  service = new WithdrawalService(
    handle.db,
    config,
    control,
    heliusFake,
    120_003_000n,
    broadcaster,
    createTradingLocks(),
  );
});

beforeEach(() => {
  handle.sqlite.exec(
    'DELETE FROM withdrawals; DELETE FROM copied_positions; DELETE FROM reconciliation_cases;',
  );
  chain.solLamports = 50_000_000;
  chain.usdcBase = 120_000_000n;
  broadcasts.length = 0;
  nextOutcome = { kind: 'filled', signature: 'sig_fake_1' };
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedOpenPosition(inputUsdMicro: string, feesUsdMicro: string): void {
  repo.insertPosition(handle.db, {
    positionId: 'pos_test_' + Math.random().toString(36).slice(2),
    activationId: 'act_test',
    candidateId: 'cand_test',
    mode: 'live',
    mint: 'TestMint111111111111111111111111111111111111',
    status: 'open',
    entryIntentId: null,
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inputUsdMicro,
    remainingCostBasisUsdMicro: inputUsdMicro,
    remainingFeesUsdMicro: feesUsdMicro,
    copiedTokenBase: '1000000',
    remainingTokenBase: '1000000',
    leaderTokenBase: null,
    realizedPnlUsdMicro: '0',
    feesUsdMicro,
    openedAt: new Date().toISOString(),
    closedAt: null,
    closeReason: null,
  });
}

describe('available()', () => {
  it('caps USDC at the free bankroll and SOL at balance minus the reserve', async () => {
    const info = await service.available();
    expect(info.hasWallet).toBe(true);
    expect(info.withdrawableUsdcBase).toBe('120000000'); // no positions -> all cash
    expect(info.withdrawableSolBase).toBe(String(50_000_000 - 5_000_000));
    expect(info.solReserveLamports).toBe('5000000');
  });
});

describe('send() gates', () => {
  it('refuses without the typed confirmation word', async () => {
    const r = await service.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '10',
      walletSecret: SECRET,
      confirm: 'yes',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('refuses malformed destinations and self-sends', async () => {
    const bad = await service.send({
      asset: 'USDC',
      destination: 'not-an-address',
      amount: '10',
      walletSecret: SECRET,
      confirm: 'SEND',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('DESTINATION_INVALID');

    const self = await service.send({
      asset: 'USDC',
      destination: walletPublicKey(dir)!,
      amount: '10',
      walletSecret: SECRET,
      confirm: 'SEND',
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.code).toBe('DESTINATION_IS_SELF');
  });

  it('refuses a wrong wallet secret and never broadcasts', async () => {
    const before = broadcasts.length;
    const r = await service.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '10',
      walletSecret: 'wrong-secret-1234567890',
      confirm: 'SEND',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WALLET_UNLOCK_FAILED');
    expect(broadcasts.length).toBe(before);
  });

  it('refuses amounts above the free bankroll even when the chain holds more', async () => {
    // $30 deployed in an open position -> cash = 120.003 - 30.0X.
    seedOpenPosition('30000000', '15000');
    const r = await service.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '100',
      walletSecret: SECRET,
      confirm: 'SEND',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INSUFFICIENT_AVAILABLE');
      expect(r.error).toContain('open positions');
    }
  });

  it('refuses SOL that would eat the fee reserve', async () => {
    const r = await service.send({
      asset: 'SOL',
      destination: VALID_DESTINATION,
      amount: '0.05',
      walletSecret: SECRET,
      confirm: 'SEND',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INSUFFICIENT_AVAILABLE');
  });
});

describe('send() success path', () => {
  it('broadcasts, blocks entries while in flight, and audits without the secret', async () => {
    let entriesAllowedDuringSend: boolean | null = null;
    const observing: Broadcaster = async (request) => {
      entriesAllowedDuringSend = control.entriesAllowed();
      return broadcaster(request);
    };
    const svc = new WithdrawalService(
      handle.db,
      config,
      control,
      heliusFake,
      120_003_000n,
      observing,
      createTradingLocks(),
    );

    const r = await svc.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '50',
      walletSecret: SECRET,
      confirm: 'SEND',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signature).toBe('sig_fake_1');
      expect(r.amountBase).toBe('50000000');
      expect(r.unconfirmed).toBe(false);
    }
    // Entries were blocked during the broadcast, and restored afterwards.
    expect(entriesAllowedDuringSend).toBe(false);
    expect(control.entriesAllowed()).toBe(true);
    // The broadcaster received the decrypted 64-byte key (never logged).
    const last = broadcasts[broadcasts.length - 1]!;
    expect(last.secretLen).toBe(64);

    const audit = repo.listAudit(handle.db, 20);
    const row = audit.find((a) => a.message === 'withdrawal sent');
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('reports an unconfirmed broadcast as ok+unconfirmed (never retried)', async () => {
    nextOutcome = { kind: 'unknown', signature: 'sig_fake_unknown', detail: 'timeout' };
    const r = await service.send({
      asset: 'SOL',
      destination: VALID_DESTINATION,
      amount: '0.01',
      walletSecret: SECRET,
      confirm: 'SEND',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unconfirmed).toBe(true);
    nextOutcome = { kind: 'filled', signature: 'sig_fake_1' };
  });

  it('surfaces a failed broadcast as an error', async () => {
    nextOutcome = { kind: 'failed', error: 'blockhash expired' };
    const r = await service.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '1',
      walletSecret: SECRET,
      confirm: 'SEND',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TRANSFER_FAILED');
    nextOutcome = { kind: 'filled', signature: 'sig_fake_1' };
  });

  it('replays the same idempotency key without broadcasting twice', async () => {
    const request = {
      asset: 'USDC' as const,
      destination: VALID_DESTINATION,
      amount: '5',
      walletSecret: SECRET,
      confirm: 'SEND',
      idempotencyKey: 'withdraw-key-123',
    };
    const first = await service.send(request);
    expect(first.ok).toBe(true);
    const second = await service.send(request);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.signature).toBe('sig_fake_1');
    expect(broadcasts).toHaveLength(1);
  });

  it('blocks a second withdrawal while one is unknown', async () => {
    nextOutcome = { kind: 'unknown', signature: 'sig_fake_unknown', detail: 'timeout' };
    const first = await service.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '5',
      walletSecret: SECRET,
      confirm: 'SEND',
      idempotencyKey: 'withdraw-unknown-1',
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.unconfirmed).toBe(true);

    const second = await service.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '5',
      walletSecret: SECRET,
      confirm: 'SEND',
      idempotencyKey: 'withdraw-unknown-2',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('WITHDRAWAL_PENDING');
    expect(broadcasts).toHaveLength(1);
    nextOutcome = { kind: 'filled', signature: 'sig_fake_1' };
  });

  it('refuses to sign in paper mode even with a funded wallet', async () => {
    const paper = loadConfig({ SESSION_SECRET: 'x'.repeat(40), DATA_DIR: dir, MODE: 'paper' });
    const paperService = new WithdrawalService(
      handle.db,
      paper,
      control,
      heliusFake,
      120_003_000n,
      broadcaster,
      createTradingLocks(),
    );
    const r = await paperService.send({
      asset: 'USDC',
      destination: VALID_DESTINATION,
      amount: '5',
      walletSecret: SECRET,
      confirm: 'SEND',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MODE_UNSUPPORTED');
    expect(broadcasts).toHaveLength(0);
  });
});

describe('SPL instruction encoding', () => {
  it('encodes TransferChecked as tag 12 + u64 LE amount + decimals', () => {
    const data = splTransferCheckedData(1_500_000n, 6);
    expect(data[0]).toBe(12);
    expect(data[9]).toBe(6);
    // 1_500_000 = 0x16E360 -> little-endian [0x60, 0xE3, 0x16, 0…]
    expect(Array.from(data.slice(1, 9))).toEqual([0x60, 0xe3, 0x16, 0, 0, 0, 0, 0]);
  });
});
