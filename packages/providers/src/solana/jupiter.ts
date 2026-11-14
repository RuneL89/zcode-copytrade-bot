/**
 * Jupiter Swap API v2 `/build` (Metis routing, no Jupiter platform fee).
 *   GET {base}/swap/v2/build?inputMint&outputMint&amount&slippageBps&taker
 * The response is a quote plus raw instructions. We assemble, sign and send
 * ourselves. Live assembly is not enabled yet: paper mode uses the quote
 * fields and falls back to a cached price when `/build` refuses the call.
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

export class JupiterProvider {
  readonly name = 'jupiter';

  constructor(
    private baseUrl: string = 'https://api.jup.ag',
    private apiKey: string = '',
  ) {}

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
    /** Required by `/build`. Paper mode omits it and uses the price fallback. */
    taker?: string;
  }): Promise<JupiterQuote> {
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps),
      ...(params.taker ? { taker: params.taker } : {}),
    });
    const res = await fetch(`${this.baseUrl}/swap/v2/build?${qs}`, { headers: this.headers() });
    if (res.status === 429) throw new Error('jupiter: rate limited (429)');
    if (!res.ok) {
      throw new Error(`jupiter: quote HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
      // Cheapest documented probe: a 1-unit USDC->USDT quote.
      await this.quote({
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        amount: '1000000',
        slippageBps: 100,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, detail: (e as Error).message };
    }
  }
}
