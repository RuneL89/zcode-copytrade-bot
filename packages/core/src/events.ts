/**
 * Leader event classification from parsed on-chain balance evidence.
 * Conservative by design: when instructions and balances do not clearly
 * support a swap classification, the event is skipped or marked ambiguous.
 * The engine never guesses a buy, sell, amount, mint, or decimals.
 */

export const PARSER_VERSION = 'leader-parser/1';

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

/** Mainnet USD-stable mints. */
export const STABLE_MINTS = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface TokenDelta {
  mint: string;
  decimals: number;
  preBase: bigint;
  postBase: bigint;
  /** post - pre */
  deltaBase: bigint;
}

/** Provider-normalized, leader-scoped transaction summary (from verified RPC data). */
export interface LeaderTxSummary {
  chain: string;
  leaderAddress: string;
  signature: string;
  slot: number;
  transactionIndex: number;
  blockTime: number | null;
  err: boolean;
  /** Native SOL delta for the leader (base units, includes fees only as reported by RPC deltas). */
  nativeDeltaBase: bigint;
  /** Non-zero token deltas across token accounts owned by the leader. */
  tokenDeltas: TokenDelta[];
  /** Program IDs invoked (outer + inner instructions). */
  programs: string[];
}

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

function isFundingMint(mint: string, decimals: number): boolean {
  return STABLE_MINTS.has(mint) || mint === WRAPPED_SOL_MINT || (decimals === 6 && STABLE_MINTS.has(mint));
}

/** Deltas below this absolute base amount are treated as dust and ignored. */
const DUST_THRESHOLD_BASE = 1n;

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

  // BUY: exactly one non-funding token in, exactly one funding leg out (or native SOL out).
  if (tokenIns.length === 1 && tokenOuts.length === 0 && (fundingOuts.length === 1 || nativeOut)) {
    const token = tokenIns[0]!;
    if (fundingOuts.length === 1) {
      const funding = fundingOuts[0]!;
      return {
        ...base,
        kind: 'swap_buy',
        blockTime: tx.blockTime ?? 0,
        legIndex: 0,
        mint: token.mint,
        mintDecimals: token.decimals,
        tokenDeltaBase: token.deltaBase,
        fundingMint: funding.mint,
        fundingDecimals: funding.decimals,
        fundingDeltaBase: -funding.deltaBase,
      };
    }
    return {
      ...base,
      kind: 'swap_buy',
      blockTime: tx.blockTime ?? 0,
      legIndex: 0,
      mint: token.mint,
      mintDecimals: token.decimals,
      tokenDeltaBase: token.deltaBase,
      fundingMint: 'SOL',
      fundingDecimals: 9,
      fundingDeltaBase: -tx.nativeDeltaBase,
    };
  }

  // SELL: exactly one non-funding token out, exactly one funding leg in (or native SOL in).
  if (tokenOuts.length === 1 && tokenIns.length === 0 && (fundingIns.length === 1 || nativeIn)) {
    const token = tokenOuts[0]!;
    if (fundingIns.length === 1) {
      const funding = fundingIns[0]!;
      return {
        ...base,
        kind: 'swap_sell',
        blockTime: tx.blockTime ?? 0,
        legIndex: 0,
        mint: token.mint,
        mintDecimals: token.decimals,
        tokenDeltaBase: token.deltaBase,
        fundingMint: funding.mint,
        fundingDecimals: funding.decimals,
        fundingDeltaBase: funding.deltaBase,
      };
    }
    return {
      ...base,
      kind: 'swap_sell',
      blockTime: tx.blockTime ?? 0,
      legIndex: 0,
      mint: token.mint,
      mintDecimals: token.decimals,
      tokenDeltaBase: token.deltaBase,
      fundingMint: 'SOL',
      fundingDecimals: 9,
      fundingDeltaBase: tx.nativeDeltaBase,
    };
  }

  return {
    ...base,
    kind: 'skipped',
    reason: 'SKIPPED_AMBIGUOUS',
    detail: `ins=${ins.length} outs=${outs.length} nativeIn=${nativeIn} nativeOut=${nativeOut}`,
  };
}
