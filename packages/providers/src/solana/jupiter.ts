/**
 * Jupiter Swap API v1 adapter (verified against current docs):
 *   GET  {base}/swap/v1/quote?inputMint&outputMint&amount&slippageBps
 *   POST {base}/swap/v1/swap  { quoteResponse, userPublicKey, ... }
 * Production base https://api.jup.ag requires x-api-key; the keyless
 * rate-limited mirror https://lite-api.jup.ag is the default.
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
    private baseUrl: string = 'https://lite-api.jup.ag',
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
  }): Promise<JupiterQuote> {
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      slippageBps: String(params.slippageBps),
    });
    const res = await fetch(`${this.baseUrl}/swap/v1/quote?${qs}`, { headers: this.headers() });
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
    const res = await fetch(`${this.baseUrl}/swap/v1/swap`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        quoteResponse: params.quoteResponse,
        userPublicKey: params.userPublicKey,
        wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false,
      }),
    });
    if (res.status === 429) throw new Error('jupiter: rate limited (429)');
    if (!res.ok) {
      throw new Error(`jupiter: swap HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as BuiltSwap;
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
