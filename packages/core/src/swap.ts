import { DUST_THRESHOLD_BASE, isFundingMint, type LeaderTxSummary, type TokenDelta } from './tx.js';

/**
 * The ONE definition of a funded swap (D4: "one definition of 'funded buy'
 * across the scanner and the copier").
 *
 *   buy  — exactly one non-funding token leg in, no non-funding leg out, and
 *          exactly one funding leg out (a stable mint or native SOL above dust);
 *   sell — the mirror: exactly one non-funding token leg out, none in, and
 *          exactly one funding leg in.
 *
 * Anything else is not a trade. In particular a creator-fee distribution or an
 * airdrop moves a token IN with no funding leg out: it is never an entry, in
 * the copier, in the activity measure or in the watch scanner.
 */
export type FundedSwapSide = 'buy' | 'sell';

export interface FundedSwap {
  side: FundedSwapSide;
  signature: string;
  slot: number;
  transactionIndex: number;
  blockTime: number | null;
  /** The traded (non-funding) coin. */
  mint: string;
  decimals: number;
  /**
   * Signed leader delta of the traded coin: positive for a buy, negative for a
   * sell. Base units.
   */
  tokenDeltaBase: bigint;
  /** Funding mint actually moved: a stable mint address, or 'SOL' for native. */
  fundingMint: string;
  fundingDecimals: number;
  /** Positive funding amount in base units: what the buy cost / the sell made. */
  fundingDeltaBase: bigint;
}

function significantDeltas(tx: LeaderTxSummary): TokenDelta[] {
  return tx.tokenDeltas.filter((d) => d.deltaBase !== 0n && d.postBase - d.preBase !== 0n);
}

/**
 * Classify a leader transaction as a funded buy or sell, or null when it is
 * not one. Structural only: callers keep their own gates (failed tx, NFT-like
 * zero-decimal legs, known-swap-program evidence) around it.
 */
export function classifyFundedSwap(tx: LeaderTxSummary): FundedSwap | null {
  if (tx.chain !== 'solana' || tx.err) return null;

  const significant = significantDeltas(tx);
  if (significant.length === 0 && tx.nativeDeltaBase === 0n) return null;
  if (significant.some((d) => d.decimals === 0)) return null; // NFT-like activity

  const ins = significant.filter((d) => d.deltaBase > 0n);
  const outs = significant.filter((d) => d.deltaBase < 0n);
  const nativeIn = tx.nativeDeltaBase > DUST_THRESHOLD_BASE;
  const nativeOut = tx.nativeDeltaBase < -DUST_THRESHOLD_BASE;

  const fundingIns = ins.filter((d) => isFundingMint(d.mint, d.decimals));
  const fundingOuts = outs.filter((d) => isFundingMint(d.mint, d.decimals));
  const tokenIns = ins.filter((d) => !isFundingMint(d.mint, d.decimals));
  const tokenOuts = outs.filter((d) => !isFundingMint(d.mint, d.decimals));

  const base = {
    signature: tx.signature,
    slot: tx.slot,
    transactionIndex: tx.transactionIndex,
    blockTime: tx.blockTime,
  };

  // BUY: one coin in, nothing else out, exactly one funding leg out.
  if (tokenIns.length === 1 && tokenOuts.length === 0 && (fundingOuts.length === 1 || nativeOut)) {
    const token = tokenIns[0]!;
    if (fundingOuts.length === 1) {
      const funding = fundingOuts[0]!;
      return {
        ...base,
        side: 'buy',
        mint: token.mint,
        decimals: token.decimals,
        tokenDeltaBase: token.deltaBase,
        fundingMint: funding.mint,
        fundingDecimals: funding.decimals,
        fundingDeltaBase: -funding.deltaBase,
      };
    }
    return {
      ...base,
      side: 'buy',
      mint: token.mint,
      decimals: token.decimals,
      tokenDeltaBase: token.deltaBase,
      fundingMint: 'SOL',
      fundingDecimals: 9,
      fundingDeltaBase: -tx.nativeDeltaBase,
    };
  }

  // SELL: one coin out, nothing else in, exactly one funding leg in.
  if (tokenOuts.length === 1 && tokenIns.length === 0 && (fundingIns.length === 1 || nativeIn)) {
    const token = tokenOuts[0]!;
    if (fundingIns.length === 1) {
      const funding = fundingIns[0]!;
      return {
        ...base,
        side: 'sell',
        mint: token.mint,
        decimals: token.decimals,
        tokenDeltaBase: token.deltaBase,
        fundingMint: funding.mint,
        fundingDecimals: funding.decimals,
        fundingDeltaBase: funding.deltaBase,
      };
    }
    return {
      ...base,
      side: 'sell',
      mint: token.mint,
      decimals: token.decimals,
      tokenDeltaBase: token.deltaBase,
      fundingMint: 'SOL',
      fundingDecimals: 9,
      fundingDeltaBase: tx.nativeDeltaBase,
    };
  }

  return null;
}
