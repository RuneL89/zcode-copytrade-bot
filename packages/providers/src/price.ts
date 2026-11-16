import {
  JUPITER_FALLBACK_TAKER,
  JupiterNoRouteError,
  type JupiterProvider,
  type JupiterQuote,
} from './solana/jupiter.js';

/** A failed price read, split by whether retrying can ever help this mint. */
export class PriceUnavailableError extends Error {
  constructor(
    public readonly reason: 'no_route' | 'transient',
    message: string,
  ) {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

/** A confirmed no-route is remembered this long; no HTTP is paid during it. */
export const NO_ROUTE_CACHE_MS = 60 * 60_000;

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
  /** Mint -> no-route cache expiry. Transient failures are never stored. */
  private noRouteUntil = new Map<string, number>();
  private jup: JupiterProvider | null = null;
  private taker = JUPITER_FALLBACK_TAKER;

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
    const blockedUntil = this.noRouteUntil.get(mint);
    if (blockedUntil !== undefined) {
      if (Date.now() < blockedUntil) {
        throw new PriceUnavailableError('no_route', `price: no route for ${mint} (cached)`);
      }
      this.noRouteUntil.delete(mint);
    }
    if (!this.jup) throw new PriceUnavailableError('transient', 'price: no pricing source');
    let quote: JupiterQuote;
    try {
      quote = await this.jup.quote({
        inputMint: mint,
        outputMint: this.usdcMint,
        amount: (10n ** BigInt(decimals)).toString(),
        slippageBps: 1000,
        taker: this.taker,
      });
    } catch (e) {
      if (e instanceof JupiterNoRouteError) {
        this.noRouteUntil.set(mint, Date.now() + NO_ROUTE_CACHE_MS);
        throw new PriceUnavailableError('no_route', `price: no route for ${mint}`);
      }
      throw new PriceUnavailableError('transient', `price: ${e instanceof Error ? e.message : String(e)}`);
    }
    const outBase = BigInt(quote.outAmount); // USDC has 6 decimals == micro-USD directly
    const cached: CachedPrice = { priceUsdMicro: outBase, observedAt: Date.now() };
    this.cache.set(mint, cached);
    this.noRouteUntil.delete(mint);
    return cached;
  }

  /** Swap the quote source live (e.g. after new provider credentials). */
  setJupiter(jup: JupiterProvider): void {
    this.jup = jup;
    this.cache.clear();
    this.noRouteUntil.clear();
  }

  setTaker(taker: string): void {
    if (taker.trim()) this.taker = taker.trim();
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
