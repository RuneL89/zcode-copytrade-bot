import type { JupiterProvider } from '@zcode-bot/providers';
import { usdToMicro } from '@zcode-bot/core';

/**
 * Execution boundary. Paper mode simulates fills with DOCUMENTED assumptions
 * and never signs. Live mode is the only path that signs/submits, is armed
 * separately, and is never constructed by tests or demo mode.
 */

export interface IntentSpec {
  intentId: string;
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
  | { kind: 'unknown'; detail: string }
  | { kind: 'failed'; error: string };

export interface Executor {
  readonly mode: 'paper' | 'live';
  quote(spec: IntentSpec): Promise<QuoteCheck>;
  execute(spec: IntentSpec, quote: QuoteCheck): Promise<ExecOutcome>;
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

/**
 * True when a send error is a preflight/simulation rejection. Such a
 * transaction was never accepted by the RPC, so nothing reached the chain and
 * the operation is safe to retry — unlike a post-send confirmation timeout.
 * Solana's SendTransactionError renders these as "Simulation failed. ...".
 */
export function isPreflightRejection(error: unknown): boolean {
  const msg = (error as Error)?.message ?? String(error);
  return /simulation failed|transaction simulation failed|preflight failure/i.test(msg);
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
    if (this.jupiter) {
      try {
        const q = await this.jupiter.quote({
          inputMint: spec.inputMint,
          outputMint: spec.outputMint,
          amount: spec.inputAmountBase,
          slippageBps: spec.slippageBpsCap,
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
    });
    return {
      slippageBps: spec.slippageBpsCap,
      priceImpactBps: Math.max(0, Math.round(Number(q.priceImpactPct ?? '0') * 10000)),
      minOutputBase: q.otherAmountThreshold ?? q.outAmount,
      source: 'jupiter',
    };
  }

  async execute(spec: IntentSpec, _quote: QuoteCheck): Promise<ExecOutcome> {
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
      });
    } catch (e) {
      return { kind: 'failed', error: `quote failed before submission: ${(e as Error).message}` };
    }

    let built: Awaited<ReturnType<JupiterProvider['buildSwap']>>;
    try {
      built = await this.jupiter.buildSwap({ quoteResponse, userPublicKey: this.publicKey });
    } catch (e) {
      return { kind: 'failed', error: `swap build failed before submission: ${(e as Error).message}` };
    }

    // Snapshot the output balance BEFORE sending so the fill records what was
    // actually received, not what was quoted. Best effort: a read failure
    // falls back to the quote.
    const preOutput = await this.availableBalance(spec.outputMint);

    let signature: string;
    try {
      const { VersionedTransaction, PublicKey } = await import('@solana/web3.js');
      const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
      tx.sign([{ publicKey: new PublicKey(this.publicKey), secretKey: this.secretKey }]);
      const connection = await this.conn();
      signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    } catch (e) {
      if (isPreflightRejection(e)) {
        return { kind: 'failed', error: `preflight rejected (not submitted): ${(e as Error).message}` };
      }
      return { kind: 'unknown', detail: `send outcome unknown: ${(e as Error).message}` };
    }

    try {
      const connection = await this.conn();
      const latest = await connection.getLatestBlockhash();
      const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (result.value.err) {
        return { kind: 'failed', error: `transaction failed on-chain: ${JSON.stringify(result.value.err)}` };
      }
      // Actual received = post - pre when both reads succeeded; else the quote.
      let outputAmountBase = quoteResponse.outAmount;
      const post = await this.availableBalance(spec.outputMint);
      if (preOutput !== null && post !== null && post >= preOutput) {
        outputAmountBase = (post - preOutput).toString();
      }
      return {
        kind: 'filled',
        signature,
        inputAmountBase: spec.inputAmountBase,
        outputAmountBase,
        feeUsdMicro: usdToMicro(0.0005 + 0.001).toString(),
        evidence: { signature, slot: latest.lastValidBlockHeight, live: true },
        commitment: 'confirmed',
      };
    } catch (e) {
      // Submitted but confirmation unknown -> NEVER blind-retry.
      return {
        kind: 'unknown',
        detail: `submitted ${signature}; confirmation unknown: ${(e as Error).message}`,
      };
    }
  }
}
