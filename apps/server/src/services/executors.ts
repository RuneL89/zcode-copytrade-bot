import { JUPITER_FALLBACK_TAKER, type JupiterProvider, type JupiterQuote } from '@zcode-bot/providers';
import { usdToMicro } from '@zcode-bot/core';
import type { SendResult } from './sendPath.js';
import {
  assembleJupiterBuild,
  lookupTableAddresses,
  withSenderTip,
  type BuiltTransaction,
  type JupiterBuildBody,
} from './txBuild.js';

/**
 * Execution boundary. Paper mode simulates fills with DOCUMENTED assumptions
 * and never signs. Live mode is the only path that signs/submits; it is
 * constructed only after live readiness/arming, persists signed/submitted
 * evidence through `ExecutionHooks` before the network send, and uses the
 * signed transaction's own blockhash for confirmation.
 */

export interface IntentSpec {
  intentId: string;
  /** The seat the order belongs to; the last-moment gate re-reads its state. */
  activationId?: string;
  kind: 'entry' | 'exit' | 'fire_close' | 'close_all';
  inputMint: string;
  outputMint: string;
  inputAmountBase: string;
  inputDecimals: number;
  outputDecimals: number;
  inputUsdMicro: string;
  slippageBpsCap: number;
  userPublicKey: string | null;
}

export interface QuoteCheck {
  slippageBps: number;
  priceImpactBps: number;
  minOutputBase: string;
  source: 'jupiter' | 'assumed';
}

export interface SignedTransactionInfo {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  signedBase64: string;
  buildKind: 'legacy' | 'v0';
}

export interface SubmittedTransactionInfo extends SignedTransactionInfo {
  via: 'sender' | 'staked' | 'public';
}

/**
 * Durable execution checkpoints. `afterSign` must write before the send
 * returns; a crash after signing is then reconcilable from the persisted
 * signature. `beforeSign` is re-evaluated immediately before signing and
 * again immediately before submitting (pause/emergency/activation state).
 */
export interface ExecutionHooks {
  beforeSign?: (info: { buildKind: 'legacy' | 'v0' }) => void | Promise<void>;
  afterSign?: (info: SignedTransactionInfo) => void | Promise<void>;
  afterSubmit?: (info: SubmittedTransactionInfo) => void | Promise<void>;
}

export type ExecOutcome =
  | {
      kind: 'filled';
      signature: string | null;
      inputAmountBase: string;
      outputAmountBase: string;
      feeUsdMicro: string;
      evidence: unknown;
      commitment: string | null;
    }
  | { kind: 'skipped'; reason: string }
  | { kind: 'unknown'; detail: string; signature?: string }
  | {
      kind: 'failed';
      error: string;
      /** Present when the transaction existed but definitively did not land. */
      signature?: string | null;
      /** True only when chain evidence proves it was never applied (safe retry). */
      retryable?: boolean;
    };

export interface Executor {
  readonly mode: 'paper' | 'live';
  quote(spec: IntentSpec): Promise<QuoteCheck>;
  execute(spec: IntentSpec, quote: QuoteCheck, hooks?: ExecutionHooks): Promise<ExecOutcome>;
  /**
   * On-chain balance of `mint` owned by the trading wallet, base units.
   * null when unknown (paper mode, or the read failed) — callers must then
   * fall back to their recorded amount rather than guess.
   */
  availableBalance?(mint: string): Promise<bigint | null>;
  /** SOL balance in lamports for fee/rent headroom; null when unknown. */
  availableSolLamports?(): Promise<number | null>;
}

/** Below this the wallet cannot reliably pay swap fees + rent: exits fail closed. */
export const MIN_SOL_FOR_FEES_LAMPORTS = 5_000_000; // 0.005 SOL
/** Below this the notifier warns before exits start failing. */
export const SOL_LOW_WATERMARK_LAMPORTS = 20_000_000; // 0.02 SOL
/** Extra SOL kept for ATA rent and the Sender tip on top of the fee floor. */
export const SOL_RENT_TIP_BUFFER_LAMPORTS = 15_000_000; // 0.015 SOL

/**
 * True when a send error is a preflight/simulation rejection. Such a
 * transaction was never accepted by the RPC, so nothing reached the chain and
 * the operation is safe to retry — unlike a post-send confirmation timeout.
 */
