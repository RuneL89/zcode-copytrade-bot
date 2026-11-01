/**
 * Copyable-trade measurement (operator decision, 2026-11-01).
 *
 * A candidate's on-chain activity is measured in COIN MOVEMENTS, not raw
 * transactions and not buy/sell verdicts:
 *
 *   entry — the leader's own balance of a non-funding mint rose in the tx
 *   exit  — the leader's own balance of a non-funding mint fell in the tx
 *   trade — any tx that qualified at least one entry or exit, OR a tx the
 *           leader signed that moved a copyable coin on accounts we cannot
 *           attribute to him (program/PDA-routed trades). An unattributed
 *           trade counts as activity, never as an entry.
 *
 * The quote asset is irrelevant: paying with SOL, USDC or another token all
 * count the same. Funding mints (USD stables, wrapped SOL) are quote legs, not
 * the coin being copied.
 *
 * A coin only counts if it is copyable: it must carry a price/route quote
 * (`priceOf`), otherwise the engine could not buy it on our side. Dust below
 * `minTradeUsdMicro` is ignored, which is what filters airdrops and spam from
 * posing as trades — unless the operator chose an airdrop-inclusive floor.
 */

import {
  STABLE_MINTS,
  WRAPPED_SOL_MINT,
  type LeaderTxSummary,
  type TokenDelta,
} from './events.js';

export interface CopyableActivitySample {
  /** Trades that moved at least one copyable coin in the window. */
  copyableTrades24h: number;
  /** Coin inflows attributable to the leader's own accounts. */
  entries24h: number;
  /** Coin outflows attributable to the leader's own accounts. */
  exits24h: number;
  /** Signed txs that moved a copyable coin on unattributable accounts. */
  unattributedTrades24h: number;
  /** Newest copyable trade (drives the quiet/stall clock). */
  lastTradeAt: string | null;
  /** Newest attributable entry (drives "actively buying" at hire time). */
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
    sample.entries24h += entries;
    sample.exits24h += exits;
    if (unattributed) sample.unattributedTrades24h++;
    const iso = new Date(tMs).toISOString();
    if (sample.lastTradeAt === null) sample.lastTradeAt = iso;
    if (entries > 0 && sample.lastEntryAt === null) sample.lastEntryAt = iso;
  }

  sample.pricedMints = priced.size;
  sample.unbuyableMints = unbuyable.size;
  return sample;
}
