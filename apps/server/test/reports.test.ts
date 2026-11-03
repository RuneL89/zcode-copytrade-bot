import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatMicroUsd,
  formatSignedMicroUsd,
  isWeeklyDay,
  msUntilNextLocalTime,
  positionsText,
  reportText,
  selectAnomalies,
  shortReason,
  type AuditLike,
  type ReportFacts,
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
    row(3, 'fomo-web', 'leaderboard fetch failed'),
    row(4, 'watch', 'adapter drift detected'), // right pattern, wrong category
    row(5, 'reconciliation', 'case opened, needs operator (failed close-out)'),
  ];

  it('selects only new rows from the anomaly categories that look like problems', () => {
    expect(selectAnomalies(rows, 0).map((r) => r.id)).toEqual([2, 3, 5]);
    expect(selectAnomalies(rows, 3).map((r) => r.id)).toEqual([5]);
    expect(selectAnomalies(rows, 5)).toEqual([]);
  });
});

describe('number formatting', () => {
  it('formats micro-USD with thousands separators', () => {
    expect(formatMicroUsd(123450000n)).toBe('$123.45');
    expect(formatMicroUsd(-93600000n)).toBe('-$93.60');
    expect(formatMicroUsd(0n)).toBe('$0.00');
    expect(formatMicroUsd(1600000000n)).toBe('$1,600.00');
  });

  it('signs positive amounts so a PnL figure never reads as a loss', () => {
    expect(formatSignedMicroUsd(14810000n)).toBe('+$14.81');
    expect(formatSignedMicroUsd(-35600000n)).toBe('-$35.60');
    expect(formatSignedMicroUsd(0n)).toBe('$0.00');
  });

  it('formats a countdown compactly', () => {
    expect(formatDuration(80 * 60_000)).toBe('1h 20m');
    expect(formatDuration(18 * 60_000)).toBe('18m');
    expect(formatDuration(-5)).toBe('0m');
  });
});

describe('firing reasons', () => {
  it('reduces prose reasons to their gist', () => {
    expect(shortReason('two consecutive losing units')).toBe('loss streak');
    expect(shortReason('idle: no open positions for 8.0h')).toBe('idle');
    expect(shortReason('manual fire from dashboard')).toBe('manual');
    expect(shortReason('rank: left the board (absent from the top-7 scan)')).toBe('left the board');
    expect(shortReason('something else entirely that is long')).toBe('something else entirely tha…');
  });
});

const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  mode: 'live',
  armed: true,
  appState: 'RUNNING',
  realizedUsdMicro: 14_810_000n,
  closed: { total: 6, wins: 3, losses: 3, flat: 0, sumUsdMicro: 14_810_000n },
  orders: 22,
  equityUsdMicro: 135_645_055n,
  equityChangeUsdMicro: 15_642_055n,
  cashUsdMicro: 30_496_887n,
  deployedPct: 77.51,
  maxDeployedPct: 85,
  openPositions: 5,
  openUnrealizedUsdMicro: -2_350_000n,
  marksPending: 0,
  nextTimeExitMs: 80 * 60_000,
  nextExitInGrace: false,
  chairs: 5,
  chairsHolding: 3,
  benchDepth: 13,
  benchTop: { handle: 'McCrxcken', netUsdMicro: 148_160_000n },
  worstPosition: { symbol: 'MAMESUKE', pnlUsdMicro: -35_600_000n },
  idleSoon: null,
  hired: ['eyezenhour', 'wipViper'],
  fired: [{ handle: 'GrandSafeAnt', reason: 'two consecutive losing units' }],
  walletUsdcUsdMicro: 30_501_805n,
  feeSolBalance: '0.0913',
  feesPaidUsdMicro: 162_015n,
  pendingReconciliations: 0,
  weekly: null,
  ...over,
});

