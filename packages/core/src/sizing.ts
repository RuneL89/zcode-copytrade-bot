import type { MicroUsd } from './money.js';

export type SizingAction = 'copy' | 'skip_invalid' | 'skip_headroom';

export interface SizingInput {
  /** Leader's measured input notional in micro-USD (already priced). */
  leaderInputUsdMicro: MicroUsd;
  /** Copy scale as an exact rational, e.g. 1/4 for 0.25x. */
  scaleNumerator: bigint;
  scaleDenominator: bigint;
  /** Hard floor: a copy that scales below it is placed at it, never skipped. */
  minPerBuyUsdMicro: MicroUsd;
  maxPerBuyUsdMicro: MicroUsd;
}

export interface SizingResult {
  action: SizingAction;
  /** Desired notional = leader input x scale, exact. */
  desiredUsdMicro: MicroUsd;
  /** Notional actually used when action === 'copy'. */
  finalUsdMicro: MicroUsd | null;
  /** Which limit, if any, shaped the outcome. */
  applied: 'none' | 'capped_at_max' | 'rounded_up_to_min' | 'invalid_input';
}

/**
 * Deterministic 0.25x sizing.
 *
 * Rules (documented; tests pin them):
 * - desired = floor(leaderInput * num / den) in micro-USD.
 * - desired > max  -> copy exactly max.
 * - desired < min  -> copy exactly min ('rounded_up_to_min'). MIN_PER_BUY_USD is
 *                     an absolute floor: even a leader buy whose scaled copy
 *                     falls below it is copied at the floor, never skipped.
 *                     The 0.25x scale yields to the floor in that case.
 * - leaderInput <= 0 -> skip invalid (the only skip left in sizing).
 */
export function computeCopyNotional(input: SizingInput): SizingResult {
  const { leaderInputUsdMicro, scaleNumerator, scaleDenominator, minPerBuyUsdMicro, maxPerBuyUsdMicro } =
    input;
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
    return {
      action: 'copy',
      desiredUsdMicro: desired,
      finalUsdMicro: minPerBuyUsdMicro,
      applied: 'rounded_up_to_min',
    };
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

export type CopyLimit = 'none' | 'floor' | 'per_trade' | 'per_trader' | 'bankroll';

export interface SizeCopyInput {
  leaderInputUsdMicro: MicroUsd;
  scaleNumerator: bigint;
  scaleDenominator: bigint;
  minPerBuyUsdMicro: MicroUsd;
  /** Hard ceiling on one copied buy. */
  maxPerBuyUsdMicro: MicroUsd;
  /** Open exposure already booked for this trader (entries + entry fees). */
  traderOpenUsdMicro: MicroUsd;
  /** Max open exposure for one hired trader. */
  maxOpenPerTraderUsdMicro: MicroUsd;
  /** Remaining room under the bankroll deployed-% cap. */
  bankrollHeadroomUsdMicro: MicroUsd;
}

export type SizeCopyResult =
  | { action: 'copy'; finalUsdMicro: MicroUsd; limitedBy: CopyLimit }
  | { action: 'skip_invalid' }
  | {
      action: 'skip_headroom';
      rule: 'MAX_OPEN_PER_TRADER_PCT' | 'MAX_DEPLOYED_PCT';
      headroomUsdMicro: MicroUsd;
    };

/**
 * Copy size in the order the desk applies it:
 * scale, then the per-trade ceiling and floor, then this trader's open-exposure
 * room, then the shared bankroll headroom. A remainder below the floor is skipped.
 */
export function sizeCopy(input: SizeCopyInput): SizeCopyResult {
  const scaled = computeCopyNotional({
    leaderInputUsdMicro: input.leaderInputUsdMicro,
    scaleNumerator: input.scaleNumerator,
    scaleDenominator: input.scaleDenominator,
    minPerBuyUsdMicro: input.minPerBuyUsdMicro,
    maxPerBuyUsdMicro: input.maxPerBuyUsdMicro,
  });
  if (scaled.action !== 'copy' || scaled.finalUsdMicro === null) return { action: 'skip_invalid' };

  let notional = scaled.finalUsdMicro;
  let limitedBy: CopyLimit =
    scaled.applied === 'capped_at_max'
      ? 'per_trade'
      : scaled.applied === 'rounded_up_to_min'
        ? 'floor'
        : 'none';

  const traderRoom =
    input.maxOpenPerTraderUsdMicro > input.traderOpenUsdMicro
      ? input.maxOpenPerTraderUsdMicro - input.traderOpenUsdMicro
      : 0n;
  const trader = capToHeadroom(notional, traderRoom, input.minPerBuyUsdMicro);
  if (trader.action === 'skip_headroom') {
    return {
      action: 'skip_headroom',
      rule: 'MAX_OPEN_PER_TRADER_PCT',
      headroomUsdMicro: trader.headroomUsdMicro,
    };
  }
  if (trader.downsized) limitedBy = 'per_trader';
  notional = trader.finalUsdMicro;

  const bank = capToHeadroom(notional, input.bankrollHeadroomUsdMicro, input.minPerBuyUsdMicro);
  if (bank.action === 'skip_headroom') {
    return { action: 'skip_headroom', rule: 'MAX_DEPLOYED_PCT', headroomUsdMicro: bank.headroomUsdMicro };
  }
  if (bank.downsized) limitedBy = 'bankroll';
  return { action: 'copy', finalUsdMicro: bank.finalUsdMicro, limitedBy };
}
