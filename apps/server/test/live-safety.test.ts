import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig, type RiskConfig } from '@zcode-bot/config';
import type { LeaderTxSummary } from '@zcode-bot/core';
import {
  NoopNotifier,
  StaticPriceProvider,
  type HeliusProvider,
  type JupiterProvider,
} from '@zcode-bot/providers';
import { CopyEngine, type ReconciliationReader } from '../src/services/engine.js';
import { ControlService } from '../src/services/control.js';
import type { Executor, ExecutionHooks, ExecOutcome, IntentSpec } from '../src/services/executors.js';
import { sendSignedTransaction } from '../src/services/sendPath.js';
import { assembleJupiterBuild } from '../src/services/txBuild.js';
import { readinessReport } from '../src/services/readiness.js';
import { generateWalletFile } from '../src/wallet.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEOW = 'MeowMint111111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ZERO_BLOCKHASH = '11111111111111111111111111111111';

let dir: string;
let handle: DbHandle;
let config: AppConfig;
let risk: RiskConfig;

const prices = new StaticPriceProvider(
  new Map([
    [USDC, 1_000_000n],
    [MEOW, 500_000n],
  ]),
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-live-safety-'));
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
  config = loadConfig({ SESSION_SECRET: 'l'.repeat(48) });
  risk = config.risk;
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function cuIx(limit = 200_000): TransactionInstruction {
  const data = Buffer.alloc(5);
  data[0] = 2; // SetComputeUnitLimit
  data.writeUInt32LE(limit, 1);
  return new TransactionInstruction({ programId: new PublicKey(COMPUTE), keys: [], data });
}

function jupIx(payer: PublicKey, extra?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(JUP),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      ...(extra ? [{ pubkey: extra, isSigner: false, isWritable: false }] : []),
    ],
    data: Buffer.from([]),
  });
}

function serializedTransaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  alt?: AddressLookupTableAccount,
  secondSigner?: PublicKey,
): string {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: ZERO_BLOCKHASH,
    instructions,
  });
  const compiled = alt ? message.compileToV0Message([alt]) : message.compileToLegacyMessage();
  if (secondSigner) {
    // Adding a required signer is enough; the signature bytes are irrelevant.
    const tx = new VersionedTransaction(compiled);
    return Buffer.from(tx.serialize()).toString('base64');
  }
  return Buffer.from(new VersionedTransaction(compiled).serialize()).toString('base64');
}

