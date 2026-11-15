import { describe, expect, it } from 'vitest';
import { computeCopyNotional, capToHeadroom, sizeCopy } from '../src/sizing.js';
import { bankrollHeadroom } from '../src/risk.js';
import { usdToMicro, formatMicroUsd, ratioBps, applyBpsToBase, splitMicroUsd } from '../src/money.js';
import { leaderSoldFraction, planCopiedExit, FULL_EXIT_DUST_BPS } from '../src/exits.js';
import { applyCloseUnit, countsAsUnit } from '../src/streak.js';
import type { StreakConfig } from '../src/streak.js';

const Q = { scaleNumerator: 1n, scaleDenominator: 4n };
/** D1 production shape: 0.25x, floored at $5, capped at $10. */
const FLOOR = { minPerBuyUsdMicro: usdToMicro(5), maxPerBuyUsdMicro: usdToMicro(10) };
const copyOf = (leaderUsd: number) =>
  computeCopyNotional({ leaderInputUsdMicro: usdToMicro(leaderUsd), ...Q, ...FLOOR });

describe('0.25x sizing with an absolute floor (D1)', () => {
  it('computes exactly one quarter of leader input between floor and cap', () => {
    const r = copyOf(21);
    expect(r.action).toBe('copy');
    expect(r.desiredUsdMicro).toBe(usdToMicro(5.25));
    expect(r.finalUsdMicro).toBe(usdToMicro(5.25));
    expect(r.applied).toBe('none');
  });

  it('a $4.00 leader buy copies at the $5.00 floor, not a skip (AC1)', () => {
    const r = copyOf(4);
    expect(r.action).toBe('copy');
    expect(r.desiredUsdMicro).toBe(usdToMicro(1));
    expect(r.finalUsdMicro).toBe(5_000_000n);
    expect(r.applied).toBe('rounded_up_to_min');
  });

  it('$7.86 and $19.99 both copy at the $5.00 floor (AC2)', () => {
    for (const leaderUsd of [7.86, 19.99]) {
      const r = copyOf(leaderUsd);
      expect(r.action).toBe('copy');
      expect(r.finalUsdMicro).toBe(usdToMicro(5));
    }
  });

  it('floor, interior and ceiling values (AC3)', () => {
    expect(copyOf(20).finalUsdMicro).toBe(usdToMicro(5)); // exactly the floor
    expect(copyOf(21).finalUsdMicro).toBe(usdToMicro(5.25));
    // $40.00 x 0.25 is exactly the $10 cap: the value already equals the
    // maximum, so no cap has to be applied and `applied` stays 'none'.
    expect(copyOf(40).finalUsdMicro).toBe(usdToMicro(10));
    const big = copyOf(100);
    expect(big.finalUsdMicro).toBe(usdToMicro(10));
    expect(big.applied).toBe('capped_at_max');
  });

  it('zero and negative leader inputs are invalid (AC4)', () => {
    for (const leaderUsd of [0, -5]) {
      const r = copyOf(leaderUsd);
      expect(r.action).toBe('skip_invalid');
      expect(r.finalUsdMicro).toBeNull();
      expect(r.applied).toBe('invalid_input');
    }
  });

  it('a non-positive scale is invalid', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: usdToMicro(100),
      scaleNumerator: 0n,
      scaleDenominator: 4n,
      ...FLOOR,
    });
    expect(r.action).toBe('skip_invalid');
  });

  it('never skips a below-floor copy across a wide sweep (AC5)', () => {
    for (let cents = 0; cents <= 2000; cents++) {
      const r = copyOf(cents / 100);
      expect(['copy', 'skip_invalid']).toContain(r.action);
      if (r.action === 'copy') {
        expect(r.finalUsdMicro!).toBeGreaterThanOrEqual(FLOOR.minPerBuyUsdMicro);
        expect(r.finalUsdMicro!).toBeLessThanOrEqual(FLOOR.maxPerBuyUsdMicro);
      }
    }
  });

  it('floors fractional micros deterministically', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: 1_000_003n,
      ...Q,
      minPerBuyUsdMicro: 0n,
      maxPerBuyUsdMicro: usdToMicro(250),
    });
    expect(r.finalUsdMicro).toBe(250_000n); // floor(1000003/4)
  });

  it('caps at MAX_PER_BUY_USD', () => {
    const r = computeCopyNotional({
      leaderInputUsdMicro: usdToMicro(2000),
      ...Q,
      minPerBuyUsdMicro: usdToMicro(10),
      maxPerBuyUsdMicro: usdToMicro(250),
    });
    expect(r.action).toBe('copy');
    expect(r.finalUsdMicro).toBe(usdToMicro(250));
    expect(r.applied).toBe('capped_at_max');
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

const PAPER = {
  scaleNumerator: 1n,
  scaleDenominator: 4n,
  minPerBuyUsdMicro: usdToMicro(2),
  maxPerBuyUsdMicro: usdToMicro(10),
  traderOpenUsdMicro: 0n,
  maxOpenPerTraderUsdMicro: usdToMicro(40),
  bankrollHeadroomUsdMicro: usdToMicro(80),
};

describe('paper sizing bounds ($2 floor, $10/trade, $40/trader, $80 deployed)', () => {
  it('caps one trade at $10 and floors a small scale at $2', () => {
    const capped = sizeCopy({ ...PAPER, leaderInputUsdMicro: usdToMicro(80) });
    expect(capped).toMatchObject({ action: 'copy', finalUsdMicro: usdToMicro(10), limitedBy: 'per_trade' });
    const exact = sizeCopy({ ...PAPER, leaderInputUsdMicro: usdToMicro(40) });
    expect(exact).toMatchObject({ action: 'copy', finalUsdMicro: usdToMicro(10), limitedBy: 'none' });
    const floored = sizeCopy({ ...PAPER, leaderInputUsdMicro: usdToMicro(4) });
    expect(floored).toMatchObject({ action: 'copy', finalUsdMicro: usdToMicro(2), limitedBy: 'floor' });
  });

  it('stops at the trader open cap and skips under a $2 remainder', () => {
    const room = sizeCopy({
      ...PAPER,
      leaderInputUsdMicro: usdToMicro(80),
      traderOpenUsdMicro: usdToMicro(32),
    });
    expect(room).toMatchObject({ action: 'copy', finalUsdMicro: usdToMicro(8), limitedBy: 'per_trader' });
    const exactFloor = sizeCopy({
      ...PAPER,
      leaderInputUsdMicro: usdToMicro(80),
      traderOpenUsdMicro: usdToMicro(38),
    });
    expect(exactFloor).toMatchObject({
      action: 'copy',
      finalUsdMicro: usdToMicro(2),
      limitedBy: 'per_trader',
    });
    const skip = sizeCopy({
      ...PAPER,
      leaderInputUsdMicro: usdToMicro(80),
      traderOpenUsdMicro: usdToMicro(39),
    });
    expect(skip).toMatchObject({ action: 'skip_headroom', rule: 'MAX_OPEN_PER_TRADER_USD' });
    const full = sizeCopy({
      ...PAPER,
      leaderInputUsdMicro: usdToMicro(80),
      traderOpenUsdMicro: usdToMicro(40),
    });
    expect(full.action).toBe('skip_headroom');
  });

  it('caps five seats at 80% of a $100 bankroll even though 5 x $40 is $200', () => {
    const bank = bankrollHeadroom({
      equityStartUsdMicro: usdToMicro(100),
      openEntriesUsdMicro: usdToMicro(78),
      openFeesUsdMicro: 0n,
      realizedNetUsdMicro: 0n,
      maxDeployedPct: 80,
    });
    expect(bank.headroomUsdMicro).toBe(usdToMicro(2));
    const fit = sizeCopy({
      ...PAPER,
      leaderInputUsdMicro: usdToMicro(80),
      traderOpenUsdMicro: 0n,
      bankrollHeadroomUsdMicro: bank.headroomUsdMicro,
    });
    expect(fit).toMatchObject({ action: 'copy', finalUsdMicro: usdToMicro(2), limitedBy: 'bankroll' });

    const full = bankrollHeadroom({
      equityStartUsdMicro: usdToMicro(100),
      openEntriesUsdMicro: usdToMicro(80),
      openFeesUsdMicro: 0n,
      realizedNetUsdMicro: 0n,
      maxDeployedPct: 80,
    });
    expect(full.headroomUsdMicro).toBe(0n);
    const skipped = sizeCopy({
      ...PAPER,
      leaderInputUsdMicro: usdToMicro(80),
      bankrollHeadroomUsdMicro: full.headroomUsdMicro,
    });
    expect(skipped).toMatchObject({ action: 'skip_headroom', rule: 'MAX_DEPLOYED_PCT' });

    const oneUnder = sizeCopy({
      ...PAPER,
      leaderInputUsdMicro: usdToMicro(80),
      bankrollHeadroomUsdMicro: usdToMicro(1),
    });
    expect(oneUnder.action).toBe('skip_headroom');
  });
});
