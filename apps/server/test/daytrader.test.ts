import { describe, expect, it } from 'vitest';
import { evaluateActivityGate, isLeaderStalled } from '../src/services/lifecycle.js';

const cfg = { maxStallHours: 20, minSwaps24h: 5 };

describe('activity gate (pre-hire)', () => {
  it('passes a recently active, frequently trading wallet', () => {
    expect(evaluateActivityGate({ lastSwapAgeHours: 2, swaps24h: 49 }, cfg)).toEqual({ ok: true });
  });

  it('rejects a stalled wallet', () => {
    const r = evaluateActivityGate({ lastSwapAgeHours: 26, swaps24h: 40 }, cfg);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('LEADER_STALLED');
  });

  it('rejects a quiet wallet even when fresh', () => {
    const r = evaluateActivityGate({ lastSwapAgeHours: 3, swaps24h: 1 }, cfg);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('LOW_ACTIVITY');
  });

  it('rejects unknown activity (no data is not a pass)', () => {
    expect(evaluateActivityGate(null, cfg).reason).toBe('LEADER_STALLED');
    expect(evaluateActivityGate({ lastSwapAgeHours: null, swaps24h: 0 }, cfg).reason).toBe('LEADER_STALLED');
  });

  it('treats the thresholds as inclusive', () => {
    expect(evaluateActivityGate({ lastSwapAgeHours: 20, swaps24h: 5 }, cfg).ok).toBe(true);
  });
});

describe('stall watcher threshold', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it('stalls exactly at the limit and beyond', () => {
    expect(isLeaderStalled(now / 1000 - 20 * 3600, now, 20)).toBe(true);
    expect(isLeaderStalled(now / 1000 - 19.9 * 3600, now, 20)).toBe(false);
  });

  it('never stalls an unknown cursor', () => {
    expect(isLeaderStalled(null, now, 20)).toBe(false);
  });
});