describe('transaction assembly validation', () => {
  it('rejects a build with no swap instruction', () => {
    const payer = Keypair.generate().publicKey;
    expect(() =>
      assembleJupiterBuild(
        { computeBudgetInstructions: [{ programId: COMPUTE, data: cuIx().data.toString('base64') }] },
        { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 1, payer: payer.toBase58() },
      ),
    ).toThrow(/no swapInstruction/);
  });

  it('rejects a swap program that is not a known Jupiter aggregator', () => {
    const payer = Keypair.generate().publicKey;
    expect(() =>
      assembleJupiterBuild(
        {
          computeBudgetInstructions: [{ programId: COMPUTE, data: cuIx().data.toString('base64') }],
          swapInstruction: { programId: SystemProgram.programId.toBase58(), accounts: [], data: '' },
        },
        { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 1, payer: payer.toBase58() },
      ),
    ).toThrow(/not a known aggregator/);
  });

  it('rejects a build without a compute-unit limit', () => {
    const payer = Keypair.generate().publicKey;
    expect(() =>
      assembleJupiterBuild(
        {
          swapInstruction: {
            programId: JUP,
            accounts: [{ pubkey: payer.toBase58(), isSigner: true, isWritable: true }],
            data: '',
          },
        },
        { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 1, payer: payer.toBase58() },
      ),
    ).toThrow(/SetComputeUnitLimit/);
  });

  it('rejects a swapTransaction whose fee payer is not our wallet', () => {
    const builtFor = Keypair.generate().publicKey;
    const ourWallet = Keypair.generate().publicKey;
    const base64 = serializedTransaction(builtFor, [cuIx(), jupIx(builtFor)]);
    expect(() =>
      assembleJupiterBuild(
        { swapTransaction: base64 },
        { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 1, payer: ourWallet.toBase58() },
      ),
    ).toThrow(/fee payer/);
  });

  it('rejects a swapTransaction with an unexpected second signer', () => {
    const payer = Keypair.generate().publicKey;
    const extraSigner = Keypair.generate();
    const ix = new TransactionInstruction({
      programId: new PublicKey(JUP),
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: extraSigner.publicKey, isSigner: true, isWritable: true },
      ],
      data: Buffer.from([]),
    });
    const base64 = serializedTransaction(payer, [cuIx(), ix]);
    // The compiler only marks the payer as a signer unless the key appears in
    // a signer position; build a message with the extra signer explicitly.
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: ZERO_BLOCKHASH,
      instructions: [
        cuIx(),
        new TransactionInstruction({
          programId: new PublicKey(JUP),
          keys: [{ pubkey: extraSigner.publicKey, isSigner: true, isWritable: false }],
          data: Buffer.from([]),
        }),
        ix,
      ],
    }).compileToLegacyMessage();
    const signedSlots = new VersionedTransaction(message).serialize();
    expect(() =>
      assembleJupiterBuild(
        { swapTransaction: Buffer.from(signedSlots).toString('base64') },
        { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 1, payer: payer.toBase58() },
      ),
    ).toThrow(/signers/);
    expect(base64.length).toBeGreaterThan(0);
  });

  it('rejects a transaction that exceeds 1232 bytes after the tip', () => {
    const payer = Keypair.generate().publicKey;
    expect(() =>
      assembleJupiterBuild(
        {
          computeBudgetInstructions: [{ programId: COMPUTE, data: cuIx().data.toString('base64') }],
          swapInstruction: {
            programId: JUP,
            accounts: [{ pubkey: payer.toBase58(), isSigner: true, isWritable: true }],
            data: Buffer.alloc(1_200).toString('base64'),
          },
        },
        { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 1, payer: payer.toBase58() },
      ),
    ).toThrow(/1232-byte limit/);
  });

  it('accepts a valid legacy build and appends the Sender tip', () => {
    const payer = Keypair.generate().publicKey;
    const built = assembleJupiterBuild(
      {
        computeBudgetInstructions: [{ programId: COMPUTE, data: cuIx().data.toString('base64') }],
        swapInstruction: {
          programId: JUP,
          accounts: [{ pubkey: payer.toBase58(), isSigner: true, isWritable: true }],
          data: '',
        },
      },
      { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 9, payer: payer.toBase58() },
    );
    expect(built.kind).toBe('legacy');
    expect(built.tipLamports).toBe(5_000);
    expect(built.tipAccount).toBeTruthy();
    expect(() => VersionedTransaction.deserialize(Buffer.from(built.base64, 'base64'))).not.toThrow();
  });

  it('accepts a v0 build with a resolved lookup table', () => {
    const payer = Keypair.generate().publicKey;
    const lookupAddress = Keypair.generate().publicKey;
    const alt = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [lookupAddress],
      },
    });
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: ZERO_BLOCKHASH,
      instructions: [cuIx(), jupIx(payer, lookupAddress)],
    }).compileToV0Message([alt]);
    const base64 = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
    const built = assembleJupiterBuild(
      { swapTransaction: base64 },
      { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 9, payer: payer.toBase58(), altAccounts: [alt] },
    );
    expect(built.kind).toBe('v0');
    const roundTrip = VersionedTransaction.deserialize(Buffer.from(built.base64, 'base64'));
    expect(roundTrip.message.version).toBe(0);
  });
});

