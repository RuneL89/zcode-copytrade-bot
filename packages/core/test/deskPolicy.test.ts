import { describe, expect, it } from 'vitest';
import { applyExitAdjustment, validateHireDecision } from '../src/deskPolicy.js';
import { logsLookLikeSwap, parseLogsNotification } from '../src/swapPrograms.js';

const qualified = {
  decision: 'hire' as const,
  wallet: 'Wallet111',
  confidence: 0.8,
  reason: 'shadow net holds at the copy delay',
  hiresToday: 0,
  maxHiresPerDay: 3,
  codeQualified: true,
  blocked: false,
  markedAvoid: false,
};

describe('hire decisions', () => {
  it('accepts a qualified hire and a decline with a reason', () => {
    expect(validateHireDecision(qualified)).toEqual({ ok: true, decision: 'hire' });
    expect(validateHireDecision({ ...qualified, decision: 'decline', wallet: undefined }).ok).toBe(true);
  });

  it('refuses a missing reason, a fourth hire, an avoid, and an unqualified wallet', () => {
    expect(validateHireDecision({ ...qualified, reason: '  ' }).ok).toBe(false);
    expect(validateHireDecision({ ...qualified, confidence: 1.1 }).ok).toBe(false);
    expect(validateHireDecision({ ...qualified, hiresToday: 3 }).ok).toBe(false);
    expect(validateHireDecision({ ...qualified, hiresToday: 2 }).ok).toBe(true);
    expect(validateHireDecision({ ...qualified, markedAvoid: true }).ok).toBe(false);
    expect(validateHireDecision({ ...qualified, blocked: true }).ok).toBe(false);
    expect(validateHireDecision({ ...qualified, codeQualified: false }).ok).toBe(false);
    expect(validateHireDecision({ ...qualified, wallet: '' }).ok).toBe(false);
  });
});

describe('tighten-only exit plans', () => {
  const current = { stopLossBps: 2500, trailDistanceBps: 1000, maxHoldHours: 5 };

  it('accepts a tighter stop, trail, or hold, and an immediate exit', () => {
    expect(applyExitAdjustment(current, { stopLossBps: 2000, reason: 'thin book' })).toMatchObject({
      ok: true,
      plan: { stopLossBps: 2000, trailDistanceBps: 1000, maxHoldHours: 5 },
    });
    expect(applyExitAdjustment(current, { trailDistanceBps: 800, reason: 'fast name' }).ok).toBe(true);
    expect(applyExitAdjustment(current, { maxHoldHours: 4, reason: 'into the close' }).ok).toBe(true);
    expect(applyExitAdjustment(current, { exitNow: true, reason: 'leader moved size' })).toMatchObject({
      ok: true,
      exitNow: true,
    });
  });

  it('rejects any loosen, including when another field tightens', () => {
    expect(applyExitAdjustment(current, { stopLossBps: 3000, reason: 'give it room' })).toMatchObject({
      ok: false,
      reason: 'stop would loosen',
    });
    expect(applyExitAdjustment(current, { trailDistanceBps: 1500, reason: 'wider' }).ok).toBe(false);
    expect(applyExitAdjustment(current, { maxHoldHours: 6, reason: 'longer' }).ok).toBe(false);
    expect(
      applyExitAdjustment(current, { stopLossBps: 2000, maxHoldHours: 6, reason: 'mixed' }),
    ).toMatchObject({ ok: false, reason: 'hold would lengthen' });
    expect(applyExitAdjustment(current, { reason: 'same plan' }).ok).toBe(false);
  });
});

describe('swap log filter', () => {
  it('fetches a Jupiter log and ignores a plain transfer', () => {
    expect(logsLookLikeSwap(['Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]'])).toBe(true);
    expect(logsLookLikeSwap(['Program 11111111111111111111111111111111 invoke [1]'])).toBe(false);
  });

  it('parses a logs notification and drops anything else', () => {
    expect(
      parseLogsNotification({
        method: 'logsNotification',
        params: { result: { value: { signature: 'sig', err: null, logs: ['a'] } } },
      }),
    ).toEqual({ signature: 'sig', err: false, logs: ['a'] });
    expect(parseLogsNotification({ method: 'slotNotification' })).toBeNull();
  });
});
