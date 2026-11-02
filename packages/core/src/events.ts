/**
 * Leader event classification from parsed on-chain balance evidence.
 * Conservative by design: when instructions and balances do not clearly
 * support a swap classification, the event is skipped or marked ambiguous.
 * The engine never guesses a buy, sell, amount, mint, or decimals.
 */

import { classifyFundedSwap } from './swap.js';
import { DUST_THRESHOLD_BASE, PARSER_VERSION, isFundingMint, type LeaderTxSummary } from './tx.js';

/** The parser version this classifier stamps on every event. */
export { PARSER_VERSION };

/** Mainnet program IDs of common DEX/aggregator programs (balance evidence still required). */
export const KNOWN_SWAP_PROGRAMS = new Set<string>([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  'JUP3c2Uh3XA4yrRGuScvPL8gjVMUK6NUq94sDN3j1vx', // Jupiter v4 (legacy)
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Orca v2 (legacy)
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Pump.fun AMM
  'MoonCVVNZFSYkqNXP6cjHLdYcTkVDkTMZNPb9JqMhMXJL', // Moonshot
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DLMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DAMM
  'FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X', // Fluxbeam
]);

export type LeaderClassifiedEvent = SwapBuyEvent | SwapSellEvent | SkippedEvent;

export interface SwapBuyEvent {
  kind: 'swap_buy';
  signature: string;
  slot: number;
  transactionIndex: number;
  blockTime: number;
  legIndex: number;
  /** Non-funding token mint being traded. */
  mint: string;
  mintDecimals: number;
  /** Base-unit inflow of the traded mint. */
  tokenDeltaBase: bigint;
  /** Funding mint actually moved (stable or SOL). */
  fundingMint: string;
  fundingDecimals: number;
  /** Leader input notional leg in funding-token base units. */
  fundingDeltaBase: bigint;
  parserVersion: string;
}

export interface SwapSellEvent {
  kind: 'swap_sell';
  signature: string;
  slot: number;
  transactionIndex: number;
  blockTime: number;
  legIndex: number;
  /** Non-funding token mint being traded. */
  mint: string;
  mintDecimals: number;
  /** Base-unit outflow of the traded mint (negative). */
  tokenDeltaBase: bigint;
  /** Funding mint actually moved (stable or SOL). */
  fundingMint: string;
  fundingDecimals: number;
  /** Leader proceeds leg in funding-token base units (positive). */
  fundingDeltaBase: bigint;
  parserVersion: string;
}

export interface SkippedEvent {
  kind: 'skipped';
  signature: string;
  slot: number;
  transactionIndex: number;
  reason:
    | 'SKIPPED_UNSUPPORTED_CHAIN'
    | 'SKIPPED_FAILED_TX'
    | 'SKIPPED_TRANSFER'
    | 'SKIPPED_AIRDROP'
    | 'SKIPPED_NFT_ACTIVITY'
    | 'SKIPPED_STABLE_TO_STABLE'
    | 'SKIPPED_NO_BALANCE_CHANGES'
    | 'SKIPPED_AMBIGUOUS'
    | 'SKIPPED_DUST'
    | 'SKIPPED_OTHER';
  detail?: string;
  parserVersion: string;
}

/**
 * Result of scanning classified leader history for a recent buy.
 * `lastBuyAt` is set only when the most recent buy falls inside the scanned
 * window (sell-only or quiet wallets get null). `boundaryReached` tells the
 * caller it can stop paging: every row seen predates the cutoff.
 */
export interface LastBuyScan {
  lastBuyAt: string | null;
  boundaryReached: boolean;
}

/**
 * Actively-trading scan (operator decision, 2026-10-31): the most recent BUY
 * — not any swap — inside the window is what marks a leader as actively
 * trading. Sells, failed txs, transfers and ambiguous rows are walked past.
 * `summaries` MUST be ordered newest-first (the caller sorts the RPC page);
 * the first `swap_buy` encountered is therefore the most recent buy.
 */
export function scanForRecentBuy(summaries: LeaderTxSummary[], cutoffMs: number): LastBuyScan {
  for (const tx of summaries) {
    if (tx.blockTime === null) continue;
    const t = tx.blockTime * 1000;
    if (t < cutoffMs) {
      return { lastBuyAt: null, boundaryReached: true };
    }
    if (classifyLeaderEvent(tx).kind === 'swap_buy') {
      return { lastBuyAt: new Date(t).toISOString(), boundaryReached: false };
    }
  }
  return { lastBuyAt: null, boundaryReached: false };
}

