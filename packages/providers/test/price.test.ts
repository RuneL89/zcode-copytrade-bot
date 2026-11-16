import { afterEach, describe, expect, it, vi } from 'vitest';
import { JupiterPriceProvider, NO_ROUTE_CACHE_MS } from '../src/price.js';
import { JupiterNoRouteError, JupiterProvider, type JupiterQuote } from '../src/solana/jupiter.js';

const MINT = 'Mint111111111111111111111111111111111111111';

const quote = (outAmount = '2000000'): JupiterQuote => ({
  inAmount: '1000000',
  outAmount,
  priceImpactPct: '0',
  slippageBps: 1000,
  routePlan: [],
});

function provider(quoteFn: (params: unknown) => Promise<JupiterQuote>, maxAgeMs = 45_000) {
  return new JupiterPriceProvider({ quote: quoteFn } as unknown as JupiterProvider, maxAgeMs);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('JupiterPriceProvider negative cache', () => {
  it('caches a confirmed no-route for 60 minutes without another HTTP call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
    const quoteFn = vi
      .fn()
      .mockRejectedValueOnce(new JupiterNoRouteError('No routes found'))
      .mockResolvedValue(quote());
    const price = provider(quoteFn);

    await expect(price.priceOf(MINT, 6)).rejects.toMatchObject({ reason: 'no_route' });
    await expect(price.priceOf(MINT, 6)).rejects.toMatchObject({ reason: 'no_route' });
    expect(quoteFn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + NO_ROUTE_CACHE_MS + 1));
    await expect(price.priceOf(MINT, 6)).resolves.toMatchObject({ priceUsdMicro: 2_000_000n });
    expect(quoteFn).toHaveBeenCalledTimes(2);
  });

  it('does not cache a transient failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
    const quoteFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('jupiter: rate limited (429)'))
      .mockResolvedValue(quote());
    const price = provider(quoteFn);

    await expect(price.priceOf(MINT, 6)).rejects.toMatchObject({ reason: 'transient' });
    await expect(price.priceOf(MINT, 6)).resolves.toMatchObject({ priceUsdMicro: 2_000_000n });
    expect(quoteFn).toHaveBeenCalledTimes(2);
  });

  it('clears the negative cache after a successful quote', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
    const quoteFn = vi
      .fn()
      .mockRejectedValueOnce(new JupiterNoRouteError('No routes found'))
      .mockResolvedValue(quote());
    const price = provider(quoteFn);

    await expect(price.priceOf(MINT, 6)).rejects.toMatchObject({ reason: 'no_route' });
    vi.setSystemTime(new Date(Date.now() + NO_ROUTE_CACHE_MS + 1));
    await expect(price.priceOf(MINT, 6)).resolves.toMatchObject({ priceUsdMicro: 2_000_000n });
    expect(quoteFn).toHaveBeenCalledTimes(2);

    // Let the success cache expire, then force a new no-route. If success had
    // left the old negative entry behind, this would not reach the provider.
    vi.setSystemTime(new Date(Date.now() + 45_001));
    quoteFn.mockRejectedValueOnce(new JupiterNoRouteError('No routes found'));
    await expect(price.priceOf(MINT, 6)).rejects.toMatchObject({ reason: 'no_route' });
    expect(quoteFn).toHaveBeenCalledTimes(3);
  });

  it('clears the negative cache when the quote source changes', async () => {
    const failing = vi.fn().mockRejectedValue(new JupiterNoRouteError('No routes found'));
    const price = provider(failing);
    await expect(price.priceOf(MINT, 6)).rejects.toMatchObject({ reason: 'no_route' });

    const fresh = vi.fn().mockResolvedValue(quote('3000000'));
    price.setJupiter({ quote: fresh } as unknown as JupiterProvider);
    await expect(price.priceOf(MINT, 6)).resolves.toMatchObject({ priceUsdMicro: 3_000_000n });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe('JupiterProvider no-route classification', () => {
  it('turns a 400 No routes found body into JupiterNoRouteError', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"No routes found"}', { status: 400 })) as typeof fetch;
    try {
      const jupiter = new JupiterProvider('https://api.jup.ag', '');
      await expect(
        jupiter.quote({ inputMint: MINT, outputMint: 'USDC', amount: '1', slippageBps: 1 }),
      ).rejects.toBeInstanceOf(JupiterNoRouteError);
    } finally {
      globalThis.fetch = original;
    }
  });
});
