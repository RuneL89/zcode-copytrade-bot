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
import type { PriceProvider } from '@zcode-bot/providers';
import { CopyEngine, EXIT_QUEUE_MAX_ATTEMPTS, remainingAfterForSale } from '../src/services/engine.js';
import { ControlService } from '../src/services/control.js';
import { PaperExecutor } from '../src/services/executors.js';
import type { ExecOutcome, Executor, IntentSpec, QuoteCheck } from '../src/services/executors.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Executor whose behaviour each test scripts; records the specs it received. */
class ScriptedExecutor implements Executor {
  readonly mode = 'live' as const;
  specs: IntentSpec[] = [];
  constructor(
    private script: Array<ExecOutcome>,
    private onChain: bigint | null = null,
    private solLamports: number | null = 1_000_000_000,
  ) {}

  async quote(spec: IntentSpec): Promise<QuoteCheck> {
    this.specs.push(spec);
    return { slippageBps: 0, priceImpactBps: 0, minOutputBase: '0', source: 'jupiter' };
  }

  async execute(spec: IntentSpec): Promise<ExecOutcome> {
    const next = this.script.shift();
    if (!next)
      return {
        kind: 'filled',
        signature: 'sig',
        inputAmountBase: spec.inputAmountBase,
        outputAmountBase: '0',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'confirmed',
      };
    if (next.kind === 'filled') {
      return { ...next, inputAmountBase: spec.inputAmountBase };
    }
    return next;
  }

  async availableBalance(): Promise<bigint | null> {
    return this.onChain;
  }

  async availableSolLamports(): Promise<number | null> {
    return this.solLamports;
  }
}

const prices: PriceProvider = {
  priceOf: async () => ({ priceUsdMicro: 1_000_000n, observedAt: new Date().toISOString(), source: 'test' }),
  priceSolUsdMicro: async () => ({
    priceUsdMicro: 150_000_000n,
    observedAt: new Date().toISOString(),
    source: 'test',
  }),
} as unknown as PriceProvider;

const notifier = { notify: async () => {}, enabled: false } as never;

let dir: string;
let handle: AppDatabase;
let config: AppConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-exit-safety-'));
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

function seedPosition(recordsBase: string, inputUsdMicro = '90000000') {
  const activationId = 'act_' + crypto.randomUUID();
  repo.createActivation(handle.db, {
    activationId,
    candidateId: 'cand_test',
    state: 'ACTIVE',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'manual',
  });
  const positionId = 'pos_' + crypto.randomUUID();
  repo.insertPosition(handle.db, {
    positionId,
    activationId,
    candidateId: 'cand_test',
    mint: 'MintGTA6',
    mintSymbol: 'GTA6',
    status: 'open',
    entryIntentId: null,
    inputMint: USDC,
    inputUsdMicro: inputUsdMicro,
    copiedTokenBase: recordsBase,
    remainingTokenBase: recordsBase,
    leaderTokenBase: null,
    realizedPnlUsdMicro: '0',
    feesUsdMicro: '0',
    openedAt: new Date(Date.now() - 3600_000).toISOString(),
    closedAt: null,
    closeReason: null,
  });
  return { activationId, positionId };
}

function engineWith(executor: Executor) {
  return new CopyEngine(
    handle.db,
    config.risk,
    prices,
    executor,
    new ControlService(handle.db),
    notifier,
    { onFired: () => {}, onStateChanged: () => {} },
    'Fksjc9dLJHtCXCqXbJfRjQUmBUKtqivYFte2kGCLsV4i',
    1_000_000_000n,
    true,
  );
}

