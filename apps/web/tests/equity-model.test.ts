import { describe, expect, it } from 'vitest';
import { headerModel } from '../src/redesign/model';
import type { DashboardState } from '../src/types';

/**
 * Equity is account value: cash plus the live mark of open positions. The
 * realized book (`currentUsdMicro`) is deliberately not the header KPI — a
 * position that is up $0.18 must raise equity even before it closes.
 */
describe('header equity', () => {
  const state = {
    mode: 'paper',
    control: { newEntriesPaused: false, emergencyStopped: false, pausedReason: null },
    equity: {
      currentUsdMicro: '99000000', // realized book is down $1.00
      startUsdMicro: '100000000',
      changeUsdMicro: '-1000000',
      rollingUsdMicro: '100180000', // cash + live marks
      series: [],
      source: 'PAPER_CALCULATION',
      asOf: new Date().toISOString(),
    },
    closes: [],
    positions: [
      {
        unrealizedPnlUsdMicro: '180000',
        copyUsdMicro: '34970000',
      },
    ],
    counters: {
      deployedUsdMicro: '34970000',
      capitalUsdMicro: '99000000',
      maxDeployedPct: 80,
      openPositions: 1,
      cashUsdMicro: '65020000',
      solUsdMicro: null,
      rentUsdMicro: null,
      rentLamports: null,
    },
    health: {
      walletUsdcUsdMicro: '65020000',
      feeSolBalance: null,
    },
  } as unknown as DashboardState;

  it('uses mark-to-market account value, not the realized book', () => {
    const h = headerModel(state, null);
    expect(h.equity).toBe(100_180_000n);
    expect(h.equityPct).toBeCloseTo(0.18, 2);
    expect(h.realized).toBe(0n);
    expect(h.unrealized).toBe(180_000n);
    expect(h.today).toBe(180_000n);
  });
});
