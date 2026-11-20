import { describe, expect, it } from 'vitest';
import { computeDiscoveryPacing, msLeftInCycle } from '../src/discoveryBudget.js';

/** 2026-11-20 12:00 UTC: 10.5 days left before the Dec 1 reset. */
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAY = 86_400_000;
const CONFIGURED = 1_800_000; // 30 min — the fastest the desk may run

const pace = (over: Partial<Parameters<typeof computeDiscoveryPacing>[0]> = {}) =>
  computeDiscoveryPacing({
    creditsRemaining: 250_000,
    planCredits: 250_000,
    costPerRun: 875,
    configuredMinIntervalMs: CONFIGURED,
    nowMs: NOW,
    ...over,
  });

describe('msLeftInCycle', () => {
  it('measures the fraction of the month left, UTC', () => {
    expect(msLeftInCycle(NOW)).toBe(10.5 * DAY);
    expect(msLeftInCycle(Date.UTC(2026, 11, 1, 0, 0, 0))).toBe(31 * DAY); // rolls forward
    expect(msLeftInCycle(Date.UTC(2026, 10, 30, 23, 59, 0))).toBe(60_000);
  });
});

describe('computeDiscoveryPacing', () => {
  it('paces a full plan evenly across the month', () => {
    const p = pace();
    // 250k × 95% / 10.5 days / 875 ≈ 25.9 runs/day → ~56 min interval.
    expect(p.allowedRunsPerDay).toBeCloseTo(25.85, 1);
    expect(p.effectiveIntervalMs).toBeCloseTo((DAY * 10.5 * 875) / (250_000 * 0.95), 0);
    expect(p.basis).toBe('measured');
    expect(p.daysLeftInCycle).toBe(10.5);
  });

  it('the configured interval is the floor (as fast as possible)', () => {
    // A huge balance mid-month paces slower than 30 min? No: even a full plan
    // paces ~58 min > 30 min floor. Force a case where the math is faster:
    const p = pace({ creditsRemaining: 250_000, nowMs: Date.UTC(2026, 10, 30, 12) });
    // 1.5 days left: 250k × 95% / 1.5 / 875 ≈ 181 runs/day → 8 min < floor.
    expect(p.allowedRunsPerDay).toBeGreaterThan(48);
    expect(p.effectiveIntervalMs).toBe(CONFIGURED);
  });

  it('slows down as the balance drains', () => {
    const p = pace({ creditsRemaining: 30_375 });
    // 30,375 × 95% / 10.5 / 875 ≈ 3.1 runs/day → ~7.7h.
    expect(p.allowedRunsPerDay).toBeCloseTo(3.14, 1);
    expect(p.effectiveIntervalMs).toBeGreaterThan(7 * 3_600_000);
    expect(p.effectiveIntervalMs).toBeLessThanOrEqual(8 * 3_600_000);
  });

  it('clamps a drained balance at the daily-probe ceiling', () => {
    const p = pace({ creditsRemaining: 900 });
    // 900 × 95% / 10.5 / 875 ≈ 0.09 runs/day → ~11 days > 24h ceiling.
    expect(p.effectiveIntervalMs).toBe(24 * 3_600_000);
    expect(p.allowedRunsPerDay).toBeLessThan(1);
  });

  it('without a measured balance, paces the plan default', () => {
    const p = pace({ creditsRemaining: null });
    expect(p.basis).toBe('plan-default');
    expect(p.allowedRunsPerDay).toBeCloseTo(25.85, 1);
  });

  it('tolerates a zero or negative remainder without dividing by zero', () => {
    const p = pace({ creditsRemaining: 0 });
    expect(p.basis).toBe('plan-default');
    expect(p.effectiveIntervalMs).toBeGreaterThan(0);
    const n = pace({ creditsRemaining: -5, costPerRun: 0 });
    expect(n.effectiveIntervalMs).toBeGreaterThan(0);
  });

  it('accelerates toward month-end so the budget is spent, not hoarded', () => {
    const early = pace({ creditsRemaining: 125_000 });
    const late = pace({ creditsRemaining: 125_000, nowMs: Date.UTC(2026, 10, 28, 12) });
    expect(late.effectiveIntervalMs).toBeLessThan(early.effectiveIntervalMs);
  });
});
