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

/** Live signing/submit path. Constructed ONLY after successful live arming. */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;

  constructor(
    private jupiter: JupiterProvider,
    private rpcUrl: string,
    private secretKey: Uint8Array,
    private publicKey: string,
  ) {}

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
    // Requote + rebuild immediately before signing (never reuse stale quotes).
    const quoteResponse = await this.jupiter.quote({
      inputMint: spec.inputMint,
      outputMint: spec.outputMint,
      amount: spec.inputAmountBase,
      slippageBps: spec.slippageBpsCap,
    });
    const built = await this.jupiter.buildSwap({
      quoteResponse,
      userPublicKey: this.publicKey,
    });
    const { Connection, VersionedTransaction, PublicKey } = await import('@solana/web3.js');
    const connection = new Connection(this.rpcUrl, 'confirmed');
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, 'base64'));
    tx.sign([{ publicKey: new PublicKey(this.publicKey), secretKey: this.secretKey }]);
    const raw = tx.serialize();
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
    try {
      const latest = await connection.getLatestBlockhash();
      const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (result.value.err) {
        return { kind: 'failed', error: `transaction failed on-chain: ${JSON.stringify(result.value.err)}` };
      }
      return {
        kind: 'filled',
        signature,
        inputAmountBase: spec.inputAmountBase,
        outputAmountBase: quoteResponse.outAmount,
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
