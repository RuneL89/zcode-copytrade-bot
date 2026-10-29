import { describe, expect, it } from 'vitest';
import { computeCopyNotional, capToHeadroom } from '../src/sizing.js';
import { usdToMicro, formatMicroUsd, ratioBps, applyBpsToBase, splitMicroUsd } from '../src/money.js';
import { leaderSoldFraction, planCopiedExit, FULL_EXIT_DUST_BPS } from '../src/exits.js';
import { applyCloseUnit, countsAsUnit } from '../src/streak.js';
import type { StreakConfig } from '../src/streak.js';

const Q = { scaleNumerator: 1n, scaleDenominator: 4n };

describe('0.25x sizing', () => {
  it('computes exactly one quarter of leader input', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: usdToMicro(400),
      ...Q,
      minPerBuyUsdMicro: usdToMicro(10),
      maxPerBuyUsdMicro: usdToMicro(250),
      allowBelowMinRoundUp: false,
    });
    expect(r.action).toBe('copy');
    expect(r.finalUsdMicro).toBe(usdToMicro(100));
  });

  it('floors fractional micros deterministically', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: 1_000_003n,
      ...Q,
      minPerBuyUsdMicro: 0n,
      maxPerBuyUsdMicro: usdToMicro(250),
      allowBelowMinRoundUp: false,
    });
    expect(r.finalUsdMicro).toBe(250_000n); // floor(1000003/4)
  });

  it('caps at MAX_PER_BUY_USD', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: usdToMicro(2000),
      ...Q,
      minPerBuyUsdMicro: usdToMicro(10),
      maxPerBuyUsdMicro: usdToMicro(250),
      allowBelowMinRoundUp: false,
    });
    expect(r.action).toBe('copy');
    expect(r.finalUsdMicro).toBe(usdToMicro(250));
    expect(r.applied).toBe('capped_at_max');
  });

  it('skips below MIN_PER_BUY_USD without rounding up (default)', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: usdToMicro(32),
      ...Q,
      minPerBuyUsdMicro: usdToMicro(10),
      maxPerBuyUsdMicro: usdToMicro(250),
      allowBelowMinRoundUp: false,
    });
    expect(r.action).toBe('skip_below_min');
    expect(r.finalUsdMicro).toBeNull();
    expect(r.desiredUsdMicro).toBe(usdToMicro(8));
  });

  it('rounds up to min only when explicitly allowed', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: usdToMicro(32),
      ...Q,
      minPerBuyUsdMicro: usdToMicro(10),
      maxPerBuyUsdMicro: usdToMicro(250),
      allowBelowMinRoundUp: true,
    });
    expect(r.action).toBe('copy');
    expect(r.finalUsdMicro).toBe(usdToMicro(10));
    expect(r.applied).toBe('rounded_up_to_min');
  });

  it('rejects non-positive leader input', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: 0n,
      ...Q,
      minPerBuyUsdMicro: 10n,
      maxPerBuyUsdMicro: 250_000_000n,
      allowBelowMinRoundUp: false,
    });
    expect(r.action).toBe('skip_invalid');
  });
});

describe('money helpers', () => {
  it('formats micro-USD', () => {
    expect(formatMicroUsd(1_234_567n)).toBe('1.23');
    expect(formatMicroUsd(-500_000n)).toBe('-0.50');
  });
  it('splits equity hero parts', () => {
    expect(splitMicroUsd(4_939_000_000n)).toEqual({ sign: '', whole: '4939', decimals: '00' });
  });
  it('ratioBps floors and rejects bad denominators', () => {
    expect(ratioBps(1n, 3n)).toBe(3333);
    expect(() => ratioBps(1n, 0n)).toThrow();
  });
  it('applyBpsToBase floors', () => {
    expect(applyBpsToBase(1000n, 3333)).toBe(333n);
  });
});

