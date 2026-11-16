/**
 * Jupiter Swap API v2 `/build` (Metis routing, no Jupiter platform fee).
 *   GET {base}/swap/v2/build?inputMint&outputMint&amount&slippageBps&taker
 * The response is a quote plus raw instructions. The live executor assembles,
 * signs and sends that body. Paper mode uses the quote fields and falls back
 * to a cached price when `/build` refuses the call.
 */

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: Array<{ swapInfo?: { label?: string } }>;
  contextSlot?: number;
  [k: string]: unknown;
}

export interface BuiltSwap {
  swapTransaction: string; // base64
  lastValidBlockHeight?: number;
}

/** Jupiter positively confirmed there is no route for this quote. */
export class JupiterNoRouteError extends Error {
  constructor(message = 'jupiter: no route found') {
    super(message);
    this.name = 'JupiterNoRouteError';
  }
}

/** Used when the desk has no wallet file yet. `/build` rejects a missing taker. */
export const JUPITER_FALLBACK_TAKER = '11111111111111111111111111111111';

export class JupiterProvider {
  readonly name = 'jupiter';
  private defaultTaker = JUPITER_FALLBACK_TAKER;

  constructor(
    private baseUrl: string = 'https://api.jup.ag',
    private apiKey: string = '',
  ) {}

  /** Paper quotes use the wallet pubkey when the file is present. */
  setTaker(taker: string): void {
    if (taker.trim()) this.defaultTaker = taker.trim();
  }

  setCredentials(baseUrl: string, apiKey: string): void {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  async quote(params: {
    inputMint: string;
    outputMint: string;
    /** Raw base-unit amount of inputMint. */
    amount: string;
    slippageBps: number;
    /** Required by `/build`. Falls back to the provider taker, never omitted. */
    taker?: string;
  }): Promise<JupiterQuote> {
    const taker = params.taker?.trim() || this.defaultTaker;
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps),
      taker,
    });
    const res = await fetch(`${this.baseUrl}/swap/v2/build?${qs}`, { headers: this.headers() });
    if (res.status === 429) throw new Error('jupiter: rate limited (429)');
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      if (res.status === 400 && /no routes? found/i.test(body)) {
        throw new JupiterNoRouteError(`jupiter: no route found: ${body}`);
      }
      throw new Error(`jupiter: quote HTTP ${res.status}: ${body}`);
    }
    return (await res.json()) as JupiterQuote;
  }

  async buildSwap(params: {
    quoteResponse: JupiterQuote;
    userPublicKey: string;
    /** Funding mint to receive/forward. */
    wrapAndUnwrapSol?: boolean;
  }): Promise<BuiltSwap> {
    // `/build` already returned instructions on the quote call. Signing and
    // sending are the live gate, which this paper rebuild does not exercise.
    void params.wrapAndUnwrapSol;
    if (!params.userPublicKey) throw new Error('jupiter: build requires the taker public key');
    throw new Error('jupiter: live transaction assembly is not enabled (paper mode only)');
  }

  /** Price impact expressed in whole basis points from the quote's fraction string. */
  static priceImpactBps(quote: JupiterQuote): number {
    const pct = Number(quote.priceImpactPct ?? '0');
    if (!Number.isFinite(pct)) return 0;
    return Math.round(pct * 10000);
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      // Cheapest documented probe: a 1-unit USDC->USDT quote. `/build` rejects
      // the call with HTTP 400 unless `taker` is a public key. This is not a signer.
      await this.quote({
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        amount: '1000000',
        slippageBps: 100,
        taker: this.defaultTaker,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, detail: (e as Error).message };
    }
  }
}
