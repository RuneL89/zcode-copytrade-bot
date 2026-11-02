import { describe, expect, it } from 'vitest';
import { isPromotable } from '../src/components/WatchlistPanel';
import type { DashboardState } from '../src/types';

type Row = DashboardState['watchlist']['rows'][number];

const row = (over: Partial<Row> = {}): Row => ({
  candidateId: 'cand_x',
  handle: 'x',
  status: 'watching',
  profileUrl: null,
  lastFundedBuyAt: null,
  fundedBuys24h: 0,
  fundedSells24h: 0,
  closedTrades: 0,
  netShadowPnlUsdMicro: '0',
  openNotionalUsdMicro: '0',
  ceilingExposureUsdMicro: '0',
  blockedReason: null,
  source: 'SHADOW_LEDGER',
  lastEventAt: null,
  ...over,
});

describe('watchlist Promote-now enablement (D4)', () => {
  it('enables only for an unblocked watching row', () => {
    expect(isPromotable(row())).toBe(true);
    expect(isPromotable(row({ blockedReason: 'FEWER_THAN_K_CLOSED' }))).toBe(false);
    expect(isPromotable(row({ blockedReason: 'NO_SLOT' }))).toBe(false);
    expect(isPromotable(row({ blockedReason: 'REENTRY_BANNED' }))).toBe(false);
  });

  it('never enables for promoted, cooling or archived rows', () => {
    for (const status of ['promoted', 'cooling', 'archived'] as const) {
      expect(isPromotable(row({ status }))).toBe(false);
    }
  });
});
