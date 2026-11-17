import { describe, expect, it } from 'vitest';
import {
  timeExitDecision,
  isIdleOver,
  dayTradeExitDecision,
  exitSlippageBps,
  unpriceableShadowExitDecision,
} from '../src/positionAge.js';
import { usdToMicro } from '../src/money.js';

const OPENED = '2026-10-28T13:12:00.000Z';
const T = (h: number) => Date.parse(OPENED) + h * 3_600_000;

describe('timeExitDecision', () => {
  it('never fires inside the hold window', () => {
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(15.9),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(5),
      }),
    ).toBe('none');
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(8),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(-5),
      }),
    ).toBe('none');
  });
  it('sells positive PnL (excl. fees) from 16h', () => {
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(16),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(0.01),
      }),
    ).toBe('sell_positive');
  });
  it('ride-grace: once negative past 16h, holds to 19h even if green', () => {
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(16),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(-2),
      }),
    ).toBe('none');
    // 16h check was negative -> graceEntered persisted -> turning green holds.
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(17),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(9),
        graceEntered: true,
      }),
    ).toBe('none');
    // Never seen negative past 16h (e.g. monitor downtime): positive sells on sight.
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(17),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(9),
        graceEntered: false,
      }),
    ).toBe('sell_positive');
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(19),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(-2),
        graceEntered: true,
      }),
    ).toBe('sell_expired');
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(19),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(7),
        graceEntered: true,
      }),
    ).toBe('sell_expired');
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(30),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: null,
      }),
    ).toBe('sell_expired');
  });
  it('never sells positive without a fresh mark', () => {
    expect(
      timeExitDecision({
        openedAtIso: OPENED,
        nowMs: T(17),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: null,
      }),
    ).toBe('none');
  });
  it('ignores unparseable timestamps', () => {
    expect(
      timeExitDecision({
        openedAtIso: 'nope',
        nowMs: T(99),
        maxAgeHours: 16,
        graceHours: 3,
        unrealizedExclFeesUsdMicro: usdToMicro(1),
      }),
    ).toBe('none');
  });
});

describe('isIdleOver', () => {
  it('fires only after the idle limit', () => {
    const base = '2026-10-28T00:00:00.000Z';
    expect(
      isIdleOver({ baselineIso: base, nowMs: Date.parse(base) + 11.9 * 3_600_000, idleFireHours: 12 }),
    ).toBe(false);
    expect(
      isIdleOver({ baselineIso: base, nowMs: Date.parse(base) + 12 * 3_600_000, idleFireHours: 12 }),
    ).toBe(true);
    expect(isIdleOver({ baselineIso: 'garbage', nowMs: Date.now(), idleFireHours: 12 })).toBe(false);
  });
});

const OPEN = '2026-11-14T00:00:00.000Z';
const ENTRY = 100_000_000n;
const day = (hours: number, mark: bigint | null, extra: Record<string, unknown> = {}) =>
  dayTradeExitDecision({
    openedAtIso: OPEN,
    nowMs: Date.parse(OPEN) + hours * 3_600_000,
    maxAgeHours: 5,
    graceHours: 1.5,
    entryUsdMicro: ENTRY,
    markUsdMicro: mark,
    peakUsdMicro: mark,
    lowSinceMaxHoldUsdMicro: null,
    stopLossBps: 2500,
    trailArmBps: 1500,
    trailDistanceBps: 1000,
    partialTpBps: 4000,
    partialTaken: false,
    graceBounceBps: 800,
    sellOnGreen: true,
    ...extra,
  });

describe('day-trade exits', () => {
  it('sells the hard stop at −25% and not at −24%', () => {
    expect(day(1, 75_000_000n)).toBe('stop_loss');
    expect(day(1, 75_000_001n)).toBe('none');
  });

  it('arms the trail at +15% and sells 10% off the peak', () => {
    expect(day(1, 115_000_000n, { peakUsdMicro: 115_000_000n })).toBe('none');
    expect(day(1, 103_500_000n, { peakUsdMicro: 115_000_000n })).toBe('trailing_stop');
    expect(day(1, 103_500_001n, { peakUsdMicro: 115_000_000n })).toBe('none');
  });

  it('takes a partial at +40% before the trail is hit', () => {
    expect(day(1, 140_000_000n, { peakUsdMicro: 140_000_000n })).toBe('partial_take_profit');
    expect(day(1, 140_000_000n, { peakUsdMicro: 140_000_000n, partialTaken: true })).toBe('none');
    // Past the unconditional grace deadline the FULL exit wins, even above the
    // partial TP: a failed partial must not preempt the force-close forever.
    expect(day(6.5, 140_000_000n, { peakUsdMicro: 140_000_000n })).toBe('grace_expired');
  });

  it('sells on green at 5h, waits through red grace, and force-closes at 6.5h', () => {
    expect(day(4.9, 110_000_000n)).toBe('none');
    expect(day(5, 110_000_000n)).toBe('max_hold_green');
    expect(day(5.5, 90_000_000n)).toBe('none');
    expect(day(5.5, 101_000_000n)).toBe('grace_green');
    expect(day(6.5, null)).toBe('grace_expired');
    expect(day(6.5, 90_000_000n)).toBe('grace_expired');
  });

  it('sells an 8% bounce off the grace low while still red', () => {
    expect(day(5.5, 86_400_000n, { lowSinceMaxHoldUsdMicro: 80_000_000n })).toBe('grace_bounce');
    expect(day(5.5, 86_399_999n, { lowSinceMaxHoldUsdMicro: 80_000_000n })).toBe('none');
  });

  it('climbs the exit slippage ladder and stays on the last step', () => {
    const ladder = [300, 600, 1000];
    expect(exitSlippageBps(0, ladder)).toBe(300);
    expect(exitSlippageBps(1, ladder)).toBe(600);
    expect(exitSlippageBps(2, ladder)).toBe(1000);
    expect(exitSlippageBps(5, ladder)).toBe(1000);
  });
});

describe('unpriceable shadow ceiling', () => {
  const at = (hours: number, failure: 'no_route' | 'transient') =>
    unpriceableShadowExitDecision({
      openedAtIso: OPEN,
      nowMs: Date.parse(OPEN) + hours * 3_600_000,
      maxAgeHours: 5,
      graceHours: 1.5,
      failure,
    });

  it('never closes before the grace deadline, even on a confirmed no-route', () => {
    expect(at(6, 'no_route')).toBe('none');
    expect(at(6.49, 'no_route')).toBe('none');
  });

  it('closes a confirmed no-route at/after the grace deadline', () => {
    expect(at(6.5, 'no_route')).toBe('close_zero');
    expect(at(30, 'no_route')).toBe('close_zero');
  });

  it('waits through a transient failure until grace + 24h', () => {
    expect(at(6.5, 'transient')).toBe('none');
    expect(at(30.4, 'transient')).toBe('none');
    expect(at(30.5, 'transient')).toBe('close_zero');
  });

  it('ignores an unparseable opened-at timestamp', () => {
    expect(
      unpriceableShadowExitDecision({
        openedAtIso: 'garbage',
        nowMs: Date.now(),
        maxAgeHours: 5,
        graceHours: 1.5,
        failure: 'no_route',
      }),
    ).toBe('none');
  });
});
