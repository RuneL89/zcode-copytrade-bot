import type { LossStreakUnit } from '@zcode-bot/config';
import type { MicroUsd } from './money.js';

export type CloseUnitType = 'position_closed' | 'partial_close';

export interface StreakConfig {
  unit: LossStreakUnit;
  /** Fire after this many consecutive losing units. Fixed at 2 by the spec. */
  fireAfter: number;
  /**
   * Explicit breakeven policy (tested):
   * false (default): a breakeven unit neither increments nor resets the streak.
   * true: a breakeven unit resets the streak like a win.
   */
  breakevenResets: boolean;
}

export interface StreakResult {
  streak: number;
  /** The unit just recorded: 'loss' | 'win' | 'breakeven'. */
  unitResult: 'loss' | 'win' | 'breakeven';
  fired: boolean;
}

export function classifyUnit(pnlUsdMicro: MicroUsd): 'loss' | 'win' | 'breakeven' {
  if (pnlUsdMicro < 0n) return 'loss';
  if (pnlUsdMicro > 0n) return 'win';
  return 'breakeven';
}

/**
 * Net realized PnL after measurable fees decides the unit result.
 * Unrealized losses never enter this function.
 */
export function applyCloseUnit(
  streakBefore: number,
  pnlUsdMicro: MicroUsd,
  config: StreakConfig,
): StreakResult {
  const unitResult = classifyUnit(pnlUsdMicro);
  let streak = streakBefore;
  if (unitResult === 'loss') streak = streakBefore + 1;
  else if (unitResult === 'win' || (unitResult === 'breakeven' && config.breakevenResets)) {
    streak = 0;
  }
  return { streak, unitResult, fired: streak >= config.fireAfter };
}

/** Which closes count as streak units under the configured unit type. */
export function countsAsUnit(unitType: CloseUnitType, config: StreakConfig): boolean {
  if (config.unit === 'every_partial_close') return true;
  return unitType === 'position_closed';
}
