/** Fields where a larger number takes more risk. */
const HIGHER_IS_RISKIER = [
  'MAX_PER_BUY_PCT',
  'MAX_OPEN_PER_TRADER_PCT',
  'MAX_DEPLOYED_PCT',
  'STOP_LOSS_BPS',
  'TRAIL_DISTANCE_BPS',
  'TRAIL_ARM_BPS',
  'MAX_POSITION_AGE_HOURS',
  'POSITION_GRACE_HOURS',
  'EXIT_SLIPPAGE_BPS_1',
  'EXIT_SLIPPAGE_BPS_2',
  'EXIT_SLIPPAGE_BPS_3',
  'MAX_HIRES_PER_DAY',
] as const;

/** Fields where a smaller number takes more risk. */
const LOWER_IS_RISKIER = ['MIN_PER_BUY_USD'] as const;

export type RiskDirection = 'increase' | 'decrease' | 'neutral';

export function riskPatchDirection(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): RiskDirection {
  let direction: RiskDirection = 'neutral';
  for (const key of HIGHER_IS_RISKIER) {
    if (!(key in patch)) continue;
    const next = Number(patch[key]);
    const prev = Number(current[key]);
    if (!Number.isFinite(next) || !Number.isFinite(prev) || next === prev) continue;
    if (next > prev) return 'increase';
    direction = 'decrease';
  }
  for (const key of LOWER_IS_RISKIER) {
    if (!(key in patch)) continue;
    const next = Number(patch[key]);
    const prev = Number(current[key]);
    if (!Number.isFinite(next) || !Number.isFinite(prev) || next === prev) continue;
    if (next < prev) return 'increase';
    direction = 'decrease';
  }
  if (patch.SELL_ON_GREEN === false && current.SELL_ON_GREEN !== false) return 'increase';
  if (patch.SELL_ON_GREEN === true && current.SELL_ON_GREEN === false) direction = 'decrease';
  return direction;
}
