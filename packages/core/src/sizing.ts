import type { MicroUsd } from './money.js';

export type SizingAction = 'copy' | 'skip_below_min' | 'skip_invalid' | 'skip_headroom';

export interface SizingInput {
  /** Leader's measured input notional in micro-USD (already priced). */
  leaderInputUsdMicro: MicroUsd;
  /** Copy scale as an exact rational, e.g. 1/4 for 0.25x. */
  scaleNumerator: bigint;
  scaleDenominator: bigint;
  minPerBuyUsdMicro: MicroUsd;
  maxPerBuyUsdMicro: MicroUsd;
  /**
   * When false (the default and the documented default), a desired notional
   * below MIN_PER_BUY_USD is skipped, never silently rounded up.
   */
  allowBelowMinRoundUp: boolean;
}

export interface SizingResult {
  action: SizingAction;
  /** Desired notional = leader input x scale, exact. */
  desiredUsdMicro: MicroUsd;
  /** Notional actually used when action === 'copy'. */
  finalUsdMicro: MicroUsd | null;
  /** Which limit, if any, shaped the outcome. */
  applied: 'none' | 'capped_at_max' | 'rounded_up_to_min' | 'below_min' | 'invalid_input';
}

/**
 * Deterministic 0.25x sizing.
 *
 * Rules (documented; tests pin them):
 * - desired = floor(leaderInput * num / den) in micro-USD.
 * - desired > max  -> copy exactly max.
 * - desired < min  -> skip (action 'skip_below_min') unless allowBelowMinRoundUp,
 *                     in which case copy exactly min. The UI must disclose the
 *                     override whenever it is enabled.
 * - leaderInput <= 0 -> skip invalid.
 */
export function computeCopyNotional(input: SizingInput): SizingResult {
  const {
    leaderInputUsdMicro,
    scaleNumerator,
    scaleDenominator,
    minPerBuyUsdMicro,
    maxPerBuyUsdMicro,
    allowBelowMinRoundUp,
  } = input;
  if (scaleNumerator <= 0n || scaleDenominator <= 0n) {
    return { action: 'skip_invalid', desiredUsdMicro: 0n, finalUsdMicro: null, applied: 'invalid_input' };
  }
  if (leaderInputUsdMicro <= 0n) {
    return { action: 'skip_invalid', desiredUsdMicro: 0n, finalUsdMicro: null, applied: 'invalid_input' };
  }
  const desired = (leaderInputUsdMicro * scaleNumerator) / scaleDenominator;
  if (desired > maxPerBuyUsdMicro) {
    return {
      action: 'copy',
      desiredUsdMicro: desired,
      finalUsdMicro: maxPerBuyUsdMicro,
      applied: 'capped_at_max',
    };
  }
  if (desired < minPerBuyUsdMicro) {
    if (allowBelowMinRoundUp) {
      return {
        action: 'copy',
        desiredUsdMicro: desired,
        finalUsdMicro: minPerBuyUsdMicro,
        applied: 'rounded_up_to_min',
      };
    }
    return { action: 'skip_below_min', desiredUsdMicro: desired, finalUsdMicro: null, applied: 'below_min' };
  }
  return { action: 'copy', desiredUsdMicro: desired, finalUsdMicro: desired, applied: 'none' };
}

export type HeadroomCapResult =
  | { action: 'copy'; finalUsdMicro: MicroUsd; downsized: boolean }
  | { action: 'skip_headroom'; headroomUsdMicro: MicroUsd };

/**
 * Bankroll headroom step, applied after computeCopyNotional and before the
 * risk gate: a sized notional larger than the remaining deployed-% headroom is
 * downsized to fit; only a remainder below the per-bet minimum is skipped.
 */
export function capToHeadroom(
  notionalUsdMicro: MicroUsd,
  headroomUsdMicro: MicroUsd,
  minPerBuyUsdMicro: MicroUsd,
): HeadroomCapResult {
  if (notionalUsdMicro <= headroomUsdMicro) {
    return { action: 'copy', finalUsdMicro: notionalUsdMicro, downsized: false };
  }
  if (headroomUsdMicro >= minPerBuyUsdMicro) {
    return { action: 'copy', finalUsdMicro: headroomUsdMicro, downsized: true };
  }
  return { action: 'skip_headroom', headroomUsdMicro };
}
