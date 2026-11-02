/**
 * Provider-normalized leader transaction primitives, shared by every
 * classifier in the package (swap / events / activity). Kept in its own module
 * so the funded-swap definition can be imported by the event classifier
 * without an import cycle.
 */

export const PARSER_VERSION = 'leader-parser/1';

export const STABLE_MINTS = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Deltas below this absolute base amount are treated as dust and ignored. */
export const DUST_THRESHOLD_BASE = 1n;

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
  /**
   * Mints that moved on token accounts NOT owned by the leader (pool vaults,
   * program/PDA accounts). Signer-attributed measurements use these to count a
   * routed trade as activity without ever claiming it as an entry.
   */
  foreignTokenMints?: string[];
  /** Program IDs invoked (outer + inner instructions). */
  programs: string[];
}

/** True for quote assets: USD stables and wrapped SOL are funding legs, not coins. */
export function isFundingMint(mint: string, decimals: number): boolean {
  return STABLE_MINTS.has(mint) || mint === WRAPPED_SOL_MINT || (decimals === 6 && STABLE_MINTS.has(mint));
}