describe('daily report text', () => {
  it('describes the desk in one compact block', () => {
    const text = reportText(facts());
    const lines = text.split('\n');
    expect(lines[0]).toBe('Copydesk · live · armed');
    expect(lines[1]).toBe('Realized 24h: +$14.81 · 6 closes (3W/3L) · 22 orders');
    expect(lines[2]).toBe('Equity $135.65 (+$15.64) · cash $30.50 · deployed 77.51% of 85%');
    expect(lines[3]).toBe('Open 5 · unrealized -$2.35 · next time exit 1h 20m');
    expect(lines[4]).toBe('Chairs 5 (3 holding) · bench 13 ready · top McCrxcken +$148.16');
    expect(lines[5]).toBe('Needs attention: MAMESUKE -$35.60 (biggest open)');
    expect(lines[6]).toBe('24h: hired eyezenhour, wipViper · fired GrandSafeAnt (loss streak)');
    expect(lines[7]).toBe('Wallet $30.50 free USDC · 0.0913 SOL for fees · fees paid $0.16');
    expect(lines).toHaveLength(8);
  });

  it('never renders pending marks as a complete zero', () => {
    // Every open position unpriced: the sum is not a figure, so it says so.
    const allPending = reportText(facts({ marksPending: 5, openUnrealizedUsdMicro: 0n }));
    expect(allPending).toContain('Open 5 · unrealized pending');
    // Partially priced: the sum is shown, with the shortfall named.
    const somePending = reportText(facts({ marksPending: 2 }));
    expect(somePending).toContain('unrealized -$2.35');
    expect(somePending).toContain('marks pending 2');
  });

  it('omits lines that have nothing to say', () => {
    const quiet = reportText(
      facts({
        openPositions: 0,
        openUnrealizedUsdMicro: 0n,
        nextTimeExitMs: null,
        worstPosition: null,
        hired: [],
        fired: [],
        benchDepth: 0,
        benchTop: null,
        chairsHolding: 0,
        closed: { total: 0, wins: 0, losses: 0, flat: 0, sumUsdMicro: 0n },
        realizedUsdMicro: 0n,
        orders: 0,
      }),
    );
    expect(quiet).not.toContain('Needs attention');
    // No digest line (the always-present "Realized 24h:" line is unaffected).
    expect(quiet.split('\n').some((l) => l.startsWith('24h:'))).toBe(false);
    expect(quiet).toContain('Open 0 · unrealized $0.00');
    expect(quiet).toContain('Chairs 5 · bench 0 ready');
    expect(quiet).toContain('Realized 24h: $0.00 · 0 closes (0W/0L) · 0 orders');
  });

  it('leaves a rounding-level loss out of the attention line', () => {
    const quietLoss = reportText(
      facts({
        openUnrealizedUsdMicro: 590_000n,
        worstPosition: { symbol: 'CAPY', pnlUsdMicro: -670_000n }, // -$0.67
        idleSoon: null,
      }),
    );
    expect(quietLoss).not.toContain('Needs attention');
    const realLoss = reportText(facts({ worstPosition: { symbol: 'CAPY', pnlUsdMicro: -1_670_000n } }));
    expect(realLoss).toContain('Needs attention: CAPY -$1.67 (biggest open)');
  });

  it('says nothing about balances the chain read could not supply', () => {
    // Provider rate limits leave these null; the line must not invent a figure.
    const text = reportText(facts({ walletUsdcUsdMicro: null, feeSolBalance: null }));
    expect(text).not.toContain('free USDC');
    expect(text).not.toContain('SOL for fees');
    expect(text).toContain('fees paid $0.16');
  });

  it('says when the desk is not simply running, and names a flat seat about to be fired', () => {
    const text = reportText(
      facts({
        armed: false,
        appState: 'PAUSED_NEW_ENTRIES',
        idleSoon: { handle: 'eyezenhour', hoursLeft: 1.5 },
      }),
    );
    expect(text.split('\n')[0]).toBe('Copydesk · live · disarmed · PAUSED_NEW_ENTRIES');
    expect(text).toContain(
      'Needs attention: MAMESUKE -$35.60 (biggest open) · @eyezenhour idle fires in 1h 30m',
    );
  });

  it('caps a long digest and marks an in-grace exit', () => {
    const text = reportText(
      facts({
        hired: ['a', 'b', 'c', 'd'],
        nextTimeExitMs: 0,
        nextExitInGrace: true,
      }),
    );
    expect(text).toContain('hired 4 (latest a, b, c)');
    expect(text).toContain('next exit in grace');
  });

  it('shows a flat bucket only when a lot closed exactly flat', () => {
    const text = reportText(
      facts({ closed: { total: 3, wins: 1, losses: 1, flat: 1, sumUsdMicro: 1_000_000n } }),
    );
    expect(text).toContain('3 closes (1W/1L/1 flat)');
  });
});