describe('send path classification', () => {
  const base = {
    signedBase64: 'signed',
    expectedSignature: 'local-signature',
    heliusRpcUrl: 'https://helius.example',
    publicRpcUrl: 'https://public.example',
    apiKey: 'k',
  };
  const json = (result: string | undefined, status = 200, error?: string) =>
    new Response(JSON.stringify(error ? { error: { message: error } } : { result }), { status });

  it('treats a mismatched provider signature as unknown, never sent', async () => {
    const out = await sendSignedTransaction({
      ...base,
      fetchImpl: (async () => json('someone-elses-signature')) as typeof fetch,
    });
    expect(out.kind).toBe('unknown');
    if (out.kind === 'unknown') expect(out.signature).toBe('local-signature');
  });

  it('does not trust a matching signature from a 5xx response', async () => {
    const out = await sendSignedTransaction({
      ...base,
      trySender: false,
      allowStaked: () => false,
      fetchImpl: (async () => json('local-signature', 503)) as typeof fetch,
    });
    expect(out.kind).toBe('unknown');
  });

  it('classifies a preflight rejection as a definitive failure', async () => {
    const out = await sendSignedTransaction({
      ...base,
      trySender: false,
      allowStaked: () => false,
      fetchImpl: (async () =>
        json(undefined, 200, 'Transaction simulation failed: blockhash not found')) as typeof fetch,
    });
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.signature).toBeNull();
  });

  it('treats already-processed as sent with the local signature', async () => {
    const out = await sendSignedTransaction({
      ...base,
      trySender: false,
      allowStaked: () => false,
      fetchImpl: (async () =>
        json(undefined, 200, 'This transaction has already been processed')) as typeof fetch,
    });
    expect(out).toEqual({ kind: 'sent', signature: 'local-signature', via: 'public' });
  });

  it('stops after a transport error and reports unknown', async () => {
    let calls = 0;
    const out = await sendSignedTransaction({
      ...base,
      fetchImpl: (async () => {
        calls++;
        throw new Error('socket hang up');
      }) as typeof fetch,
    });
    expect(out.kind).toBe('unknown');
    expect(calls).toBe(1);
  });
});

// --- live engine: durable signed state + reconciliation ----------------------

function leaderBuy(usdMicro: bigint, mint: string, signature: string): LeaderTxSummary {
  return {
    chain: 'solana',
    leaderAddress: 'LeaderLiveSafety11111111111111111111111111',
    signature,
    slot: 1000,
    transactionIndex: 1,
    blockTime: Math.floor(Date.now() / 1000),
    err: false,
    nativeDeltaBase: 0n,
    programs: [JUP],
    tokenDeltas: [
      { mint, decimals: 6, preBase: 0n, postBase: 9_000_000n, deltaBase: 9_000_000n },
      { mint: USDC, decimals: 6, preBase: usdMicro, postBase: 0n, deltaBase: -usdMicro },
    ],
  };
}

function seedSeat(candidateId: string, activationId: string): void {
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
  repo.createActivation(handle.db, {
    activationId,
    candidateId,
    mode: 'live',
    state: 'ACTIVE',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'test',
    replacesActivationId: null,
  });
}

class HookingLiveExecutor implements Executor {
  readonly mode = 'live' as const;
  constructor(
    private outcome: (spec: IntentSpec) => ExecOutcome,
    private signature = 'sig-live-1',
  ) {}

  async quote(): Promise<{
    slippageBps: number;
    priceImpactBps: number;
    minOutputBase: string;
    source: 'jupiter';
  }> {
    return { slippageBps: 0, priceImpactBps: 0, minOutputBase: '0', source: 'jupiter' };
  }

  async execute(spec: IntentSpec, _quote: unknown, hooks: ExecutionHooks = {}): Promise<ExecOutcome> {
    await hooks.beforeSign?.({ buildKind: 'legacy' });
    const info = {
      signature: this.signature,
      blockhash: 'blockhash-1',
      lastValidBlockHeight: 100,
      signedBase64: 'c2lnbmVk',
      buildKind: 'legacy' as const,
    };
    await hooks.afterSign?.(info);
    await hooks.beforeSign?.({ buildKind: 'legacy' });
    await hooks.afterSubmit?.({ ...info, via: 'sender' });
    return this.outcome(spec);
  }

  async availableBalance(): Promise<bigint | null> {
    return null;
  }

  async availableSolLamports(): Promise<number | null> {
    return 1_000_000_000;
  }
}

function engineWith(executor: Executor): { engine: CopyEngine; control: ControlService } {
  const control = new ControlService(handle.db);
  const engine = new CopyEngine(
    handle.db,
    risk,
    prices,
    executor,
    control,
    new NoopNotifier(),
    { onFired: () => {}, onStateChanged: () => {} },
    'Fksjc9dLJHtCXCqXbJfRjQUmBUKtqivYFte2kGCLsV4i',
    1_000_000_000n,
    true,
  );
  return { engine, control };
}