export function classifyLeaderEvent(tx: LeaderTxSummary): LeaderClassifiedEvent {
  const base = {
    signature: tx.signature,
    slot: tx.slot,
    transactionIndex: tx.transactionIndex,
    parserVersion: PARSER_VERSION,
  };

  if (tx.chain !== 'solana') {
    return {
      ...base,
      kind: 'skipped',
      reason: 'SKIPPED_UNSUPPORTED_CHAIN',
      detail: `chain ${tx.chain} has no execution adapter`,
    };
  }
  if (tx.err) {
    return { ...base, kind: 'skipped', reason: 'SKIPPED_FAILED_TX' };
  }

  const significant = tx.tokenDeltas.filter(
    (d) => d.deltaBase !== 0n && (d.postBase - d.preBase !== 0n || d.deltaBase !== 0n),
  );
  const nftLike = significant.filter((d) => d.decimals === 0);
  const hasKnownSwap = tx.programs.some((p) => KNOWN_SWAP_PROGRAMS.has(p));

  if (significant.length === 0 && tx.nativeDeltaBase === 0n) {
    return { ...base, kind: 'skipped', reason: 'SKIPPED_NO_BALANCE_CHANGES' };
  }
  if (nftLike.length > 0) {
    return {
      ...base,
      kind: 'skipped',
      reason: 'SKIPPED_NFT_ACTIVITY',
      detail: 'zero-decimals token movement',
    };
  }
  // Ordinary transfer/airdrop: single token leg and no swap-program evidence.
  if (!hasKnownSwap) {
    if (significant.length === 1 && tx.nativeDeltaBase === 0n) {
      const only = significant[0]!;
      return only.deltaBase > 0n
        ? { ...base, kind: 'skipped', reason: 'SKIPPED_AIRDROP', detail: `inbound ${only.mint}` }
        : { ...base, kind: 'skipped', reason: 'SKIPPED_TRANSFER', detail: `outbound ${only.mint}` };
    }
    // Balance pattern looks swap-like but no known program -> fail closed.
    return {
      ...base,
      kind: 'skipped',
      reason: 'SKIPPED_AMBIGUOUS',
      detail: 'swap-like balances without a known swap program',
    };
  }

  const ins = significant.filter((d) => d.deltaBase > 0n);
  const outs = significant.filter((d) => d.deltaBase < 0n);
  const nativeIn = tx.nativeDeltaBase > DUST_THRESHOLD_BASE;
  const nativeOut = tx.nativeDeltaBase < -DUST_THRESHOLD_BASE;

  const fundingIns = ins.filter((d) => isFundingMint(d.mint, d.decimals));
  const fundingOuts = outs.filter((d) => isFundingMint(d.mint, d.decimals));
  const tokenIns = ins.filter((d) => !isFundingMint(d.mint, d.decimals));
  const tokenOuts = outs.filter((d) => !isFundingMint(d.mint, d.decimals));

  // Stable <-> stable (or USDC<->USDT arbitrage): never a copyable position.
  if (fundingIns.length + fundingOuts.length >= 2 && tokenIns.length === 0 && tokenOuts.length === 0) {
    return { ...base, kind: 'skipped', reason: 'SKIPPED_STABLE_TO_STABLE' };
  }

  // The buy/sell definition itself is single-sourced in swap.ts; this module
  // keeps its own gates (chain, failed tx, no balance changes, NFT-like legs,
  // known swap program) and its own skip reasons around it.
  const funded = classifyFundedSwap(tx);
  if (funded) {
    const leg = {
      ...base,
      blockTime: funded.blockTime ?? 0,
      legIndex: 0,
      mint: funded.mint,
      mintDecimals: funded.decimals,
      tokenDeltaBase: funded.tokenDeltaBase,
      fundingMint: funded.fundingMint,
      fundingDecimals: funded.fundingDecimals,
      fundingDeltaBase: funded.fundingDeltaBase,
    };
    return funded.side === 'buy' ? { ...leg, kind: 'swap_buy' } : { ...leg, kind: 'swap_sell' };
  }

  return {
    ...base,
    kind: 'skipped',
    reason: 'SKIPPED_AMBIGUOUS',
    detail: `ins=${ins.length} outs=${outs.length} nativeIn=${nativeIn} nativeOut=${nativeOut}`,
  };
}
