import { describe, expect, it } from 'vitest';
import { countdown } from '../src/components/PositionsPanel';
import type { DashboardState } from '../src/types';

const NOW = Date.parse('2026-11-02T18:00:00.000Z');
const at = (hoursAgo: number) =>
  ({ openedIso: new Date(NOW - hoursAgo * 3_600_000).toISOString() }) as DashboardState['positions'][number];

/**
 * The time-exit countdown is a real number the operator acts on: it must be in
 * hours, not in the milliseconds the age is measured in (the 1000x bug read
 * "TIME EXIT IN 6908h" for a six-hour remainder).
 */
describe('position time-exit countdown', () => {
  it('counts down in hours from the age ceiling', () => {
    expect(countdown(at(0), 8, 3, NOW).text).toBe('TIME EXIT IN 8h 0m');
    expect(countdown(at(2), 8, 3, NOW).text).toBe('TIME EXIT IN 6h 0m');
    expect(countdown(at(7.5), 8, 3, NOW).text).toBe('TIME EXIT IN 30m');
  });

  it('moves into the grace window at the age ceiling', () => {
    const cd = countdown(at(9), 8, 3, NOW);
    expect(cd.phase).toBe('grace');
    expect(cd.text).toBe('GRACE · SELLS IN 2h 0m');
  });

  it('says SELLS NOW once the grace window is over', () => {
    expect(countdown(at(11), 8, 3, NOW)).toEqual({ text: 'SELLS NOW', phase: 'now' });
    expect(countdown(at(30), 8, 3, NOW).phase).toBe('now');
  });

  it('treats an unreadable open time as brand new instead of inventing an age', () => {
    expect(countdown({ openedIso: 'not-a-date' } as never, 8, 3, NOW).text).toBe('TIME EXIT IN 8h 0m');
  });
});
