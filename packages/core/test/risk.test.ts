import { describe, expect, it } from 'vitest';
import { usdToMicro } from '../src/money.js';
import { capitalPctCapUsdMicro } from '../src/risk.js';

const cap = (capitalUsd: number, pct: number, floorUsd: number) =>
  capitalPctCapUsdMicro(usdToMicro(capitalUsd), pct, usdToMicro(floorUsd));

describe('capitalPctCapUsdMicro', () => {
  it('scales the ceiling with current capital', () => {
    expect(cap(100, 10, 2)).toBe(usdToMicro(10));
    expect(cap(200, 10, 2)).toBe(usdToMicro(20));
    expect(cap(10_000, 10, 2)).toBe(usdToMicro(1_000));
    expect(cap(100, 35, 2)).toBe(usdToMicro(35));
    expect(cap(200, 35, 2)).toBe(usdToMicro(70));
    expect(cap(10_000, 35, 2)).toBe(usdToMicro(3_500));
  });

  it('never falls below the absolute floor', () => {
    expect(cap(10, 10, 2)).toBe(usdToMicro(2));
    expect(cap(0, 35, 2)).toBe(usdToMicro(2));
  });

  it('uses integer percent math', () => {
    expect(cap(33, 10, 0)).toBe(usdToMicro(3.3));
  });
});
