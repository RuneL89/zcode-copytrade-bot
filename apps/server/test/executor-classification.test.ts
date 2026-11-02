import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  LiveExecutor,
  isPreflightRejection,
  receivedOutputBase,
  type LiveConnection,
  type IntentSpec,
} from '../src/services/executors.js';
import type { JupiterProvider } from '@zcode-bot/providers';

const spec: IntentSpec = {
  intentId: 'intent_test',
  kind: 'fire_close',
  inputMint: 'MintGTA6',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inputAmountBase: '1000',
  inputDecimals: 6,
  outputDecimals: 6,
  inputUsdMicro: '9000000',
  slippageBpsCap: 450,
  userPublicKey: null,
};

/** One keypair for both the built transaction and the executor's signer. */
const SIGNER = Keypair.generate();

function serializedSwap(): string {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: SIGNER.publicKey, toPubkey: SIGNER.publicKey, lamports: 1 }),
  );
  tx.feePayer = SIGNER.publicKey;
  tx.recentBlockhash = '11111111111111111111111111111111';
  return Buffer.from(new VersionedTransaction(tx.compileMessage()).serialize()).toString('base64');
}

function jupiter(overrides: {
  quote?: () => Promise<unknown>;
  buildSwap?: () => Promise<unknown>;
}): JupiterProvider {
  return {
    quote: async () => ({
      inputMint: spec.inputMint,
      outputMint: spec.outputMint,
      inAmount: '1000',
      outAmount: '1500',
      otherAmountThreshold: '1400',
      priceImpactPct: '0.001',
    }),
    buildSwap: async () => ({ swapTransaction: serializedSwap() }),
    ...overrides,
  } as unknown as JupiterProvider;
}

function connection(overrides: Partial<LiveConnection> = {}, balances: string[] = []): LiveConnection {
  let call = 0;
  return {
    sendRawTransaction: async () => 'sig123',
    getLatestBlockhash: async () => ({ blockhash: 'x', lastValidBlockHeight: 1 }),
    confirmTransaction: async () => ({ value: { err: null } }),
    getParsedTokenAccountsByOwner: async () => {
      const amount = balances[Math.min(call++, balances.length - 1)] ?? '0';
      return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } }] };
    },
    getBalance: async () => 1_000_000_000,
    ...overrides,
  };
}

function liveExecutor(j: JupiterProvider, conn: LiveConnection): LiveExecutor {
  return new LiveExecutor(j, 'http://fake', SIGNER.secretKey, SIGNER.publicKey.toBase58(), () => conn);
}

describe('pre-submission failures are retryable (failed), never unknown', () => {
  it('classifies a quote error as failed', async () => {
    const ex = liveExecutor(
      jupiter({
        quote: async () => {
          throw new Error('jupiter: rate limited (429)');
        },
      }),
      connection(),
    );
    const out = await ex.execute(spec, {} as never);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.error).toContain('quote failed before submission');
  });

  it('classifies a build error as failed', async () => {
    const ex = liveExecutor(
      jupiter({
        buildSwap: async () => {
          throw new Error('400 bad route');
        },
      }),
      connection(),
    );
    const out = await ex.execute(spec, {} as never);
    expect(out.kind).toBe('failed');
  });

  it('classifies a preflight simulation rejection as failed, not unknown', async () => {
    const ex = liveExecutor(
      jupiter({}),
      connection({
        sendRawTransaction: async () => {
          throw new Error(
            'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1788.',
          );
        },
      }),
    );
    const out = await ex.execute(spec, {} as never);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.error).toContain('preflight rejected');
  });

  it('keeps an ambiguous send error unknown (never blind-retried)', async () => {
    const ex = liveExecutor(
      jupiter({}),
      connection({
        sendRawTransaction: async () => {
          throw new Error('fetch failed: socket hang up');
        },
      }),
    );
    const out = await ex.execute(spec, {} as never);
    expect(out.kind).toBe('unknown');
  });

  it('keeps a post-send confirmation failure unknown', async () => {
    const ex = liveExecutor(
      jupiter({}),
      connection({
        confirmTransaction: async () => {
          throw new Error('ws timeout');
        },
      }),
    );
    const out = await ex.execute(spec, {} as never);
    expect(out.kind).toBe('unknown');
  });

  it('records the actually received amount, not the quoted amount', async () => {
    // pre 1000, post 2400 -> received 1400 (quote said 1500)
    const ex = liveExecutor(jupiter({}), connection({}, ['1000', '2400']));
    const out = await ex.execute(spec, {} as never);
    expect(out.kind).toBe('filled');
    if (out.kind === 'filled') expect(out.outputAmountBase).toBe('1400');
  });

  it('falls back to the quote when a balance read fails', async () => {
    const ex = liveExecutor(
      jupiter({}),
      connection({
        getParsedTokenAccountsByOwner: async () => {
          throw new Error('rpc down');
        },
      }),
    );
    const out = await ex.execute(spec, {} as never);
    if (out.kind === 'filled') expect(out.outputAmountBase).toBe('1500');
  });
});

describe('isPreflightRejection', () => {
  it('matches Solana preflight wording and ignores network errors', () => {
    expect(
      isPreflightRejection(new Error('Simulation failed. Message: Transaction simulation failed: ...')),
    ).toBe(true);
    expect(isPreflightRejection(new Error('Transaction simulation failed: Error processing'))).toBe(true);
    expect(isPreflightRejection(new Error('fetch failed'))).toBe(false);
    expect(isPreflightRejection(new Error('confirmed transaction timed out'))).toBe(false);
  });
});

/**
 * A post-balance read that has not caught up with the confirmation equals the
 * pre read. Booking that as zero tokens stranded two real buys outside the book
 * (LOAD: 4,419.57 tokens, MAMESUKE: 6,092.47 tokens, both bought for real).
 */
describe('receivedOutputBase', () => {
  it('uses the balance delta when the balance actually moved', () => {
    expect(receivedOutputBase(1000n, 9000n, '5000')).toBe('8000');
  });

  it('falls back to the quote when the read is stale rather than booking zero', () => {
    expect(receivedOutputBase(0n, 0n, '4419569662')).toBe('4419569662');
    expect(receivedOutputBase(39026655054n, 39026655054n, '6092472269')).toBe('6092472269');
  });

  it('falls back to the quote when either read failed', () => {
    expect(receivedOutputBase(null, 9000n, '5000')).toBe('5000');
    expect(receivedOutputBase(1000n, null, '5000')).toBe('5000');
  });
});