describe('durable signed state and chain reconciliation', () => {
  it('persists signed/submitted evidence before the send and resolves a confirmed entry', async () => {
    seedSeat('cand_live_recon', 'act_live_recon');
    const { engine, control } = engineWith(
      new HookingLiveExecutor(() => ({
        kind: 'unknown',
        detail: 'confirmation timeout',
        signature: 'sig-live-1',
      })),
    );
    control.armLive();
    await engine.handleLeaderTx(
      'act_live_recon',
      'cand_live_recon',
      leaderBuy(40_000_000n, MEOW, 'sig_buy_1'),
    );

    const intents = repo.intentsInStates(handle.db, ['requires_reconciliation'], 'live');
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.txSignature).toBe('sig-live-1');
    expect(intent.blockhash).toBe('blockhash-1');
    expect(intent.lastValidBlockHeight).toBe(100);
    expect(intent.signedTxBase64).toBe('c2lnbmVk');
    const cases = repo.openReconciliationCases(handle.db, 'live');
    expect(cases).toHaveLength(1);
    expect(cases[0]!.signature).toBe('sig-live-1');

    const reader: ReconciliationReader = {
      signatureStatus: async () => ({ found: true, err: null, confirmationStatus: 'confirmed' }),
      blockHeight: async () => 200,
      transactionDetail: async () => ({
        err: null,
        slot: 123,
        blockTime: Math.floor(Date.now() / 1000),
        tokenDeltas: {
          [MEOW]: { pre: 0n, post: 9_000_000n },
          [USDC]: { pre: 0n, post: 0n },
        },
        solLamportsDelta: 0n,
        feeLamports: 5_000,
        tipLamports: 5_000,
      }),
    };
    const result = await engine.reconcileSignedIntents(reader);
    expect(result.confirmed).toBe(1);

    const confirmed = repo.getIntent(handle.db, intent.intentId)!;
    expect(confirmed.state).toBe('confirmed');
    const positions = repo.openPositions(handle.db, 'live');
    expect(positions).toHaveLength(1);
    expect(positions[0]!.mint).toBe(MEOW);
    expect(positions[0]!.remainingTokenBase).toBe('9000000');
    expect(repo.openReconciliationCases(handle.db, 'live')).toHaveLength(0);
  });

  it('marks a signed entry failed only when the chain proves it expired', async () => {
    seedSeat('cand_live_expired', 'act_live_expired');
    const { engine, control } = engineWith(
      new HookingLiveExecutor(
        () => ({ kind: 'unknown', detail: 'timeout', signature: 'sig-live-2' }),
        'sig-live-2',
      ),
    );
    control.armLive();
    await engine.handleLeaderTx(
      'act_live_expired',
      'cand_live_expired',
      leaderBuy(40_000_000n, MEOW, 'sig_buy_2'),
    );

    const reader: ReconciliationReader = {
      signatureStatus: async () => ({ found: false, err: null }),
      blockHeight: async () => 1_000,
      transactionDetail: async () => null,
    };
    const result = await engine.reconcileSignedIntents(reader);
    expect(result.failed).toBe(1);
    const intents = repo.intentsInStates(handle.db, ['failed'], 'live');
    expect(intents).toHaveLength(1);
    expect(intents[0]!.reason).toContain('expired without landing');
    expect(repo.openPositions(handle.db, 'live')).toHaveLength(0);
    expect(repo.openReconciliationCases(handle.db, 'live')).toHaveLength(0);
  });

  it('leaves an unconfirmed signed entry pending while the blockhash is live', async () => {
    seedSeat('cand_live_pending', 'act_live_pending');
    const { engine, control } = engineWith(
      new HookingLiveExecutor(
        () => ({ kind: 'unknown', detail: 'timeout', signature: 'sig-live-3' }),
        'sig-live-3',
      ),
    );
    control.armLive();
    await engine.handleLeaderTx(
      'act_live_pending',
      'cand_live_pending',
      leaderBuy(40_000_000n, MEOW, 'sig_buy_3'),
    );

    const reader: ReconciliationReader = {
      signatureStatus: async () => ({ found: false, err: null }),
      blockHeight: async () => 50,
      transactionDetail: async () => null,
    };
    const result = await engine.reconcileSignedIntents(reader);
    expect(result.pending).toBe(1);
    expect(repo.intentsInStates(handle.db, ['requires_reconciliation'], 'live')).toHaveLength(1);
    expect(repo.openReconciliationCases(handle.db, 'live')).toHaveLength(1);
  });

  it('does not mark an intent failed when the status read itself failed', async () => {
    seedSeat('cand_live_rpc', 'act_live_rpc');
    const { engine, control } = engineWith(
      new HookingLiveExecutor(
        () => ({ kind: 'unknown', detail: 'timeout', signature: 'sig-live-4' }),
        'sig-live-4',
      ),
    );
    control.armLive();
    await engine.handleLeaderTx('act_live_rpc', 'cand_live_rpc', leaderBuy(40_000_000n, MEOW, 'sig_buy_4'));

    const reader: ReconciliationReader = {
      signatureStatus: async () => null,
      blockHeight: async () => 1_000,
      transactionDetail: async () => null,
    };
    const result = await engine.reconcileSignedIntents(reader);
    expect(result.pending).toBe(1);
    expect(repo.intentsInStates(handle.db, ['failed'], 'live')).toHaveLength(0);
  });

  it('flattens a frozen late fill and resolves its case', async () => {
    seedSeat('cand_late_fill', 'act_late_fill');
    const positionId = 'pos_late_fill';
    repo.insertPosition(handle.db, {
      positionId,
      activationId: 'act_late_fill',
      candidateId: 'cand_late_fill',
      mode: 'live',
      mint: MEOW,
      mintSymbol: 'MEOW',
      status: 'requires_reconciliation',
      entryIntentId: null,
      inputMint: USDC,
      inputUsdMicro: '10000000',
      remainingCostBasisUsdMicro: '10000000',
      remainingFeesUsdMicro: '0',
      copiedTokenBase: '9000000',
      remainingTokenBase: '9000000',
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: '0',
      mintDecimals: 6,
      inputDecimals: 6,
      openedAt: new Date().toISOString(),
      closedAt: null,
      closeReason: null,
    });
    const caseId = repo.insertReconciliationCase(handle.db, {
      kind: 'late_fill',
      mode: 'live',
      intentId: null,
      positionId,
      signature: 'sig-late-entry',
      status: 'open',
      detail: 'fill landed after the seat left ACTIVE [intent:intent_late]',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });

    const engine = engineWith(
      new HookingLiveExecutor((spec) => ({
        kind: 'filled',
        signature: 'sig-late-exit',
        inputAmountBase: spec.inputAmountBase,
        outputAmountBase: '5000000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'confirmed',
      })),
    ).engine;
    const reader: ReconciliationReader = {
      signatureStatus: async () => ({ found: false, err: null }),
      blockHeight: async () => 50,
      transactionDetail: async () => null,
    };
    const result = await engine.reconcileSignedIntents(reader);
    expect(result.lateFillsClosed).toBe(1);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('closed');
    const openCases = repo.openReconciliationCases(handle.db, 'live');
    expect(openCases.some((c) => c.id === caseId)).toBe(false);
  });

  it('does not re-close a late fill while an exit outcome is ambiguous', async () => {
    seedSeat('cand_late_guard', 'act_late_guard');
    const positionId = 'pos_late_guard';
    repo.insertPosition(handle.db, {
      positionId,
      activationId: 'act_late_guard',
      candidateId: 'cand_late_guard',
      mode: 'live',
      mint: MEOW,
      mintSymbol: 'MEOW',
      status: 'requires_reconciliation',
      entryIntentId: null,
      inputMint: USDC,
      inputUsdMicro: '10000000',
      remainingCostBasisUsdMicro: '10000000',
      remainingFeesUsdMicro: '0',
      copiedTokenBase: '9000000',
      remainingTokenBase: '9000000',
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: '0',
      mintDecimals: 6,
      inputDecimals: 6,
      openedAt: new Date().toISOString(),
      closedAt: null,
      closeReason: null,
    });
    repo.insertReconciliationCase(handle.db, {
      kind: 'late_fill',
      mode: 'live',
      intentId: null,
      positionId,
      signature: 'sig-late-entry',
      status: 'open',
      detail: 'fill landed after the seat left ACTIVE',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const exitIntentId = 'intent_late_guard_exit';
    const now = new Date().toISOString();
    repo.insertIntent(handle.db, {
      intentId: exitIntentId,
      kind: 'exit',
      mode: 'live',
      activationId: 'act_late_guard',
      candidateId: 'cand_late_guard',
      positionId,
      mint: MEOW,
      inputMint: MEOW,
      inputAmountBase: '9000000',
      inputUsdMicro: '5000000',
      inputDecimals: 6,
      outputDecimals: 6,
      state: 'requires_reconciliation',
      idempotencyKey: 'idem_late_guard',
      txSignature: 'sig-unknown-exit',
      reason: 'confirmation timeout',
      createdAt: now,
      updatedAt: now,
    });
    const exitCaseId = repo.insertReconciliationCase(handle.db, {
      kind: 'unknown_execution',
      mode: 'live',
      intentId: exitIntentId,
      positionId,
      signature: 'sig-unknown-exit',
      status: 'open',
      detail: 'confirmation timeout',
      createdAt: now,
      resolvedAt: null,
    });

    const engine = engineWith(
      new HookingLiveExecutor(() => {
        throw new Error('the ambiguous exit must not be re-signed');
      }),
    ).engine;
    const reader: ReconciliationReader = {
      signatureStatus: async () => ({ found: false, err: null }),
      blockHeight: async () => 50,
      transactionDetail: async () => null,
    };
    const result = await engine.reconcileSignedIntents(reader);
    expect(result.lateFillsClosed).toBe(0);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('requires_reconciliation');
    expect(repo.getIntent(handle.db, exitIntentId)!.state).toBe('requires_reconciliation');
    expect(repo.openReconciliationCases(handle.db, 'live').some((c) => c.id === exitCaseId)).toBe(true);
  });
});

// --- readiness: on-chain USDC must match the book cash ----------------------

describe('live readiness cash reconciliation', () => {
  function liveConfig(walletFile: string): AppConfig {
    const cfg = loadConfig({
      SESSION_SECRET: 'z'.repeat(48),
      MODE: 'live',
      LIVE_TRADING: 'true',
      LIVE_TRADING_ACK: 'I UNDERSTAND LIVE MODE SIGNS AND SUBMITS REAL SOLANA TRANSACTIONS WITH REAL FUNDS',
      DATA_DIR: dir,
      WALLET_FILE: walletFile,
      EQUITY_START_USD: '100',
      HELIUS_API_KEY: 'helius-key',
      JUPITER_API_KEY: 'jupiter-key',
      JUPITER_BASE_URL: 'https://api.jup.ag',
    });
    cfg.env.DATA_DIR = dir;
    return cfg;
  }

  function fakeDeps(usdcBase: bigint) {
    return {
      helius: {
        solBalanceLamports: async () => 1_000_000_000,
        tokenBalanceBase: async () => usdcBase,
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
        chainTime: async () => Math.floor(Date.now() / 1000),
      } as unknown as HeliusProvider,
      jupiter: {
        healthCheck: async () => ({ ok: true, latencyMs: 1 }),
      } as unknown as JupiterProvider,
      monitorExpected: true,
      databaseIntegrityOk: () => true,
    };
  }

  it('passes only when the wallet USDC matches capital minus deployed', async () => {
    const walletFile = join(dir, 'wallet.json');
    generateWalletFile(dir, 'readiness-passphrase', new Date(), walletFile);
    const cfg = liveConfig(walletFile);
    repo.createUser(handle.db, 'admin', 'hash');
    const control = new ControlService(handle.db);
    const passing = await readinessReport(handle.db, cfg, control, null, true, fakeDeps(100_000_000n));
    expect(passing.ready).toBe(true);
    expect(passing.items.find((i) => i.id === 'cash_reconciliation')!.ok).toBe(true);

    const failing = await readinessReport(handle.db, cfg, control, null, true, fakeDeps(90_000_000n));
    expect(failing.ready).toBe(false);
    expect(failing.items.find((i) => i.id === 'cash_reconciliation')!.ok).toBe(false);
  });
});
