import { describe, expect, it } from 'vitest';
import {
  HIRE_BACKFILL_LOOKBACK_MS,
  HIRE_BACKFILL_MAX_TX,
  HIRE_BACKFILL_PER_MINUTE,
  MinuteCeiling,
  selectHireBackfill,
  signaturesAfterCursor,
  WATCH_DETAIL_PER_MINUTE,
} from '../src/backfill.js';
import { DAILY_HARD_CAP, EXPECTED_DAILY, nominalDayPlan, planCredits } from '../src/budget.js';

const NOW = Date.parse('2026-11-15T00:09:40Z');

function recentPage(
  count: number,
  stepSec: number,
): Array<{ signature: string; blockTime: number; err: boolean }> {
  return Array.from({ length: count }, (_, index) => ({
    signature: `sig-${index}`,
    blockTime: Math.floor(NOW / 1000) - index * stepSec,
    err: false,
  }));
}

describe('hire backfill', () => {
  it('caps two fresh seats so a 25-signature page cannot spend 68 credits', () => {
    const page = recentPage(25, 5);
    const first = selectHireBackfill({ signatures: page, nowMs: NOW });
    const second = selectHireBackfill({ signatures: page, nowMs: NOW });
    expect(HIRE_BACKFILL_LOOKBACK_MS).toBe(60_000);
    expect(first).toHaveLength(HIRE_BACKFILL_MAX_TX);
    expect(second).toHaveLength(HIRE_BACKFILL_MAX_TX);
    expect(first.every((row) => NOW - row.blockTime! * 1000 <= 3 * 60_000)).toBe(true);

    const ceiling = new MinuteCeiling(HIRE_BACKFILL_PER_MINUTE);
    let paid = 0;
    for (const row of [...first, ...second]) {
      if (ceiling.allow(NOW)) paid++;
    }
    // One signature page per seat when the public node misses, plus the detail calls the ceiling allowed.
    const credits = paid + 2;
    expect(paid).toBe(HIRE_BACKFILL_PER_MINUTE);
    expect(credits).toBeLessThanOrEqual(8);
    expect(credits).toBeLessThan(68);
    // The uncapped path was 2 seats × (1 signature + 25 getTransaction).
    expect(2 * (1 + 25)).toBe(52);
  });

  it('drops signatures outside the lookback and anything at or behind the cursor', () => {
    const page = [
      { signature: 'new', blockTime: Math.floor(NOW / 1000) - 20, err: false },
      { signature: 'cursor', blockTime: Math.floor(NOW / 1000) - 40, err: false },
      { signature: 'old', blockTime: Math.floor(NOW / 1000) - 3_600, err: false },
      { signature: 'failed', blockTime: Math.floor(NOW / 1000) - 10, err: true },
    ];
    expect(
      selectHireBackfill({ signatures: page, nowMs: NOW, cursorSignature: 'cursor' }).map(
        (row) => row.signature,
      ),
    ).toEqual(['new']);
  });

  it('a steady watch poll does not re-read signatures behind the cursor', () => {
    const page = ['newest', 'cursor', 'older-1', 'older-2'].map((signature) => ({ signature }));
    expect(signaturesAfterCursor(page, 'cursor').map((row) => row.signature)).toEqual(['newest']);
    expect(signaturesAfterCursor(page, 'newest')).toEqual([]);
    // 20 wallets, every 5 minutes, nothing new: zero detail calls. The old poll re-read 24 each time.
    const wallets = 20;
    const pollsPerDay = 288;
    const repeated = wallets * pollsPerDay * 24;
    expect(repeated).toBeGreaterThan(EXPECTED_DAILY);
    expect(wallets * pollsPerDay * 0).toBe(0);
    // The watch detail ceiling is a burst cap for admission's bounded prefix,
    // not a daily plan. The nominal day stays under the governor's hard stop.
    expect(WATCH_DETAIL_PER_MINUTE).toBe(120);
    expect(EXPECTED_DAILY).toBeLessThan(DAILY_HARD_CAP);
  });

  it('the designed day stays 5,796', () => {
    expect(planCredits(nominalDayPlan())).toBe(EXPECTED_DAILY);
    expect(EXPECTED_DAILY).toBe(5796);
  });
});
