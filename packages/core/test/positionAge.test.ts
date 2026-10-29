import { describe, expect, it } from 'vitest';
import { timeExitDecision, isIdleOver } from '../src/positionAge.js';
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