export function isPreflightRejection(error: unknown): boolean {
  const msg = (error as Error)?.message ?? String(error);
  return /simulation failed|transaction simulation failed|preflight failure/i.test(msg);
}

/**
 * Base units a live fill actually received. The balance delta is the truth when
 * both reads succeeded and the balance moved; an unchanged read is a stale read
 * (a fresh token account is not always visible the instant the transaction
 * confirms), so it falls back to the quote rather than booking zero tokens.
 */
export function receivedOutputBase(pre: bigint | null, post: bigint | null, quotedBase: string): string {
  if (pre === null || post === null || post <= pre) return quotedBase;
  return (post - pre).toString();
}

/** Documented paper-mode simulation assumptions (displayed in the UI). */
export const PAPER_ASSUMPTIONS = {
  slippageBps: 30,
  feeBps: 5,
  note: 'Paper fills are simulated at the Jupiter quote when available, otherwise at the cached price with 30 bps adverse slippage and 5 bps fees. Nothing is ever signed or submitted.',
} as const;

export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;

  constructor(
    private jupiter: JupiterProvider | null,
    private priceOfBaseUnitUsdMicro: (mint: string, decimals: number) => Promise<bigint>,
  ) {}

  setJupiter(jupiter: JupiterProvider | null): void {
    this.jupiter = jupiter;
  }

  /** Paper positions are synthetic: no on-chain balance is meaningful. */
  async availableBalance(): Promise<bigint | null> {
    return null;
  }

  async availableSolLamports(): Promise<number | null> {
    return null;
  }

  async quote(spec: IntentSpec): Promise<QuoteCheck> {
    if (this.jupiter) {
      try {
        const q = await this.jupiter.quote({
          inputMint: spec.inputMint,
          outputMint: spec.outputMint,
          amount: spec.inputAmountBase,
          slippageBps: spec.slippageBpsCap,
          taker: spec.userPublicKey || JUPITER_FALLBACK_TAKER,
        });
        const priceImpactBps = Math.max(0, Math.round(Number(q.priceImpactPct ?? '0') * 10000));
        return {
          slippageBps: Math.min(spec.slippageBpsCap, Math.max(priceImpactBps, PAPER_ASSUMPTIONS.slippageBps)),
          priceImpactBps,
          minOutputBase: q.otherAmountThreshold ?? q.outAmount,
          source: 'jupiter',
        };
      } catch {
        // fall through to assumed quote
      }
    }
    return {
      slippageBps: PAPER_ASSUMPTIONS.slippageBps,
      priceImpactBps: 0,
      minOutputBase: '0',
      source: 'assumed',
    };
  }

  async execute(spec: IntentSpec, quote: QuoteCheck): Promise<ExecOutcome> {
    void quote;
    if (this.jupiter) {
      try {
        const q = await this.jupiter.quote({
          inputMint: spec.inputMint,
          outputMint: spec.outputMint,
          amount: spec.inputAmountBase,
          slippageBps: spec.slippageBpsCap,
          taker: spec.userPublicKey || JUPITER_FALLBACK_TAKER,
        });
        const feeUsdMicro = (BigInt(spec.inputUsdMicro) * BigInt(PAPER_ASSUMPTIONS.feeBps)) / 10000n;
        return {
          kind: 'filled',
          signature: null,
          inputAmountBase: spec.inputAmountBase,
          outputAmountBase: q.outAmount,
          feeUsdMicro: feeUsdMicro.toString(),
          evidence: { simulation: true, assumptions: PAPER_ASSUMPTIONS, quoteSource: 'jupiter' },
          commitment: 'paper',
        };
      } catch {
        // fall through to price-based simulation
      }
    }
    // Documented fallback: simulated at cached price with adverse slippage.
    try {
      const usdMicro = await this.priceOfBaseUnitUsdMicro(spec.inputMint, spec.inputDecimals);
      const inputUsd = (BigInt(spec.inputAmountBase) * usdMicro) / 10n ** BigInt(spec.inputDecimals);
      const adverse = (inputUsd * (10000n - BigInt(PAPER_ASSUMPTIONS.slippageBps))) / 10000n;
      const outUsdMicro = spec.kind === 'entry' ? adverse : adverse; // both directions adverse
      const outBase =
        spec.outputDecimals > 0
          ? (outUsdMicro * 10n ** BigInt(spec.outputDecimals)) / 1_000_000n
          : outUsdMicro;
      const feeUsdMicro = (inputUsd * BigInt(PAPER_ASSUMPTIONS.feeBps)) / 10000n;
      return {
        kind: 'filled',
        signature: null,
        inputAmountBase: spec.inputAmountBase,
        outputAmountBase: outBase.toString(),
        feeUsdMicro: feeUsdMicro.toString(),
        evidence: { simulation: true, assumptions: PAPER_ASSUMPTIONS, quoteSource: 'assumed-price' },
        commitment: 'paper',
      };
    } catch (e) {
      return { kind: 'failed', error: `paper simulation failed: ${(e as Error).message}` };
    }
  }
}

