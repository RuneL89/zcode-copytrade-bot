/**
 * Copyable-trade measurement.
 *
 * Two layers, deliberately kept apart:
 *
 * 1. **Funded buys and sells** (D4's definition, `classifyFundedSwap`) — a coin
 *    bought or sold against a funding leg (a stable mint or SOL). These are the
 *    numbers admission and promotion use: `entries24h` / `lastEntryAt` are
 *    funded buys, `exits24h` funded sells. A token inflow with no funding leg —
 *    a creator-fee distribution, an airdrop — is therefore never an entry.
 *
 * 2. **Coin movements** — the broader activity clock. Any transaction the
 *    leader signed that moved a priceable, non-funding coin on his own accounts,
 *    or that moved one on accounts we cannot attribute to him (program/PDA
 *    routed trades), counts as a trade. `copyableTrades24h` / `lastTradeAt` /
 *    `unattributedTrades24h` stay on this definition, so the pre-hire
 *    "is he moving coins at all" gate keeps its meaning.
 *
 * A coin only counts if it is copyable: it must carry a price/route quote
 * (`priceOf`), otherwise the engine could not buy it on our side. Dust below
 * `minTradeUsdMicro` is ignored, which is what filters spam from posing as
 * trades — unless the operator chose an airdrop-inclusive floor.
 */

import { classifyFundedSwap } from './swap.js';
import { STABLE_MINTS, WRAPPED_SOL_MINT, type LeaderTxSummary, type TokenDelta } from './tx.js';

export interface CopyableActivitySample {
  /** Trades that moved at least one copyable coin in the window (movement clock). */
  copyableTrades24h: number;
  /** Funded buys attributable to the leader's own accounts (D4 definition). */
  entries24h: number;
  /** Funded sells attributable to the leader's own accounts (D4 definition). */
  exits24h: number;
  /** Signed txs that moved a copyable coin on unattributable accounts. */
  unattributedTrades24h: number;
  /** Newest copyable trade (drives the quiet/stall clock). */
  lastTradeAt: string | null;
  /** Newest funded buy (drives "actively buying" and watch-list admission). */
  lastEntryAt: string | null;
  /** Distinct mints that had a price quote in this measurement. */
  pricedMints: number;
  /** Distinct non-funding mints that moved but could not be priced. */
  unbuyableMints: number;
  /** Transactions actually inspected for this sample. */
  scannedTxs: number;
}

export interface CopyableActivityOptions {
  nowMs: number;
  lookbackHours: number;
  /** Movements below this USD value are dust/airdrop noise. */
  minTradeUsdMicro: bigint;
  /** Micro-USD price of one whole token, or null when the coin is not copyable. */
  priceOf: (mint: string) => bigint | null;
  /** Safety cap on how many summaries are inspected. */
  maxTradeScan?: number;
}

export const DEFAULT_MIN_TRADE_USD_MICRO = 1_000_000n; // $1

function isFundingMint(mint: string): boolean {
  return STABLE_MINTS.has(mint) || mint === WRAPPED_SOL_MINT;
}

/** USD value of a base-unit delta, in micro-USD (integer math, no floats). */
export function usdValueMicro(deltaBase: bigint, decimals: number, priceUsdMicro: bigint): bigint {
  const abs = deltaBase < 0n ? -deltaBase : deltaBase;
  const scale = 10n ** BigInt(Math.max(0, decimals));
  return (abs * priceUsdMicro) / scale;
}

function classifyLeg(
  leg: TokenDelta,
  opts: CopyableActivityOptions,
): 'entry' | 'exit' | 'dust' | 'funding' | 'unbuyable' {
  if (isFundingMint(leg.mint)) return 'funding';
  if (leg.deltaBase === 0n) return 'dust';
  const price = opts.priceOf(leg.mint);
  if (price === null) return 'unbuyable';
  const usd = usdValueMicro(leg.deltaBase, leg.decimals, price);
  if (usd < opts.minTradeUsdMicro) return 'dust';
  return leg.deltaBase > 0n ? 'entry' : 'exit';
}

/**
 * Measure copyable activity from newest-first leader summaries. Pure: prices
 * are supplied by the caller (cached per run), so the same inputs always
 * produce the same counts.
 */
export function measureCopyableActivity(
  summaries: LeaderTxSummary[],
  opts: CopyableActivityOptions,
): CopyableActivitySample {
  const cutoffMs = opts.nowMs - opts.lookbackHours * 3_600_000;
  const maxScan = opts.maxTradeScan ?? summaries.length;
  const sample: CopyableActivitySample = {
    copyableTrades24h: 0,
    entries24h: 0,
    exits24h: 0,
    unattributedTrades24h: 0,
    lastTradeAt: null,
    lastEntryAt: null,
    pricedMints: 0,
    unbuyableMints: 0,
    scannedTxs: 0,
  };
  const priced = new Set<string>();
  const unbuyable = new Set<string>();

  for (const tx of summaries.slice(0, maxScan)) {
    if (tx.blockTime === null) continue;
    const tMs = tx.blockTime * 1000;
    if (tMs < cutoffMs) break; // newest-first: everything after is out of window
    sample.scannedTxs++;
    if (tx.err) continue; // failed txs move nothing
    const isoTs = new Date(tMs).toISOString();

    // --- funded layer: the D4 buy/sell definition --------------------------
    const swap = classifyFundedSwap(tx);
    if (swap) {
      const price = opts.priceOf(swap.mint);
      if (price === null) {
        unbuyable.add(swap.mint);
      } else {
        const usd = usdValueMicro(swap.tokenDeltaBase, swap.decimals, price);
        if (usd >= opts.minTradeUsdMicro) {
          priced.add(swap.mint);
          if (swap.side === 'buy') {
            sample.entries24h++;
            if (sample.lastEntryAt === null) sample.lastEntryAt = isoTs;
          } else {
            sample.exits24h++;
          }
        }
      }
    }

    // --- movement layer: the broader activity clock ------------------------
    let entries = 0;
    let exits = 0;
    for (const leg of tx.tokenDeltas) {
      const kind = classifyLeg(leg, opts);
      if (kind === 'entry') {
        entries++;
        priced.add(leg.mint);
      } else if (kind === 'exit') {
        exits++;
        priced.add(leg.mint);
      } else if (kind === 'unbuyable') {
        unbuyable.add(leg.mint);
      }
      // 'dust' legs are priced coins below the floor: noise, not a trade.
    }

    let unattributed = false;
    if (entries === 0 && exits === 0) {
      // Program/PDA-routed trades move coins on accounts we cannot attribute to
      // the leader. They are real activity, but never an entry: direction and
      // size are unknown, so they must not make a leader look like a buyer.
      for (const mint of tx.foreignTokenMints ?? []) {
        if (isFundingMint(mint)) continue;
        const price = opts.priceOf(mint);
        if (price === null) {
          unbuyable.add(mint);
          continue;
        }
        priced.add(mint);
        unattributed = true;
      }
    }

    if (entries === 0 && exits === 0 && !unattributed) continue;

    sample.copyableTrades24h++;
    if (unattributed) sample.unattributedTrades24h++;
    if (sample.lastTradeAt === null) sample.lastTradeAt = isoTs;
  }

  sample.pricedMints = priced.size;
  sample.unbuyableMints = unbuyable.size;
  return sample;
}
