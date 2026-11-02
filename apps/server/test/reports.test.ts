import { describe, expect, it } from 'vitest';
import {
  dailyReportText,
  formatMicroUsd,
  msUntilNextLocalTime,
  selectAnomalies,
  type AuditLike,
} from '../src/services/reports.js';

const row = (id: number, category: string, message: string): AuditLike => ({
  id,
  category,
  message,
  created_at: '2026-10-27T00:00:00Z',
});

describe('anomaly selection', () => {
  const rows: AuditLike[] = [
    row(1, 'system', 'runtime starting (mode=paper)'), // not an anomaly category
    row(2, 'recommendation', 'recommendation REJECTED'),
    row(3, 'research', 'research snapshot published'), // category not watched
    row(4, 'fomo-web', 'scheduled fetch failed (fail closed): no rows'),
    row(5, 'dawn-lookup', 'resolved 2 address(es), 0 unresolved'), // watched category, healthy message
    row(6, 'recommendation', 'inbox file unreadable'),
    row(7, 'dawn-lookup', 'scheduled lookup failed (fail closed): Telegram Web session missing'),
    row(8, 'recommendation', 'replacement paused: PAUSED_NO_TRADER'),
    row(9, 'recommendation', 'LEADER_STALLED: last on-chain swap 26.0h ago'),
  ];

  it('selects only watched categories with failure-shaped messages newer than the high-water mark', () => {
    const picked = selectAnomalies(rows, 0);
    expect(picked.map((r) => r.id)).toEqual([2, 4, 6, 7, 8, 9]);
  });

  it('honors the lastSeenId high-water mark', () => {
    expect(selectAnomalies(rows, 4).map((r) => r.id)).toEqual([6, 7, 8, 9]);
    expect(selectAnomalies(rows, 9)).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats micro-USD amounts compactly and signed', () => {
    expect(formatMicroUsd(123450000n)).toBe('$123.45');
    expect(formatMicroUsd(-93600000n)).toBe('-$93.60');
    expect(formatMicroUsd(0n)).toBe('$0.00');
    expect(formatMicroUsd(1600000000n)).toBe('$1,600.00');
  });

  it('builds a four-line daily report', () => {
    const text = dailyReportText({
      mode: 'paper',
      realizedUsdMicro24h: -93600000n,
      trades24h: 3,
      openPositions: 2,
      activeCandidateId: 'cand_unipcs',
    });
    expect(text).toContain('ZCode Bot daily report (paper)');
    expect(text).toContain('-$93.60 across 3 trade(s)');
    expect(text).toContain('Open positions: 2');
    expect(text).toContain('Active trader: cand_unipcs');
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('daily schedule', () => {
  it('targets today when the time is still ahead, otherwise tomorrow', () => {
    const morning = new Date('2026-10-27T07:30:00');
    const ms = msUntilNextLocalTime(9, 0, morning);
    expect(ms).toBe(90 * 60 * 1000); // 07:30 -> 09:00 local = 90 minutes
    const evening = new Date('2026-10-27T23:59:00');
    const ms2 = msUntilNextLocalTime(9, 0, evening);
    expect(ms2).toBeGreaterThan(0);
    expect(ms2).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