/** Minimal connection surface the live path needs (injectable for tests). */
export interface LiveConnection {
  sendRawTransaction(raw: Uint8Array, opts?: { skipPreflight?: boolean }): Promise<string>;
  confirmTransaction(strategy: unknown, commitment: string): Promise<{ value: { err: unknown } }>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getParsedTokenAccountsByOwner(
    owner: unknown,
    filter: unknown,
  ): Promise<{
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
  }>;
  getBalance(owner: unknown): Promise<number>;
  getAddressLookupTable?(address: unknown): Promise<{ value: unknown }>;
  simulateTransaction?(
    tx: unknown,
    config: { sigVerify: boolean; replaceRecentBlockhash: boolean; commitment: string },
  ): Promise<{ value: { err: unknown } }>;
  getSignatureStatuses?(
    signatures: string[],
    config: { searchTransactionHistory: boolean },
  ): Promise<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>;
  getBlockHeight?(commitment?: string): Promise<number>;
}

/** Live signing/submit path. Constructed ONLY after successful live arming. */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  private connection: LiveConnection | null = null;

  constructor(
    private jupiter: JupiterProvider,
    private rpcUrl: string,
    private secretKey: Uint8Array,
    private publicKey: string,
    /** Test seam: supply a fake connection instead of a real RPC client. */
    private connectionFactory?: (rpcUrl: string) => LiveConnection,
    /**
     * Production send. Sender, then a metered staked send, then the public RPC.
     * Absent in tests, which keep `connection.sendRawTransaction`.
     */
    private submit?: (args: {
      signedBase64: string;
      expectedSignature: string;
      trySender: boolean;
      path: 'exit' | 'wallet';
    }) => Promise<SendResult>,
    /** Simulate the build before signing (production). Tests may disable it. */
    private simulate = true,
  ) {}

  private async conn(): Promise<LiveConnection> {
    if (!this.connection) {
      if (this.connectionFactory) {
        this.connection = this.connectionFactory(this.rpcUrl);
      } else {
        const { Connection } = await import('@solana/web3.js');
        this.connection = new Connection(this.rpcUrl, 'confirmed') as unknown as LiveConnection;
      }
    }
    return this.connection;
  }

  /** Sum of every token account the wallet holds for `mint` (0 when none). */
  async availableBalance(mint: string): Promise<bigint | null> {
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const conn = await this.conn();
      const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(this.publicKey), {
        mint: new PublicKey(mint),
      });
      let sum = 0n;
      for (const acc of res.value) {
        const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (amount) sum += BigInt(amount);
      }
      return sum;
    } catch {
      return null; // unknown: callers fall back to the recorded amount
    }
  }

  async availableSolLamports(): Promise<number | null> {
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const conn = await this.conn();
      return await conn.getBalance(new PublicKey(this.publicKey));
    } catch {
      return null;
    }
  }

  async quote(spec: IntentSpec): Promise<QuoteCheck> {
    const q = await this.jupiter.quote({
      inputMint: spec.inputMint,
      outputMint: spec.outputMint,
      amount: spec.inputAmountBase,
      slippageBps: spec.slippageBpsCap,
      taker: this.publicKey,
    });
    return {
      // The quote's own tolerance (normally the requested cap). The real
      // protection against quote drift is the fresh-min-out check in execute().
      slippageBps: typeof q.slippageBps === 'number' ? q.slippageBps : spec.slippageBpsCap,
      priceImpactBps: Math.max(0, Math.round(Number(q.priceImpactPct ?? '0') * 10000)),
      minOutputBase: q.otherAmountThreshold ?? q.outAmount,
      source: 'jupiter',
    };
  }

  async execute(spec: IntentSpec, quote: QuoteCheck, hooks: ExecutionHooks = {}): Promise<ExecOutcome> {
    // Every failure before a signature exists is DEFINITIVELY unsent and
    // therefore retryable ('failed'). Only a send whose outcome is ambiguous,
    // or a confirmation that we lose after submitting, becomes 'unknown'.

    // Requote + rebuild immediately before signing (never reuse stale quotes).
    let quoteResponse: Awaited<ReturnType<JupiterProvider['quote']>>;
    try {
      quoteResponse = await this.jupiter.quote({
        inputMint: spec.inputMint,
        outputMint: spec.outputMint,
        amount: spec.inputAmountBase,
        slippageBps: spec.slippageBpsCap,
        taker: this.publicKey,
      });
    } catch (e) {
      return { kind: 'failed', error: `quote failed before submission: ${(e as Error).message}` };
    }
    // A materially worse fresh quote than the one the engine accepted is not
    // signed. This is the gate the old self-comparison never provided.
    const freshOut = quoteResponse.otherAmountThreshold ?? quoteResponse.outAmount;
    const freshMinOut = freshOut === undefined || freshOut === null ? 0n : BigInt(freshOut);
    if (quote.minOutputBase && quote.minOutputBase !== '0' && freshMinOut < BigInt(quote.minOutputBase)) {
      return {
        kind: 'failed',
        error: `fresh quote minimum ${freshMinOut} is below the accepted ${quote.minOutputBase}`,
      };
    }

    const balanceFailure = await this.checkEntryBalances(spec);
    if (balanceFailure) return balanceFailure;

    let built: BuiltTransaction;
    try {
      built = await this.unsignedTransaction(quoteResponse);
    } catch (e) {
      return { kind: 'failed', error: `swap build failed before submission: ${(e as Error).message}` };
    }

    if (this.simulate && this.submit) {
      const simulated = await this.simulateBuild(built);
      if (simulated) return simulated;
    }

    // Snapshot the output balance BEFORE sending so the fill records what was
    // actually received, not what was quoted. Best effort: a read failure
    // falls back to the quote.
    const preOutput = await this.availableBalance(spec.outputMint);

    let signature: string;
    let signedInfo: SignedTransactionInfo | null = null;
    let submitAttempted = false;
    try {
      await hooks.beforeSign?.({ buildKind: built.kind });
      const signed = await signSerialized(built.base64, this.publicKey, this.secretKey);
      signedInfo = {
        signature: signed.signature,
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
        signedBase64: signed.base64,
        buildKind: built.kind,
      };
      signature = signed.signature;
      await hooks.afterSign?.(signedInfo);

      if (this.submit) {
        // Last-moment control/activation check: pause/emergency/disarm must
        // stop a signed-but-not-yet-sent entry.
        await hooks.beforeSign?.({ buildKind: built.kind });
        submitAttempted = true;
        const sent = await this.submit({
          signedBase64: signed.base64,
          expectedSignature: signature,
          trySender: built.tipAccount !== null,
          path: spec.kind === 'entry' ? 'wallet' : 'exit',
        });
        if (sent.kind === 'unknown') {
          return { kind: 'unknown', detail: sent.detail, signature };
        }
        if (sent.kind === 'failed') {
          if (isPreflightRejection(new Error(sent.error))) {
            return { kind: 'failed', error: `preflight rejected (not submitted): ${sent.error}` };
          }
          return {
            kind: 'failed',
            error: `send rejected before a signature: ${sent.error}`,
            signature: sent.signature,
            retryable: sent.signature === null,
          };
        }
        await hooks.afterSubmit?.({
          signature,
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
          signedBase64: signed.base64,
          buildKind: built.kind,
          via: sent.via,
        });
      } else {
        const { VersionedTransaction } = await import('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(Buffer.from(signed.base64, 'base64'));
        submitAttempted = true;
        signature = await (
          await this.conn()
        ).sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
        });
        if (signature !== signed.signature) {
          return {
            kind: 'unknown',
            detail: `RPC returned ${signature} for locally signed ${signed.signature}`,
            signature: signed.signature,
          };
        }
      }
    } catch (e) {
      if (isPreflightRejection(e)) {
        return { kind: 'failed', error: `preflight rejected (not submitted): ${(e as Error).message}` };
      }
      // Before any submit call the transaction provably never left the
      // process: a pause/activation rejection, a signing failure or a failed
      // signed-state write is a definitive `failed`, not reconciliation.
      if (!submitAttempted) {
        return {
          kind: 'failed',
          error: `signing aborted before submission: ${(e as Error).message}`,
        };
      }
      return {
        kind: 'unknown',
        detail: `send outcome unknown: ${(e as Error).message}`,
        signature: signedInfo?.signature,
      };
    }

    try {
      const connection = await this.conn();
      const result = await connection.confirmTransaction(
        {
          signature,
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        'confirmed',
      );
      if (result.value.err) {
        return {
          kind: 'failed',
          error: `transaction failed on-chain: ${JSON.stringify(result.value.err)}`,
          signature,
          retryable: false,
        };
      }
      // Actual received = post - pre when both reads succeeded AND the balance
      // actually moved; otherwise the quote. A post read that equals the pre
      // read is a stale read (a fresh token account is not always visible the
      // instant a transaction confirms), never "received nothing" — booking a
      // zero here strands real tokens outside the book.
      const outputAmountBase = receivedOutputBase(
        preOutput,
        await this.availableBalance(spec.outputMint),
        quoteResponse.outAmount,
      );
      return {
        kind: 'filled',
        signature,
        inputAmountBase: spec.inputAmountBase,
        outputAmountBase,
        feeUsdMicro: usdToMicro(0.0015).toString(),
        evidence: {
          signature,
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
          via: this.submit ? 'submit' : 'sendRawTransaction',
          buildKind: built.kind,
          live: true,
        },
        commitment: 'confirmed',
      };
    } catch (e) {
      // Submitted but confirmation unknown -> NEVER blind-retry.
      const expired = await this.expiredWithoutLanding(signature, built.lastValidBlockHeight);
      if (expired === 'landed') {
        const outputAmountBase = receivedOutputBase(
          preOutput,
          await this.availableBalance(spec.outputMint),
          quoteResponse.outAmount,
        );
        return {
          kind: 'filled',
          signature,
          inputAmountBase: spec.inputAmountBase,
          outputAmountBase,
          feeUsdMicro: usdToMicro(0.0015).toString(),
          evidence: { signature, blockhash: built.blockhash, live: true, reconciled: true },
          commitment: 'confirmed',
        };
      }
      if (expired === 'landed_failed') {
        return {
          kind: 'failed',
          error: 'transaction landed with an on-chain error',
          signature,
          retryable: false,
        };
      }
      if (expired === 'dead') {
        return {
          kind: 'failed',
          error: `transaction expired without landing: ${(e as Error).message}`,
          signature,
          retryable: true,
        };
      }
      return {
        kind: 'unknown',
        detail: `submitted ${signature}; confirmation unknown: ${(e as Error).message}`,
        signature,
      };
    }
  }

  /**
   * Entries spend real tokens: verify the input balance (and the SOL fee/rent
   * buffer) before building. A failed read fails closed. Exits already clamp
   * to the on-chain balance and keep their fee-floor fallback.
   */
  private async checkEntryBalances(
    spec: IntentSpec,
  ): Promise<Extract<ExecOutcome, { kind: 'failed' }> | null> {
    if (spec.kind !== 'entry') return null;
    const sol = await this.availableSolLamports();
    if (sol === null) {
      return { kind: 'failed', error: 'entry blocked: wallet SOL balance is unreadable' };
    }
    const input = BigInt(spec.inputAmountBase);
    const isSol = spec.inputMint === 'So11111111111111111111111111111111111111112';
    if (isSol) {
      const needed = Number(input) + MIN_SOL_FOR_FEES_LAMPORTS + SOL_RENT_TIP_BUFFER_LAMPORTS;
      if (sol < needed) {
        return {
          kind: 'failed',
          error: `entry blocked: SOL balance ${sol} cannot cover ${input} + fees/rent (need ${needed})`,
        };
      }
      return null;
    }
    if (sol < MIN_SOL_FOR_FEES_LAMPORTS + SOL_RENT_TIP_BUFFER_LAMPORTS) {
      return {
        kind: 'failed',
        error: `entry blocked: SOL ${sol} is below the fee/rent buffer`,
      };
    }
    const inputBalance = await this.availableBalance(spec.inputMint);
    if (inputBalance === null) {
      return { kind: 'failed', error: `entry blocked: ${spec.inputMint} balance is unreadable` };
    }
    if (inputBalance < input) {
      return {
        kind: 'failed',
        error: `entry blocked: input balance ${inputBalance} is below the order size ${input}`,
      };
    }
    return null;
  }

  private async simulateBuild(
    built: BuiltTransaction,
  ): Promise<Extract<ExecOutcome, { kind: 'failed' }> | null> {
    const connection = await this.conn();
    if (!connection.simulateTransaction) return null;
    try {
      const { VersionedTransaction } = await import('@solana/web3.js');
      const tx = VersionedTransaction.deserialize(Buffer.from(built.base64, 'base64'));
      const result = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
      if (result.value.err) {
        return {
          kind: 'failed',
          error: `simulation failed (not submitted): ${JSON.stringify(result.value.err)}`,
        };
      }
      return null;
    } catch (e) {
      return { kind: 'failed', error: `simulation failed (not submitted): ${(e as Error).message}` };
    }
  }

  /** Chain check after a lost confirmation: landed, provably dead, or unknown. */
  private async expiredWithoutLanding(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<'landed' | 'landed_failed' | 'dead' | 'unknown'> {
    const connection = await this.conn();
    try {
      if (connection.getSignatureStatuses) {
        const status = await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const value = status.value[0];
        if (value) {
          if (value.err) return 'landed_failed';
          if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
            return 'landed';
          }
          return 'unknown';
        }
      }
      if (connection.getBlockHeight) {
        const height = await connection.getBlockHeight('confirmed');
        if (height > lastValidBlockHeight + 150) return 'dead';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Prefer the `/build` body. Fall back to `buildSwap` for the test seam. */
  private async unsignedTransaction(quoteResponse: JupiterQuote): Promise<BuiltTransaction> {
    const body = quoteResponse as JupiterQuote & JupiterBuildBody;
    const hasBuild =
      Boolean(body.swapTransaction) ||
      Boolean(body.swapInstruction) ||
      (body.computeBudgetInstructions?.length ?? 0) > 0 ||
      (body.setupInstructions?.length ?? 0) > 0 ||
      (body.cleanupInstruction ?? null) !== null ||
      (body.otherInstructions?.length ?? 0) > 0;
    if (this.submit && hasBuild) {
      const connection = await this.conn();
      const latest = await connection.getLatestBlockhash();
      const addresses = lookupTableAddresses(body);
      const altAccounts: unknown[] = [];
      if (addresses.length > 0) {
        if (!connection.getAddressLookupTable) {
          throw new Error('jupiter build uses lookup tables but the RPC wrapper cannot resolve them');
        }
        for (const address of addresses) {
          const { PublicKey } = await import('@solana/web3.js');
          const resolved = await connection.getAddressLookupTable(new PublicKey(address));
          if (!resolved.value) throw new Error(`lookup table ${address} was not found`);
          altAccounts.push(resolved.value);
        }
      }
      return assembleJupiterBuild(body, {
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        payer: this.publicKey,
        altAccounts: altAccounts as never,
        addTip: true,
      });
    }
    const built = await this.jupiter.buildSwap({ quoteResponse, userPublicKey: this.publicKey });
    const latest = await (await this.conn()).getLatestBlockhash();
    return {
      base64: built.swapTransaction,
      kind: 'legacy',
      blockhash: latest.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight ?? latest.lastValidBlockHeight,
      swapProgramId: 'test-seam',
      instructionCount: 0,
      tipLamports: 0,
      tipAccount: null,
    };
  }
}

/** Sign and return both the base64 bytes and the base58 signature web3.js produced. */
async function signSerialized(
  serialized: string,
  publicKey: string,
  secretKey: Uint8Array,
): Promise<{ base64: string; signature: string }> {
  const { VersionedTransaction, PublicKey } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const tx = VersionedTransaction.deserialize(Buffer.from(serialized, 'base64'));
  if (tx.signatures.length !== 1) {
    throw new Error(`expected one signature slot, found ${tx.signatures.length}`);
  }
  const signer = tx.message.staticAccountKeys[0];
  if (!signer || signer.toBase58() !== publicKey) {
    throw new Error('unsigned transaction fee payer is not the configured wallet');
  }
  tx.sign([{ publicKey: new PublicKey(publicKey), secretKey }]);
  return {
    base64: Buffer.from(tx.serialize()).toString('base64'),
    signature: bs58.encode(tx.signatures[0]!),
  };
}