function seedFailedExitIntent(
  positionId: string,
  activationId: string,
  inputBase = '1000',
  txSignature: string | null = null,
): string {
  const intentId = 'intent_' + crypto.randomUUID();
  repo.insertIntent(handle.db, {
    intentId,
    kind: 'exit',
    mode: 'live',
    activationId,
    candidateId: 'cand_test',
    positionId,
    mint: 'MintGTA6',
    inputMint: USDC,
    inputAmountBase: inputBase,
    inputUsdMicro: '1000000',
    state: 'failed',
    reason: 'pre-signature failure',
    txSignature,
    idempotencyKey: 'idem_' + crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return intentId;
}

function enqueueExit(positionId: string, intentId: string, overrides: Record<string, unknown> = {}): void {
  repo.kvSet(
    handle.db,
    `exit.queue:${positionId}`,
    JSON.stringify({
      at: new Date().toISOString(),
      attempt: 1,
      detail: 'pre-signature failure',
      intentId,
      exitBase: '1000',
      remainingBefore: '1000',
      remainingAfter: '0',
      full: true,
      closeReason: 'leader_exit',
      leaderSignature: null,
      ...overrides,
    }),
  );
}

describe('exit safety: sell what the wallet holds', () => {
  it('clamps the sell to the on-chain balance and clears the phantom remainder', async () => {
    const { positionId } = seedPosition('6153520309157');
    const executor = new ScriptedExecutor([]);
    executor['onChain'] = 6098849896889n; // real balance after nine quoted fills
    const engine = engineWith(executor);

    const result = await engine.closePosition(positionId, 'fire_close_all');
    expect(result).toBe('closed');
    expect(executor.specs[0]!.inputAmountBase).toBe('6098849896889');
    const position = repo.getPosition(handle.db, positionId)!;
    expect(position.remainingTokenBase).toBe('0');
    expect(position.status).toBe('closed');
  });

  it('falls back to the recorded amount when the balance read is unavailable', async () => {
    const { positionId } = seedPosition('1000');
    const executor = new ScriptedExecutor([], null);
    const engine = engineWith(executor);
    await engine.closePosition(positionId, 'fire_close_all');
    expect(executor.specs[0]!.inputAmountBase).toBe('1000');
  });

  it('charges the full remaining cost basis when a clamped sell closes the position', async () => {
    const { positionId } = seedPosition('6153520309157'); // $90 recorded basis
    const executor = new ScriptedExecutor([
      {
        kind: 'filled',
        signature: 'sig',
        inputAmountBase: '0',
        outputAmountBase: '87713984', // $87.71 proceeds
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'confirmed',
      },
    ]);
    executor['onChain'] = 6098849896889n; // 0.89% less than recorded
    const engine = engineWith(executor);

    const result = await engine.closePosition(positionId, 'fire_close_all');
    expect(result).toBe('closed');

    const lots = repo.listPnlLots(handle.db, 10).filter((l) => l.positionId === positionId);
    expect(lots).toHaveLength(1);
    // The whole $90 must be charged: no phantom basis left on the books.
    expect(lots[0]!.costBasisUsdMicro).toBe('90000000');
    expect(lots[0]!.pnlUsdMicro).toBe((87_713_984n - 90_000_000n).toString());
  });

  it('excludes fees from lot PnL: they are paid in SOL, not USDC capital', async () => {
    const { positionId } = seedPosition('1000', '1000000'); // $1 basis
    const executor = new ScriptedExecutor([
      {
        kind: 'filled',
        signature: 'sig',
        inputAmountBase: '0',
        outputAmountBase: '1050000', // $1.05 proceeds
        feeUsdMicro: '1500', // $0.0015 modelled fee estimate
        evidence: {},
        commitment: 'confirmed',
      },
    ]);
    const engine = engineWith(executor);

    const result = await engine.closePosition(positionId, 'fire_close_all');
    expect(result).toBe('closed');

    const lot = repo.listPnlLots(handle.db, 10).find((l) => l.positionId === positionId)!;
    // PnL is proceeds - cost ONLY; the fee estimate stays informational.
    expect(lot.pnlUsdMicro).toBe((1_050_000n - 1_000_000n).toString());
    expect(lot.feesUsdMicro).toBe('1500');
  });

  it('records a failed intent instead of selling when the balance is zero', async () => {
    const { positionId } = seedPosition('1000');
    const executor = new ScriptedExecutor([], 0n);
    const engine = engineWith(executor);
    const result = await engine.closePosition(positionId, 'fire_close_all');
    expect(result).toBe('failed');
    expect(executor.specs).toHaveLength(0); // no quote, no swap attempted
    const failedIntents = repo.intentsInStates(handle.db, ['failed']);
    expect(failedIntents[0]!.reason).toContain('on-chain balance is 0');
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('open');
  });
});

describe('remainingAfterForSale', () => {
  it('subtracts only this position’s sale, not the wallet’s other holdings', () => {
    // 25% of a 1,000-token position sold while the shared wallet holds 3,000.
    expect(remainingAfterForSale(1000n, 250n, false)).toBe(750n);
  });

  it('ends at zero on a full close even when the chain delivered less', () => {
    expect(remainingAfterForSale(1000n, 990n, true)).toBe(0n);
  });

  it('never goes negative', () => {
    expect(remainingAfterForSale(1000n, 1200n, false)).toBe(0n);
  });
});

describe('exit safety: a partial exit stays inside its own position', () => {
  it('does not absorb another chair’s tokens of the same mint', async () => {
    const { activationId, positionId } = seedPosition('1000');
    // The wallet also holds 2,000 tokens for a different chair's position.
    const executor = new ScriptedExecutor(
      [
        {
          kind: 'filled',
          signature: 'sig',
          inputAmountBase: '250',
          outputAmountBase: '1000000',
          feeUsdMicro: '0',
          evidence: {},
          commitment: 'confirmed',
        },
      ],
      3000n,
    );
    const engine = engineWith(executor);
    const summary = {
      chain: 'solana',
      leaderAddress: 'LeaderAddr',
      signature: 'lsig',
      slot: 1,
      transactionIndex: 0,
      blockTime: 1,
      err: false,
      nativeDeltaBase: 0n,
      tokenDeltas: [{ mint: 'MintGTA6', decimals: 6, preBase: 1000n, postBase: 750n, deltaBase: -250n }],
      programs: [],
    };
    const event = {
      kind: 'swap_sell' as const,
      signature: 'lsig',
      slot: 1,
      transactionIndex: 0,
      blockTime: 1,
      legIndex: 0,
      mint: 'MintGTA6',
      mintDecimals: 6,
      tokenDeltaBase: -250n,
      fundingMint: USDC,
      fundingDecimals: 6,
      fundingDeltaBase: 900000n,
      parserVersion: 'leader-parser/1',
    };
    await (
      engine as unknown as {
        handleLeaderSell: (
          activationId: string,
          candidateId: string,
          summary: unknown,
          event: unknown,
        ) => Promise<void>;
      }
    ).handleLeaderSell(activationId, 'cand_test', summary, event);

    expect(executor.specs[0]!.inputAmountBase).toBe('250');
    const position = repo.getPosition(handle.db, positionId)!;
    expect(position.remainingTokenBase).toBe('750');
    expect(position.status).toBe('partially_closed');
  });
});

describe('exit safety: retries and blocked fires', () => {
  it('retries a pre-submission failure and closes on the second attempt', async () => {
    const { positionId, activationId } = seedPosition('1000');
    const executor = new ScriptedExecutor([
      { kind: 'failed', error: 'jupiter: rate limited (429)' },
      {
        kind: 'filled',
        signature: 'sig2',
        inputAmountBase: '1000',
        outputAmountBase: '1000000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'confirmed',
      },
    ]);
    const engine = engineWith(executor);
    const result = await engine.closeAllForActivation(activationId);
    expect(result).toEqual({ closed: 1, unknown: 0, failed: 0 });
    expect(executor.specs).toHaveLength(2);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('closed');
  });

  it('reports a position as failed after every retry fails (the fire must stay blocked)', async () => {
    const { activationId } = seedPosition('1000');
    const executor = new ScriptedExecutor([
      { kind: 'failed', error: 'preflight rejected (not submitted): simulation failed' },
      { kind: 'failed', error: 'preflight rejected (not submitted): simulation failed' },
      { kind: 'failed', error: 'preflight rejected (not submitted): simulation failed' },
    ]);
    const engine = engineWith(executor);
    const result = await engine.closeAllForActivation(activationId);
    expect(result).toEqual({ closed: 0, unknown: 0, failed: 1 });
    expect(executor.specs).toHaveLength(3); // three attempts, then stop
  });

  it('keeps an unknown outcome un-retried (nothing is resent blind)', async () => {
    const { activationId } = seedPosition('1000');
    const executor = new ScriptedExecutor([
      { kind: 'unknown', detail: 'submitted sig; confirmation unknown' },
    ]);
    const engine = engineWith(executor);
    const result = await engine.closeAllForActivation(activationId);
    expect(result).toEqual({ closed: 0, unknown: 1, failed: 0 });
    expect(executor.specs).toHaveLength(1);
  });

  it('refuses to send when SOL is below the fee floor', async () => {
    const { positionId } = seedPosition('1000');
    const executor = new ScriptedExecutor([], 1000n, 1_000_000); // 0.001 SOL
    const engine = engineWith(executor);
    const result = await engine.closePosition(positionId, 'fire_close_all');
    expect(result).toBe('failed');
    expect(executor.specs).toHaveLength(0);
  });
});

describe('exit queue retry', () => {
  it('retries a pre-signature 429 and closes exactly once', async () => {
    const { positionId } = seedPosition('1000');
    const executor = new ScriptedExecutor([
      { kind: 'failed', error: 'paper simulation failed: jupiter: rate limited (429)' },
      {
        kind: 'filled',
        signature: 'sig-retry',
        inputAmountBase: '1000',
        outputAmountBase: '1000000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'confirmed',
      },
    ]);
    const engine = engineWith(executor);

    expect(await engine.closePosition(positionId, 'fire_close_all')).toBe('failed');
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toContain('rate limited');

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.retried).toBe(1);
    expect(retry.filled).toBe(1);
    expect(executor.specs).toHaveLength(2);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('closed');
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeUndefined();
    expect(repo.kvGet(handle.db, `exit.attempt:${positionId}`)).toBeUndefined();
    const lots = repo.listPnlLots(handle.db, 10).filter((lot) => lot.positionId === positionId);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.closedBase).toBe('1000');
  });

  it('retries on the paper executor path too', async () => {
    const { positionId } = seedPosition('1000');
    let priceCalls = 0;
    const paper = new PaperExecutor(null, async () => {
      priceCalls++;
      if (priceCalls === 1) throw new Error('jupiter: rate limited (429)');
      return 1_000_000n;
    });
    const engine = new CopyEngine(
      handle.db,
      config.risk,
      prices,
      paper,
      new ControlService(handle.db),
      notifier,
      { onFired: () => {}, onStateChanged: () => {} },
      null,
      1_000_000_000n,
      false,
    );

    expect(await engine.closePosition(positionId, 'leader_exit')).toBe('failed');
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeDefined();

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.filled).toBe(1);
    expect(priceCalls).toBe(2);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('closed');
  });

  it('never retries an intent that already has a signature', async () => {
    const { positionId, activationId } = seedPosition('1000');
    const intentId = seedFailedExitIntent(positionId, activationId, '1000', 'sig-signed');
    enqueueExit(positionId, intentId);
    const executor = new ScriptedExecutor([]);
    const engine = engineWith(executor);

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.retried).toBe(0);
    expect(retry.skipped).toBe(1);
    expect(executor.specs).toHaveLength(0);
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeUndefined();
  });

  it('never retries a position owned by reconciliation', async () => {
    const { positionId, activationId } = seedPosition('1000');
    const intentId = seedFailedExitIntent(positionId, activationId);
    enqueueExit(positionId, intentId);
    repo.updatePosition(handle.db, positionId, { status: 'requires_reconciliation' });
    const executor = new ScriptedExecutor([]);
    const engine = engineWith(executor);

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.retried).toBe(0);
    expect(retry.skipped).toBe(1);
    expect(executor.specs).toHaveLength(0);
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeUndefined();
  });

  it('stops after the bounded attempt count and audits exhaustion', async () => {
    const { positionId } = seedPosition('1000');
    const failed = { kind: 'failed' as const, error: 'preflight rejected (not submitted)' };
    const executor = new ScriptedExecutor([failed, failed, failed, failed]);
    const engine = engineWith(executor);

    await engine.closePosition(positionId, 'fire_close_all'); // attempt 1
    let retried = 0;
    for (let i = 0; i < EXIT_QUEUE_MAX_ATTEMPTS; i++) {
      retried += (await engine.retryQueuedExits(Date.now() + (i + 1) * 10 * 60_000)).retried;
    }

    expect(executor.specs).toHaveLength(EXIT_QUEUE_MAX_ATTEMPTS);
    expect(retried).toBe(EXIT_QUEUE_MAX_ATTEMPTS - 1);
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeUndefined();
    expect(repo.kvGet(handle.db, `exit.attempt:${positionId}`)).toBe(String(EXIT_QUEUE_MAX_ATTEMPTS));
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('open');
    expect(repo.listAudit(handle.db, 100).some((row) => row.message.includes('exit queue exhausted'))).toBe(
      true,
    );
  });

  it('skips a retry when the remaining base changed', async () => {
    const { positionId } = seedPosition('1000');
    const executor = new ScriptedExecutor([
      { kind: 'failed', error: 'paper simulation failed: jupiter: rate limited (429)' },
    ]);
    const engine = engineWith(executor);
    await engine.closePosition(positionId, 'fire_close_all');
    repo.updatePosition(handle.db, positionId, { remainingTokenBase: '900' });

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.retried).toBe(0);
    expect(retry.skipped).toBe(1);
    expect(executor.specs).toHaveLength(1);
    expect(repo.getPosition(handle.db, positionId)!.remainingTokenBase).toBe('900');
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeUndefined();
    expect(repo.listAudit(handle.db, 100).some((row) => row.message.includes('remaining base changed'))).toBe(
      true,
    );
  });

  it('skips a retry when the position is already closed', async () => {
    const { positionId } = seedPosition('1000');
    const executor = new ScriptedExecutor([
      { kind: 'failed', error: 'paper simulation failed: jupiter: rate limited (429)' },
    ]);
    const engine = engineWith(executor);
    await engine.closePosition(positionId, 'fire_close_all');
    repo.updatePosition(handle.db, positionId, {
      status: 'closed',
      remainingTokenBase: '0',
      closedAt: new Date().toISOString(),
    });

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.retried).toBe(0);
    expect(retry.skipped).toBe(1);
    expect(executor.specs).toHaveLength(1);
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeUndefined();
  });

  it('retries a legacy queue row when the failed intent proves the full size', async () => {
    const { positionId, activationId } = seedPosition('1000');
    seedFailedExitIntent(positionId, activationId, '1000');
    repo.kvSet(
      handle.db,
      `exit.queue:${positionId}`,
      JSON.stringify({
        at: new Date().toISOString(),
        attempt: 1,
        detail: 'paper simulation failed: jupiter: rate limited (429)',
      }),
    );
    const executor = new ScriptedExecutor([
      {
        kind: 'filled',
        signature: 'sig-legacy',
        inputAmountBase: '1000',
        outputAmountBase: '1000000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'confirmed',
      },
    ]);
    const engine = engineWith(executor);

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.filled).toBe(1);
    expect(executor.specs).toHaveLength(1);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('closed');
    expect(repo.kvGet(handle.db, `exit.queue:${positionId}`)).toBeUndefined();
  });

  it('re-sizes a partial retry from the unchanged remaining base', async () => {
    const { positionId, activationId } = seedPosition('1000');
    const intentId = seedFailedExitIntent(positionId, activationId, '400');
    enqueueExit(positionId, intentId, {
      exitBase: '400',
      remainingAfter: '600',
      full: false,
    });
    const executor = new ScriptedExecutor([
      {
        kind: 'filled',
        signature: 'sig-partial',
        inputAmountBase: '400',
        outputAmountBase: '400000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'confirmed',
      },
    ]);
    const engine = engineWith(executor);

    const retry = await engine.retryQueuedExits(Date.now() + 60_000);
    expect(retry.filled).toBe(1);
    expect(executor.specs[0]!.inputAmountBase).toBe('400');
    const position = repo.getPosition(handle.db, positionId)!;
    expect(position.status).toBe('partially_closed');
    expect(position.remainingTokenBase).toBe('600');
  });
});