describe('weekly report text', () => {
  const weekly = facts({
    weekly: {
      realizedUsdMicro: 21_400_000n,
      closed: { total: 11, wins: 6, losses: 5, flat: 0, sumUsdMicro: 21_400_000n },
      orders: 71,
      chairs: [
        { handle: 'bystevevr', realizedUsdMicro: 4_200_000n, wins: 3, losses: 1, openPositions: 1 },
        { handle: 'trencHog8', realizedUsdMicro: -12_900_000n, wins: 1, losses: 3, openPositions: 2 },
      ],
    },
  });

  it('leads with the 7-day view and still carries the 24h figures', () => {
    const lines = reportText(weekly, 'weekly').split('\n');
    expect(lines[0]).toBe('Copydesk weekly · live · armed');
    expect(lines[1]).toBe('7d realized: +$21.40 · 11 closes (6W/5L) · 71 orders');
    expect(lines[2]).toBe('Realized 24h: +$14.81 · 6 closes (3W/3L) · 22 orders');
    expect(lines.join('\n')).toContain('7d: hired eyezenhour, wipViper · fired GrandSafeAnt (loss streak)');
  });

  it('lists each chair with its record, best first', () => {
    const text = reportText(weekly, 'weekly');
    expect(text).toContain('Chairs (7d realized · record · open):');
    expect(text).toContain('• bystevevr  +$4.20 · 3W/1L · 1 open');
    expect(text).toContain('• trencHog8  -$12.90 · 1W/3L · 2 open');
    expect(text.indexOf('• bystevevr')).toBeLessThan(text.indexOf('• trencHog8'));
  });

  it('falls back to the daily shape when no weekly block was collected', () => {
    expect(reportText(facts(), 'weekly').split('\n')[0]).toBe('Copydesk · live · armed');
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

  it('sends the weekly summary on Mondays only', () => {
    expect(isWeeklyDay(new Date('2026-11-02T09:00:00'))).toBe(true); // Monday
    expect(isWeeklyDay(new Date('2026-11-03T09:00:00'))).toBe(false);
    expect(isWeeklyDay(new Date('2026-11-08T09:00:00'))).toBe(false); // Sunday
  });
});

/**
 * /positions — the on-demand view the compact report leaves out: one line per
 * open position, soonest time exit first, and never a PnL for an unpriced one.
 */
describe('positions text', () => {
  type State = Parameters<typeof positionsText>[0];
  const position = (over: Record<string, unknown> = {}) => ({
    positionId: 'pos_x',
    leaderHandle: 'leader',
    mintShort: 'Mint1111',
    symbol: 'COIN',
    status: 'open',
    copyUsdMicro: '10000000',
    feesUsdMicro: '0',
    entryFeeLamports: null,
    entryRentLamports: null,
    realizedPnlUsdMicro: '0',
    markUsdMicro: '10500000',
    unrealizedPnlUsdMicro: '500000',
    markAgeSeconds: 5,
    openedIso: '2026-11-03T00:00:00.000Z',
    entries: [],
    ...over,
  });
  const state = (positions: unknown[], over: Record<string, unknown> = {}): State =>
    ({
      positions,
      counters: { maxPositionAgeHours: 8, positionGraceHours: 3 },
      ...over,
    }) as unknown as State;

  const now = new Date('2026-11-03T06:00:00.000Z');

  it('lists the soonest deadline first, with size, PnL and the countdown', () => {
    const text = positionsText(
      state([
        position({ positionId: 'pos_late', symbol: 'LATE', openedIso: '2026-11-03T02:00:00.000Z' }),
        position({ positionId: 'pos_soon', symbol: 'SOON', openedIso: '2026-11-02T23:30:00.000Z' }),
      ]),
      now,
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('Copydesk · open positions (2)');
    expect(lines[1]).toContain('SOON');
    expect(lines[1]).toContain('exit in 1h 30m');
    expect(lines[2]).toContain('LATE');
    expect(lines[2]).toContain('exit in 4h 0m');
    expect(lines[3]).toBe('Total $20.00 · unrealized +$1.00');
  });

  it('marks a position that is riding its grace window', () => {
    const text = positionsText(state([position({ openedIso: '2026-11-02T20:00:00.000Z' })]), now);
    expect(text).toContain('· in grace');
  });

  it('never invents a PnL for an unpriced position', () => {
    const text = positionsText(
      state([
        position({ positionId: 'pos_a', unrealizedPnlUsdMicro: null, markUsdMicro: null }),
        position({ positionId: 'pos_b', unrealizedPnlUsdMicro: '500000' }),
      ]),
      now,
    );
    expect(text).toContain('—');
    expect(text).toContain('unrealized +$0.50 (1 unpriced)');
  });

  it('says so plainly when nothing is open', () => {
    expect(positionsText(state([]), now)).toBe('Copydesk · no open positions');
  });
});
