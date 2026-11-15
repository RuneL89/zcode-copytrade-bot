/**
 * Day-trader time discipline: copied positions are never held open-ended.
 * A position older than MAX_POSITION_AGE_HOURS is sold when its unrealized
 * PnL (mark − entry cost, excluding fees) is positive; otherwise it enters a
 * grace window and is force-closed at MAX_POSITION_AGE_HOURS +
 * POSITION_GRACE_HOURS no matter what. All arithmetic is pure and testable.
 */

export type TimeExitDecision = 'none' | 'sell_positive' | 'sell_expired';

export interface TimeExitInput {
  /** First-entry timestamp of the position (ISO). Pyramiding never moves it. */
  openedAtIso: string;
  nowMs: number;
  maxAgeHours: number;
  graceHours: number;
  /**
   * Unrealized PnL excluding fees (mark − entry cost), micro-USD. Null when
   * no fresh mark exists — the positive branch never fires without a mark.
   */
  unrealizedExclFeesUsdMicro: bigint | null;
  /**
   * True once the position was seen past maxAge with non-positive PnL — it
   * then rides the whole grace window and only the expired close applies
   * (ride-grace semantics: turning green mid-grace does not sell).
   */
  graceEntered?: boolean;
}

export function timeExitDecision(input: TimeExitInput): TimeExitDecision {
  const openedAt = Date.parse(input.openedAtIso);
  if (!Number.isFinite(openedAt)) return 'none';
  const ageHours = (input.nowMs - openedAt) / 3_600_000;
  if (ageHours >= input.maxAgeHours + input.graceHours) return 'sell_expired';
  if (ageHours >= input.maxAgeHours) {
    if (input.graceEntered) return 'none';
    if (input.unrealizedExclFeesUsdMicro !== null && input.unrealizedExclFeesUsdMicro > 0n) {
      return 'sell_positive';
    }
  }
  return 'none';
}

export interface IdleInput {
  /** When the flat clock measures from: hire time or last held position (ISO). */
  baselineIso: string;
  nowMs: number;
  idleFireHours: number;
}

/** True when the activation has been flat (or empty) for longer than the limit. */
export function isIdleOver(input: IdleInput): boolean {
  const baseline = Date.parse(input.baselineIso);
  if (!Number.isFinite(baseline)) return false;
  return input.nowMs - baseline >= input.idleFireHours * 3_600_000;
}

export type DayTradeExit =
  | 'none'
  | 'stop_loss'
  | 'trailing_stop'
  | 'partial_take_profit'
  | 'max_hold_green'
  | 'grace_green'
  | 'grace_bounce'
  | 'grace_expired';

export interface DayTradeExitInput {
  openedAtIso: string;
  nowMs: number;
  maxAgeHours: number;
  graceHours: number;
  /** Entry value and mark in the same micro-USD unit (position value or token price). */
  entryUsdMicro: bigint;
  markUsdMicro: bigint | null;
  /** Highest mark seen since entry. Null until the first mark. */
  peakUsdMicro: bigint | null;
  /** Lowest mark seen since the max-hold deadline. Null outside grace. */
  lowSinceMaxHoldUsdMicro: bigint | null;
  stopLossBps: number;
  trailArmBps: number;
  trailDistanceBps: number;
  /** 0 disables the partial take-profit. */
  partialTpBps: number;
  partialTaken: boolean;
  graceBounceBps: number;
  /**
   * When true, a green mark at or after max hold sells immediately, including
   * a recovery during grace. When false, grace rides through a recovery and
   * only the deadline force-closes (the previous rule).
   */
  sellOnGreen: boolean;
  /** Set once a non-positive mark was seen at max hold. Used only when sellOnGreen is false. */
  graceEntered?: boolean;
}

function shiftBps(base: bigint, bps: number, direction: 1 | -1): bigint {
  const signed = 10_000n + BigInt(direction) * BigInt(bps);
  return (base * signed) / 10_000n;
}

/**
 * Code exit for one open position. Price rules run before the clock.
 * A missing mark never invents a stop or a trail; the grace deadline still
 * force-closes, because that close does not need a price to be owed.
 */
export function dayTradeExitDecision(input: DayTradeExitInput): DayTradeExit {
  const openedAt = Date.parse(input.openedAtIso);
  if (!Number.isFinite(openedAt) || input.entryUsdMicro <= 0n) return 'none';
  const ageHours = (input.nowMs - openedAt) / 3_600_000;
  const mark = input.markUsdMicro;
  const graceEnd = input.maxAgeHours + input.graceHours;

  if (mark !== null && mark > 0n) {
    const stop = shiftBps(input.entryUsdMicro, input.stopLossBps, -1);
    if (mark <= stop) return 'stop_loss';

    const arm = shiftBps(input.entryUsdMicro, input.trailArmBps, 1);
    const peak = input.peakUsdMicro !== null && input.peakUsdMicro > mark ? input.peakUsdMicro : mark;
    if (peak >= arm) {
      const trail = shiftBps(peak, input.trailDistanceBps, -1);
      if (mark <= trail) return 'trailing_stop';
    }

    if (!input.partialTaken && input.partialTpBps > 0) {
      const tp = shiftBps(input.entryUsdMicro, input.partialTpBps, 1);
      if (mark >= tp) return 'partial_take_profit';
    }
  }

  if (ageHours >= graceEnd) return 'grace_expired';
  if (ageHours < input.maxAgeHours) return 'none';

  if (mark !== null && mark > input.entryUsdMicro) {
    if (input.sellOnGreen || !input.graceEntered) {
      return ageHours > input.maxAgeHours ? 'grace_green' : 'max_hold_green';
    }
  }
  if (
    input.sellOnGreen &&
    mark !== null &&
    input.lowSinceMaxHoldUsdMicro !== null &&
    input.lowSinceMaxHoldUsdMicro > 0n
  ) {
    const bounce = shiftBps(input.lowSinceMaxHoldUsdMicro, input.graceBounceBps, 1);
    if (mark >= bounce && mark <= input.entryUsdMicro) return 'grace_bounce';
  }
  return 'none';
}

/** Slippage cap for exit attempt `index` (0-based). The last step is reused. */
export function exitSlippageBps(attempt: number, ladder: readonly number[]): number {
  if (ladder.length === 0) throw new Error('exitSlippageBps: ladder is empty');
  const index = Math.min(Math.max(0, Math.floor(attempt)), ladder.length - 1);
  const step = ladder[index];
  if (step === undefined || step <= 0) throw new Error('exitSlippageBps: step must be positive');
  return step;
}
