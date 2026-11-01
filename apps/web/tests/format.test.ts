import { describe, expect, it } from 'vitest';
import { clockFromSeconds, dirPair, signedUsd, splitEquity, usd } from '../src/types';

describe('dashboard money formatting', () => {
  it('formats micro-USD without float drift', () => {
    expect(usd('1234567')).toBe('1.23');
    expect(usd('4939000000')).toBe('4,939.00');
    expect(usd('-500000')).toBe('-0.50');
    expect(usd(null)).toBe('—');
  });

  it('signs changes', () => {
    expect(signedUsd('12000000')).toBe('+12.00');
    expect(signedUsd('-3210000')).toBe('-3.21');
  });

  it('splits the equity hero into whole + faded decimals', () => {
    expect(splitEquity('4939000000')).toEqual({ sign: '', whole: '4,939', decimals: '00' });
    expect(splitEquity('52000000')).toEqual({ sign: '', whole: '52', decimals: '00' });
    expect(splitEquity('-1250000')).toEqual({ sign: '-', whole: '1', decimals: '25' });
  });

  it('renders the 24h session clock', () => {
    expect(clockFromSeconds(0)).toBe('00:00:00');
    expect(clockFromSeconds(3661)).toBe('01:01:01');
    expect(clockFromSeconds(24 * 3600 - 1)).toBe('23:59:59');
  });

  it('renders the on-chain direction pair with explicit unknowns', () => {
    expect(dirPair(6, 3)).toBe('6b · 3s');
    expect(dirPair(0, 0)).toBe('0b · 0s');
    expect(dirPair(6, null)).toBe('6b · ?s');
    expect(dirPair(null, null)).toBe('—');
  });
});
