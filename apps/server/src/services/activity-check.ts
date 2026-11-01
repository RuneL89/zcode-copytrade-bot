import type { PriceProvider, PublicSolanaProvider } from '@zcode-bot/providers';
import type { CopyableActivitySample } from '@zcode-bot/core';

/**
 * One candidate-wallet activity reading (operator decision, 2026-11-01).
 *
 * `copyableTrades24h` / `entries24h` / `exits24h` count COIN MOVEMENTS: any tx
 * the wallet signed that moved a priceable, non-funding mint, whatever the
 * quote asset. `lastTradeAt` is the quiet clock; `lastEntryAt` is the "is he
 * buying" signal (an attributable coin inflow).
 *
 * There is deliberately no Helius fallback for the measurement: Helius'
 * signature-count call cannot produce per-mint direction, and writing its
 * numbers over a real reading is what kept every candidate looking passive.
 * When the public path fails the caller marks the check failed and keeps the
 * previous columns.
 */
export interface WalletActivityReading extends CopyableActivitySample {
  measured: true;
  source: 'public';
}

/**
 * Check one wallet through the public RPC classifier, pricing at most five of
 * the coins that moved (cached for the duration of this reading).
 *
 * Throws when the measurement cannot be produced — callers record the failure
 * (markCandidateActivityFailed) so a failed refresh never erases good numbers.
 */
export async function checkWalletActivity(
  publicProvider: PublicSolanaProvider,
  prices: PriceProvider | null,
  address: string,
  opts: { lookbackHours: number; minTradeUsdMicro?: bigint },
): Promise<WalletActivityReading> {
  if (!publicProvider.configured) throw new Error('activity: public RPC endpoint not configured');
  if (!prices) throw new Error('activity: no price source (coins must be copyable to count)');

  // One quote per mint per reading; the provider caps how many mints it asks
  // about, so a busy wallet cannot turn one check into dozens of price calls.
  const cache = new Map<string, bigint | null>();
  const priceOf = async (mint: string, decimals: number): Promise<bigint | null> => {
    const hit = cache.get(mint);
    if (hit !== undefined) return hit;
    let value: bigint | null = null;
    try {
      value = (await prices.priceOf(mint, decimals)).priceUsdMicro;
    } catch {
      value = null; // unpriceable = not copyable
    }
    cache.set(mint, value);
    return value;
  };

  const wa = await publicProvider.walletActivity(address, {
    lookbackHours: opts.lookbackHours,
    minTradeUsdMicro: opts.minTradeUsdMicro,
    priceOf,
  });
  if (!wa.ok) throw new Error('activity: ' + (wa.reason ?? 'public RPC measurement failed'));
  return { ...wa, measured: true, source: 'public' };
}
