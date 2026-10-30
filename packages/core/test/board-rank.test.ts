import { describe, expect, it } from 'vitest';
import { evaluateRankStability, type BoardScan } from '../src/boardRank.js';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const SCAN_FRESH_MS = 2 * 60 * 60 * 1000;

const scan = (observedAt: string, ranks: Record<string, number>): BoardScan => ({
  observedAt,
  ranks: new Map(Object.entries(ranks)),
});

const RULE = { nowMs: NOW, scanFreshMs: SCAN_FRESH_MS, topN: 3 };

describe('evaluateRankStability', () => {
  it('fires on a single absence from the latest scan', () => {
    const verdict = evaluateRankStability({
      ...RULE,
      scans: [scan('2026-10-30T11:30:00Z', { other: 1 })],
      incumbentHandle: 'whale',
    });
    expect(verdict.action).toBe('fire');
    expect(verdict.strikes).toBe(1);
    expect(verdict.latestRank).toBeNull();
    if (verdict.action === 'fire') expect(verdict.reason).toContain('left the board');
  });

  it('fires after two consecutive scans outside the top-3', () => {
    const verdict = evaluateRankStability({
      ...RULE,
      scans: [
        scan('2026-10-30T11:30:00Z', { whale: 5, other: 1 }),
        scan('2026-10-30T11:00:00Z', { whale: 4, other: 2 }),
      ],
      incumbentHandle: 'whale',
    });
    expect(verdict.action).toBe('fire');
    expect(verdict.strikes).toBe(2);
    if (verdict.action === 'fire') expect(verdict.reason).toContain('outside top-3 in 2 consecutive scans');
  });

  it('treats absence in the previous scan as a strike when the latest scan ranks 4+', () => {
    const verdict = evaluateRankStability({
      ...RULE,
      scans: [
        scan('2026-10-30T11:30:00Z', { whale: 6, other: 1 }),
        scan('2026-10-30T11:00:00Z', { other: 2 }),
      ],
      incumbentHandle: 'whale',
    });
    expect(verdict.action).toBe('fire');
    expect(verdict.strikes).toBe(2);
  });

  it('holds with one strike when the previous scan had the incumbent in the top-3', () => {
    const verdict = evaluateRankStability({
      ...RULE,
      scans: [
        scan('2026-10-30T11:30:00Z', { whale: 4, other: 1 }),
        scan('2026-10-30T11:00:00Z', { whale: 2, other: 3 }),
      ],
      incumbentHandle: 'whale',
    });
    expect(verdict.action).toBe('none');
    expect(verdict.strikes).toBe(1);
  });

  it('holds while the incumbent sits in the top-3 (ties count by displayed rank)', () => {
    const verdict = evaluateRankStability({
      ...RULE,
      scans: [scan('2026-10-30T11:30:00Z', { a: 1, b: 2, whale: 3 })],
      incumbentHandle: 'whale',
    });
    expect(verdict.action).toBe('none');
    expect(verdict.strikes).toBe(0);
    expect(verdict.latestRank).toBe(3);
  });

  it('stands down when the latest scan is older than the freshness window', () => {
    const verdict = evaluateRankStability({
      ...RULE,
      scans: [
        scan('2026-10-30T09:00:00Z', { other: 1 }), // 3h old at NOW: stale
        scan('2026-10-30T08:30:00Z', { other: 2 }),
      ],
      incumbentHandle: 'whale',
    });
    expect(verdict.action).toBe('stand_down');
    if (verdict.action === 'stand_down') expect(verdict.detail).toContain('freshness');
  });

  it('stands down with no scans or an unknown incumbent handle', () => {
    expect(evaluateRankStability({ ...RULE, scans: [], incumbentHandle: 'whale' }).action).toBe('stand_down');
    expect(
      evaluateRankStability({
        ...RULE,
        scans: [scan('2026-10-30T11:30:00Z', { whale: 7 })],
        incumbentHandle: null,
      }).action,
    ).toBe('stand_down');
  });
});
