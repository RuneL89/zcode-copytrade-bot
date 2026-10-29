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
