import type { JupiterProvider } from './solana/jupiter.js';

export interface CachedPrice {
  /** Micro-USD per 1 whole token. */
  priceUsdMicro: bigint;
  observedAt: number;
}

export interface PriceProvider {
  /** Micro-USD price of one whole token of `mint`. Throws when unavailable. */
  priceOf(mint: string, decimals: number): Promise<CachedPrice>;
}

/**
 * Prices derived from live Jupiter quotes (quote 1 whole token into USDC).
 * Cached per mint and invalidated after maxAgeMs; the engine rejects entries
 * priced from stale quotes (PRICE_MAX_AGE_SECONDS).
 */
export class JupiterPriceProvider implements PriceProvider {
  private cache = new Map<string, CachedPrice>();
  private jup: JupiterProvider | null = null;

  constructor(
    jup: JupiterProvider,
    private maxAgeMs: number,
    private usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ) {
    this.jup = jup;
  }

  async priceOf(mint: string, decimals: number): Promise<CachedPrice> {
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.observedAt <= this.maxAgeMs) return hit;
    if (!this.jup) throw new Error('price: no pricing source');
    const quote = await this.jup.quote({
      inputMint: mint,
      outputMint: this.usdcMint,
      amount: (10n ** BigInt(decimals)).toString(),
      slippageBps: 1000,
    });
    const outBase = BigInt(quote.outAmount); // USDC has 6 decimals == micro-USD directly
    const cached: CachedPrice = { priceUsdMicro: outBase, observedAt: Date.now() };
    this.cache.set(mint, cached);
    return cached;
  }

  /** Swap the quote source live (e.g. after new provider credentials). */
  setJupiter(jup: JupiterProvider): void {
    this.jup = jup;
    this.cache.clear();
  }

  /** Test/inspection hook. */
  peek(mint: string): CachedPrice | undefined {
    return this.cache.get(mint);
  }
}

/** Deterministic in-memory pricing for tests and the fictional demo replay. */
export class StaticPriceProvider implements PriceProvider {
  constructor(private priceUsdMicroByMint: Map<string, bigint>) {}
  async priceOf(mint: string): Promise<CachedPrice> {
    const price = this.priceUsdMicroByMint.get(mint);
    if (price === undefined) throw new Error(`static price: unknown mint ${mint}`);
    return { priceUsdMicro: price, observedAt: Date.now() };
  }
}
