import { describe, expect, it } from 'vitest';
import { ACTIVITY_WINDOW_HOURS, withinActivityWindow } from '../src/services/builder.js';

describe('activity tape window', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');

  it('keeps rows inside the last 18 hours', () => {
    expect(ACTIVITY_WINDOW_HOURS).toBe(18);
    expect(withinActivityWindow('2026-10-29T18:00:01Z', now)).toBe(true); // 17h59m59s ago
    expect(withinActivityWindow('2026-10-30T11:59:59Z', now)).toBe(true);
  });

  it('drops rows older than 18 hours and malformed timestamps', () => {
    expect(withinActivityWindow('2026-10-29T18:00:00Z', now)).toBe(true); // exactly 18h
    expect(withinActivityWindow('2026-10-29T17:59:59Z', now)).toBe(false);
    expect(withinActivityWindow('2026-10-30T11:00:00Z', now)).toBe(true);
    expect(withinActivityWindow('not-a-date', now)).toBe(false);
  });
});
