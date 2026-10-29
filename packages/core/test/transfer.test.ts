import { describe, expect, it } from 'vitest';
import {
  formatBaseAmount,
  parseAmountToBase,
  planWithdrawal,
  SOL_FEE_RESERVE_LAMPORTS,
  withdrawableBase,
} from '../src/transfer.js';

describe('parseAmountToBase', () => {
  it('parses plain decimals at the asset precision', () => {
    expect(parseAmountToBase('12.5', 6)).toEqual({ ok: true, base: 12_500_000n });
    expect(parseAmountToBase('1', 9)).toEqual({ ok: true, base: 1_000_000_000n });
    expect(parseAmountToBase('0.005', 9)).toEqual({ ok: true, base: 5_000_000n });
    expect(parseAmountToBase(' 120 ', 6)).toEqual({ ok: true, base: 120_000_000n });
  });
  it('rejects non-positive or malformed input', () => {
    for (const bad of ['', '   ', '0', '0.0', '-5', '1e6', '1,5', 'abc', '.5', '5.']) {
      expect(parseAmountToBase(bad, 6).ok).toBe(false);
    }
  });
  it('rejects surplus decimal places instead of truncating money away', () => {
    expect(parseAmountToBase('0.1234567', 6).ok).toBe(false);
    expect(parseAmountToBase('0.123456', 6).ok).toBe(true);
  });
});

describe('withdrawableBase', () => {
  it('caps USDC at the free bankroll when cash is lower than the on-chain balance', () => {
    // $120 on chain, $20 tied up in open positions -> $100 withdrawable.
    expect(
      withdrawableBase({
        asset: 'USDC',
        onchainBase: 120_000_000n,
        cashUsdMicro: 100_000_000n,
      }),
    ).toBe(100_000_000n);
  });
  it('caps USDC at the on-chain balance when it is lower than cash', () => {
    expect(withdrawableBase({ asset: 'USDC', onchainBase: 40_000_000n, cashUsdMicro: 100_000_000n })).toBe(
      40_000_000n,
    );
  });
  it('never withdraws against negative or zero cash', () => {
    expect(withdrawableBase({ asset: 'USDC', onchainBase: 50_000_000n, cashUsdMicro: -5_000_000n })).toBe(0n);
  });
  it('keeps the SOL fee reserve', () => {
    expect(withdrawableBase({ asset: 'SOL', onchainBase: 50_000_000n, cashUsdMicro: 0n })).toBe(
      50_000_000n - SOL_FEE_RESERVE_LAMPORTS,
    );
    expect(withdrawableBase({ asset: 'SOL', onchainBase: 3_000_000n, cashUsdMicro: 0n })).toBe(0n);
  });
});

describe('planWithdrawal', () => {
  const base = {
    asset: 'USDC' as const,
    amountBase: 50_000_000n,
    withdrawableBase: 100_000_000n,
    destinationValid: true,
    destinationIsSelf: false,
  };
  it('allows a valid withdrawal', () => {
    expect(planWithdrawal(base)).toEqual({ ok: true });
  });
  it('rejects an invalid destination', () => {
    expect(planWithdrawal({ ...base, destinationValid: false }).code).toBe('DESTINATION_INVALID');
  });
  it('rejects sending to ourselves', () => {
    expect(planWithdrawal({ ...base, destinationIsSelf: true }).code).toBe('DESTINATION_IS_SELF');
  });
  it('rejects non-positive amounts and amounts above the cap', () => {
    expect(planWithdrawal({ ...base, amountBase: 0n }).code).toBe('AMOUNT_INVALID');
    expect(planWithdrawal({ ...base, amountBase: 100_000_001n }).code).toBe('INSUFFICIENT_AVAILABLE');
  });
  it('explains that position funds are not withdrawable', () => {
    const r = planWithdrawal({ ...base, amountBase: 100_000_001n });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('open positions');
  });
});

describe('formatBaseAmount', () => {
  it('round-trips the parser', () => {
    const parsed = parseAmountToBase('12.345678', 6);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(formatBaseAmount(parsed.base, 6)).toBe('12.345678');
    expect(formatBaseAmount(5_000_000n, 9)).toBe('0.005');
    expect(formatBaseAmount(1_000_000_000n, 9)).toBe('1');
  });
});