describe('proportional exits', () => {
  it('derives sold fraction from verified balances', () => {
    expect(leaderSoldFraction({ preBase: 1000n, postBase: 400n })).toEqual({ soldBps: 6000, full: false });
  });
  it('treats near-zero residue as full exit', () => {
    const dust = (1000n * FULL_EXIT_DUST_BPS) / 10000n;
    expect(leaderSoldFraction({ preBase: 1000n, postBase: dust })).toEqual({ soldBps: 10000, full: true });
    expect(leaderSoldFraction({ preBase: 1000n, postBase: 0n }).full).toBe(true);
  });
  it('refuses balance growth as a sell', () => {
    expect(() => leaderSoldFraction({ preBase: 100n, postBase: 200n })).toThrow();
  });

  it('mirrors a partial exit and never oversells', () => {
    const plan = planCopiedExit({ remainingBase: 1000n, soldBps: 6000, full: false });
    expect(plan.exitBase).toBe(600n);
    expect(plan.remainingBase).toBe(400n);
  });
  it('repeated partial exits sum without inventing fills', () => {
    let remaining = 1000n;
    const seq = [
      { soldBps: 5000, full: false },
      { soldBps: 5000, full: false },
      { soldBps: 5000, full: false },
    ];
    let sold = 0n;
    for (const s of seq) {
      const plan = planCopiedExit({ remainingBase: remaining, ...s });
      sold += plan.exitBase;
      remaining = plan.remainingBase;
    }
    // never oversells and never invents residual fills: 500+250+125 sold, 125 left
    expect(sold).toBe(875n);
    expect(remaining).toBe(125n);
    // the leader's full exit then closes the tracked remainder exactly
    const last = planCopiedExit({ remainingBase: remaining, soldBps: 10000, full: true });
    expect(last).toEqual({ exitBase: 125n, remainingBase: 0n, full: true });
  });
  it('a full leader exit closes the whole remaining copied position', () => {
    const plan = planCopiedExit({ remainingBase: 400n, soldBps: 9000, full: true });
    expect(plan).toEqual({ exitBase: 400n, remainingBase: 0n, full: true });
  });
});

describe('loss streak', () => {
  const config: StreakConfig = { unit: 'fully_closed_position', fireAfter: 2, breakevenResets: false };

  it('two consecutive losses fire; a win resets', () => {
    expect(applyCloseUnit(0, -1n, config)).toMatchObject({ streak: 1, fired: false });
    expect(applyCloseUnit(1, -1n, config)).toMatchObject({ streak: 2, fired: true });
    expect(applyCloseUnit(1, 5n, config)).toMatchObject({ streak: 0, fired: false });
    expect(applyCloseUnit(1, 5n, config)).toMatchObject({ unitResult: 'win' });
  });
  it('breakeven does not count or reset by default', () => {
    expect(applyCloseUnit(1, 0n, config)).toEqual({ streak: 1, unitResult: 'breakeven', fired: false });
  });
  it('breakeven resets when explicitly configured', () => {
    expect(applyCloseUnit(1, 0n, { ...config, breakevenResets: true })).toMatchObject({ streak: 0 });
  });
  it('unit gating: partial closes only count under every_partial_close', () => {
    expect(countsAsUnit('partial_close', { ...config, unit: 'fully_closed_position' })).toBe(false);
    expect(countsAsUnit('partial_close', { ...config, unit: 'every_partial_close' })).toBe(true);
    expect(countsAsUnit('position_closed', { ...config, unit: 'fully_closed_position' })).toBe(true);
  });
});

describe('capToHeadroom (bankroll downsize-to-fit)', () => {
  it('passes through when the notional fits', () => {
    expect(capToHeadroom(usdToMicro(10), usdToMicro(20), usdToMicro(5))).toEqual({
      action: 'copy',
      finalUsdMicro: usdToMicro(10),
      downsized: false,
    });
  });
  it('downsizes to the headroom when it still covers the minimum', () => {
    expect(capToHeadroom(usdToMicro(10), usdToMicro(7), usdToMicro(5))).toEqual({
      action: 'copy',
      finalUsdMicro: usdToMicro(7),
      downsized: true,
    });
  });
  it('skips when the headroom is below the per-bet minimum', () => {
    expect(capToHeadroom(usdToMicro(10), usdToMicro(4.5), usdToMicro(5))).toEqual({
      action: 'skip_headroom',
      headroomUsdMicro: usdToMicro(4.5),
    });
  });
  it('skips when there is no headroom at all', () => {
    expect(capToHeadroom(usdToMicro(10), 0n, usdToMicro(5)).action).toBe('skip_headroom');
  });
});
