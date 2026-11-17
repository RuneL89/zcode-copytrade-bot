import { describe, expect, it } from 'vitest';
import { riskPatchDirection } from '../src/riskDirection.js';

const current = {
  MIN_PER_BUY_USD: 2,
  MAX_PER_BUY_USD: 10,
  SELL_ON_GREEN: true,
};

describe('risk patch direction', () => {
  it('treats a higher ceiling or a lower floor as an increase', () => {
    expect(riskPatchDirection(current, { MAX_PER_BUY_USD: 10 })).toBe('neutral');
    expect(riskPatchDirection(current, { MAX_PER_BUY_USD: 11 })).toBe('increase');
    expect(riskPatchDirection(current, { MAX_PER_BUY_USD: 9 })).toBe('decrease');
    expect(riskPatchDirection(current, { MIN_PER_BUY_USD: 1 })).toBe('increase');
    expect(riskPatchDirection(current, { MIN_PER_BUY_USD: 3 })).toBe('decrease');
    expect(riskPatchDirection(current, { SELL_ON_GREEN: false })).toBe('increase');
  });
});
