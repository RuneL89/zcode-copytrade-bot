import { applyBpsToBase } from './money.js';

/** Residual leader balance below this fraction of pre-balance counts as a full exit. */
export const FULL_EXIT_DUST_BPS = 5n; // 0.05%

export interface LeaderSellInput {
  /** Leader verified pre-balance of the tracked mint, base units. */
  preBase: bigint;
  /** Leader verified post-balance of the tracked mint, base units. */
  postBase: bigint;
}

export interface SoldFraction {
  /** 0..10000 basis points of the leader's holding that was sold. */
  soldBps: number;
  /** True when the leader's exit is treated as full (post ~ 0). */
  full: boolean;
}

/**
 * Derive the leader's sold fraction from VERIFIED pre/post balances.
 * Never invents amounts: if post > pre (balance grew) the result is invalid.
 */
export function leaderSoldFraction(input: LeaderSellInput): SoldFraction {
  const { preBase, postBase } = input;
  if (preBase <= 0n) throw new Error('leaderSoldFraction: pre-balance must be positive');
  if (postBase < 0n) throw new Error('leaderSoldFraction: post-balance must not be negative');
  if (postBase > preBase) throw new Error('leaderSoldFraction: post > pre (balance grew; not a sell)');

  const residualBps = (postBase * 10000n) / preBase;
  if (residualBps <= FULL_EXIT_DUST_BPS) return { soldBps: 10000, full: true };

  const soldBps = Number(((preBase - postBase) * 10000n) / preBase);
  return { soldBps, full: false };
}

export interface CopiedExitPlan {
  /** Whole remaining copied amount to sell now, base units. */
  exitBase: bigint;
  /** Remaining tracked amount after this exit, base units. */
  remainingBase: bigint;
  /** True when the entire remaining position is being closed. */
  full: boolean;
}

/**
 * Apply the leader's sold fraction to the tracked copied position.
 * A full leader exit closes the ENTIRE remaining copied position.
 * Partial exits floor (never oversell) and leave dust-free bookkeeping:
 * the final partial that leaves < 1 base unit remainder closes everything.
 */
export function planCopiedExit(params: {
  remainingBase: bigint;
  soldBps: number;
  full: boolean;
}): CopiedExitPlan {
  const { remainingBase, soldBps, full } = params;
  if (remainingBase <= 0n) throw new Error('planCopiedExit: no remaining amount');
  if (full || soldBps >= 10000) {
    return { exitBase: remainingBase, remainingBase: 0n, full: true };
  }
  if (soldBps <= 0) {
    return { exitBase: 0n, remainingBase, full: false };
  }
  const exitBase = applyBpsToBase(remainingBase, soldBps);
  if (exitBase <= 0n || remainingBase - exitBase < 1n) {
    return { exitBase: remainingBase, remainingBase: 0n, full: true };
  }
  return { exitBase, remainingBase: remainingBase - exitBase, full: false };
}
