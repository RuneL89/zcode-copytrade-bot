import { describe, expect, it } from 'vitest';
import {
  attributeTraderGap,
  buildProposals,
  duringSeatShadow,
  evaluateFiredTrader,
  evaluateHiringRule,
  groupExitLots,
  isoWeekOf,
  lastCompletedWeek,
  nextWeeklyReviewAt,
  normalizeExitReason,
  summarizeShadow,
  weekRange,
  type LotFact,
  type PositionFact,
  type ShadowTradeFact,
} from '../src/weeklyReview.js';

const shadow = (over: Partial<ShadowTradeFact> = {}): ShadowTradeFact => ({
  candidateId: 'cand_a',
  mint: 'mint',
  openedAt: '2026-11-10T10:00:00.000Z',
  closedAt: '2026-11-10T11:00:00.000Z',
  status: 'closed',
  notionalUsdMicro: 5_000_000n,
  pnlUsdMicro: 1_000_000n,
  exitReason: 'leader_sell',
  ...over,
});

const position = (over: Partial<PositionFact> = {}): PositionFact => ({
  positionId: 'pos_1',
  activationId: 'act_1',
  mint: 'mint',
  status: 'closed',
  inputUsdMicro: 5_000_000n,
  feesUsdMicro: 10_000n,
  realizedPnlUsdMicro: 0n,
  openedAt: '2026-11-10T10:00:00.000Z',
  closedAt: '2026-11-10T12:00:00.000Z',
  closeReason: 'time_exit',
  auditDecision: 'stop_loss',
  ...over,
});

const lot = (over: Partial<LotFact> = {}): LotFact => ({
  positionId: 'pos_1',
  pnlUsdMicro: 1_000_000n,
  feesUsdMicro: 5_000n,
  closedAt: '2026-11-10T12:00:00.000Z',
  unitType: 'position_closed',
  ...over,
});

describe('exit reason normalization', () => {
  it('maps the code-exit decision and the close reason', () => {
    expect(normalizeExitReason('time_exit', 'stop_loss')).toBe('stop_loss');
    expect(normalizeExitReason('time_exit', 'trailing_stop')).toBe('trailing_stop');
    expect(normalizeExitReason('time_exit', 'partial_take_profit')).toBe('partial_take_profit');
    expect(normalizeExitReason('time_exit', 'grace_green')).toBe('sell_on_green');
    expect(normalizeExitReason('leader_exit', null)).toBe('leader_sold');
    expect(normalizeExitReason('fire_close_all', null)).toBe('fire_close');
    expect(normalizeExitReason('manual', null)).toBe('manual');
    expect(normalizeExitReason('emergency', null)).toBe('emergency');
    expect(normalizeExitReason('daily_loss_stop', null)).toBe('daily_loss_stop');
    expect(normalizeExitReason('time_exit', null)).toBe('time_exit');
    expect(normalizeExitReason('unpriceable', null)).toBe('unpriceable');
    expect(normalizeExitReason(null, 'mystery')).toBe('other');
  });
});

describe('exit grouping', () => {
  it('groups lots by the effective exit reason and marks post-exit prices unknown', () => {
    const positions: PositionFact[] = [
      position({ positionId: 'p1', auditDecision: 'stop_loss' }),
      position({ positionId: 'p2', closeReason: 'leader_exit', auditDecision: null }),
      position({
        positionId: 'p3',
        status: 'partially_closed',
        closeReason: null,
        auditDecision: 'partial_take_profit',
      }),
      position({ positionId: 'p4', closeReason: 'time_exit', auditDecision: null }),
    ];
    const lots: LotFact[] = [
      lot({ positionId: 'p1', pnlUsdMicro: 5_000_000n }),
      lot({ positionId: 'p1', pnlUsdMicro: -2_000_000n }),
      lot({ positionId: 'p2', pnlUsdMicro: 3_000_000n }),
      lot({ positionId: 'p3', pnlUsdMicro: 1_000_000n, unitType: 'partial_close' }),
      lot({ positionId: 'p4', pnlUsdMicro: -500_000n }),
    ];
    const groups = groupExitLots(positions, lots);
    const byReason = Object.fromEntries(groups.map((group) => [group.reason, group]));
    expect(byReason.stop_loss).toMatchObject({
      positions: 1,
      lots: 2,
      pnlUsdMicro: 3_000_000n,
      wins: 1,
      losses: 1,
    });
    expect(byReason.leader_sold.pnlUsdMicro).toBe(3_000_000n);
    expect(byReason.partial_take_profit.pnlUsdMicro).toBe(1_000_000n);
    expect(byReason.time_exit.pnlUsdMicro).toBe(-500_000n);
    for (const group of groups) {
      expect(group.postExitOneHour).toEqual({ known: 0, unknown: group.positions });
      expect(group.postExitTwoHours).toEqual({ known: 0, unknown: group.positions });
    }
  });

  it('handles an empty period', () => {
    expect(groupExitLots([], [])).toEqual([]);
  });
});

describe('shadow record', () => {
  it('summarizes closed and open shadow trades at a cutoff', () => {
    const summary = summarizeShadow(
      [
        shadow({ pnlUsdMicro: 2_000_000n }),
        shadow({ pnlUsdMicro: -1_000_000n }),
        shadow({ status: 'open', closedAt: null, pnlUsdMicro: null }),
        shadow({
          openedAt: '2026-11-20T00:00:00.000Z',
          closedAt: '2026-11-20T01:00:00.000Z',
          pnlUsdMicro: 9_000_000n,
        }),
      ],
      '2026-11-15T00:00:00.000Z',
    );
    expect(summary.closedTrades).toBe(2);
    expect(summary.netPnlUsdMicro).toBe(1_000_000n);
    expect(summary.winRatePct).toBe(50);
    expect(summary.openTrades).toBe(1);
    expect(summary.openNotionalUsdMicro).toBe(5_000_000n);
  });

  it('counts only shadow trades opened inside the seat window', () => {
    const seat = {
      activationId: 'act_1',
      candidateId: 'cand_a',
      handle: 'a',
      startedAt: '2026-11-10T12:00:00.000Z',
      endedAt: '2026-11-10T18:00:00.000Z',
      endReason: null,
    };
    const summary = duringSeatShadow(
      [
        shadow({ openedAt: '2026-11-10T10:00:00.000Z' }),
        shadow({
          openedAt: '2026-11-10T13:00:00.000Z',
          closedAt: '2026-11-10T14:00:00.000Z',
          pnlUsdMicro: 2_000_000n,
        }),
        shadow({
          openedAt: '2026-11-10T19:00:00.000Z',
          closedAt: '2026-11-10T20:00:00.000Z',
          pnlUsdMicro: 9_000_000n,
        }),
      ],
      seat,
    );
    expect(summary.closedTrades).toBe(1);
    expect(summary.netPnlUsdMicro).toBe(2_000_000n);
  });
});

describe('promised vs actual attribution', () => {
  it('reports the pre-hire shadow gap and prices the known components', () => {
    const attribution = attributeTraderGap({
      preHireShadow: {
        closedTrades: 10,
        netPnlUsdMicro: 10_000_000n,
        wins: 6,
        losses: 4,
        flats: 0,
        winRatePct: 60,
        openTrades: 0,
        openNotionalUsdMicro: 0n,
      },
      duringSeatShadow: {
        closedTrades: 0,
        netPnlUsdMicro: 0n,
        wins: 0,
        losses: 0,
        flats: 0,
        winRatePct: null,
        openTrades: 0,
        openNotionalUsdMicro: 0n,
      },
      actual: {
        positions: 1,
        openPositions: 0,
        realizedPnlUsdMicro: 6_000_000n,
        feesUsdMicro: 20_000n,
        openInputUsdMicro: 0n,
      },
      entries: [
        {
          positionId: 'pos_1',
          leaderAtIso: '2026-11-10T10:00:00.000Z',
          fillAtIso: '2026-11-10T10:00:30.000Z',
          leaderPriceUsdMicro: 100n,
          fillPriceUsdMicro: 102n,
          inputUsdMicro: 2_000_000n,
        },
      ],
      skipped: [
        {
          activationId: 'act_1',
          mint: 'mint',
          rule: 'MAX_DEPLOYED_PCT',
          reason: 'bankroll cap',
          createdAt: '2026-11-10T10:00:00.000Z',
        },
        {
          activationId: 'act_1',
          mint: 'mint2',
          rule: 'MIN_PER_BUY_USD',
          reason: 'floor',
          createdAt: '2026-11-10T10:01:00.000Z',
        },
      ],
      nonLeaderExitPnlUsdMicro: 1_000_000n,
    });
    expect(attribution.promisedUsdMicro).toBe(10_000_000n);
    expect(attribution.actualUsdMicro).toBe(6_000_000n);
    expect(attribution.gapUsdMicro).toBe(-4_000_000n);
    const byKey = Object.fromEntries(attribution.components.map((component) => [component.key, component]));
    expect(byKey.copy_delay.amountUsdMicro).toBeNull();
    expect(byKey.copy_delay.detail).toContain('30.0s');
    expect(byKey.entry_price.amountUsdMicro).toBe(40_000n);
    expect(byKey.entry_price.detail).toContain('200.0 bps');
    expect(byKey.fees.amountUsdMicro).toBe(20_000n);
    expect(byKey.skipped_buys.detail).toContain('2 skipped');
    expect(byKey.skipped_buys.detail).toContain('MAX_DEPLOYED_PCT');
    expect(byKey.exit_policy.amountUsdMicro).toBe(1_000_000n);
    expect(byKey.during_seat_shadow.amountUsdMicro).toBeNull();
    expect(attribution.unresolvedUsdMicro).toBeNull();
  });

  it('does not invent a promised figure when there is no pre-hire shadow record', () => {
    const attribution = attributeTraderGap({
      preHireShadow: {
        closedTrades: 0,
        netPnlUsdMicro: 0n,
        wins: 0,
        losses: 0,
        flats: 0,
        winRatePct: null,
        openTrades: 0,
        openNotionalUsdMicro: 0n,
      },
      duringSeatShadow: {
        closedTrades: 0,
        netPnlUsdMicro: 0n,
        wins: 0,
        losses: 0,
        flats: 0,
        winRatePct: null,
        openTrades: 0,
        openNotionalUsdMicro: 0n,
      },
      actual: {
        positions: 0,
        openPositions: 0,
        realizedPnlUsdMicro: 0n,
        feesUsdMicro: 0n,
        openInputUsdMicro: 0n,
      },
      entries: [],
      skipped: [],
      nonLeaderExitPnlUsdMicro: 0n,
    });
    expect(attribution.promisedUsdMicro).toBeNull();
    expect(attribution.gapUsdMicro).toBeNull();
  });
});

describe('hiring-rule check', () => {
  const row = (pre: number, actual: number) => ({
    activationId: `act_${pre}`,
    handle: `h${pre}`,
    preClosedTrades: 10,
    preNetUsdMicro: BigInt(pre * 1_000_000),
    preWinRatePct: 50,
    actualPnlUsdMicro: BigInt(actual * 1_000_000),
    gapUsdMicro: BigInt((actual - pre) * 1_000_000),
  });

  it('refuses to judge fewer than three seats', () => {
    const result = evaluateHiringRule([row(1, 1), row(2, 2)]);
    expect(result.correlation).toBeNull();
    expect(result.verdict).toContain('Insufficient sample');
    expect(result.flags).toEqual([]);
  });

  it('flags a non-predictive rule at five or more seats', () => {
    const result = evaluateHiringRule([row(5, 1), row(4, 2), row(3, 3), row(2, 4), row(1, 5)]);
    expect(result.correlation).toBeCloseTo(-1, 5);
    expect(result.flags).toEqual(['promotion_net_not_predictive']);
    expect(result.verdict).toContain('did not predict');
  });

  it('reports a positive relationship without proposing a change', () => {
    const result = evaluateHiringRule([row(1, 1), row(2, 2), row(3, 3), row(4, 4), row(5, 5)]);
    expect(result.correlation).toBeCloseTo(1, 5);
    expect(result.flags).toEqual([]);
    expect(result.verdict).toContain('positive relationship');
  });

  it('handles zero variance', () => {
    const result = evaluateHiringRule([row(1, 0), row(2, 0), row(3, 0), row(4, 0), row(5, 0)]);
    expect(result.correlation).toBeNull();
    expect(result.verdict).toContain('No correlation');
  });
});

describe('fired-trader check', () => {
  it('marks cooling wallets unknown when the watch list does not shadow them', () => {
    const result = evaluateFiredTrader(
      {
        candidateId: 'cand_a',
        handle: 'a',
        firedAt: '2026-11-10T00:00:00.000Z',
        reason: 'idle',
        watchStatus: 'cooling',
      },
      [],
    );
    expect(result.status).toBe('unknown');
    expect(result.pnlUsdMicro).toBeNull();
    expect(result.note).toContain('cooling');
  });

  it('sums post-firing shadow P&L when trades exist', () => {
    const result = evaluateFiredTrader(
      {
        candidateId: 'cand_a',
        handle: 'a',
        firedAt: '2026-11-10T00:00:00.000Z',
        reason: 'idle',
        watchStatus: 'watching',
      },
      [shadow({ pnlUsdMicro: 2_000_000n }), shadow({ pnlUsdMicro: -500_000n })],
    );
    expect(result.status).toBe('known');
    expect(result.pnlUsdMicro).toBe(1_500_000n);
  });
});

describe('proposals', () => {
  const hiring = {
    correlation: -0.8,
    sample: 6,
    verdict: 'did not predict',
    flags: ['promotion_net_not_predictive'],
  };

  it('proposes no change with no closed copies', () => {
    const proposals = buildProposals({
      closedPositions: 0,
      copies: 0,
      averageCopyUsdMicro: 0n,
      feesUsdMicro: 0n,
      hiring,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.direction).toBe('NO CHANGE');
  });

  it('tightens the promotion bar when the rule did not predict', () => {
    const proposals = buildProposals({
      closedPositions: 10,
      copies: 10,
      averageCopyUsdMicro: 5_000_000n,
      feesUsdMicro: 0n,
      hiring,
    });
    expect(proposals.some((proposal) => proposal.direction === 'TIGHTENS')).toBe(true);
    expect(proposals.some((proposal) => proposal.parameter === 'PROMOTION_MIN_NET_USD')).toBe(true);
  });

  it('flags fee drag as a tightening candidate', () => {
    const proposals = buildProposals({
      closedPositions: 10,
      copies: 10,
      averageCopyUsdMicro: 5_000_000n,
      feesUsdMicro: 500_000n, // $0.50 on $50 copied = 1%
      hiring: { ...hiring, flags: [], correlation: 0.5 },
    });
    expect(proposals.some((proposal) => proposal.parameter === 'MIN_PER_BUY_USD')).toBe(true);
  });
});

describe('weeks and schedule', () => {
  const tz = 'Europe/Helsinki';

  it('resolves the ISO week of a Helsinki date', () => {
    const week = isoWeekOf(new Date('2026-11-15T12:00:00.000Z'), tz);
    expect(week.label).toBe('2026-W46');
    expect(week.startIso).toBe('2026-11-08T22:00:00.000Z');
    expect(week.endIso).toBe('2026-11-15T22:00:00.000Z');
  });

  it('resolves a week label in summer time', () => {
    const week = weekRange('2026-W27', tz);
    expect(week.startIso).toBe('2026-06-28T21:00:00.000Z');
    expect(week.endIso).toBe('2026-07-05T21:00:00.000Z');
  });

  it('identifies the last completed week for a Monday report', () => {
    const week = lastCompletedWeek(new Date('2026-11-16T06:00:00.000Z'), tz);
    expect(week.label).toBe('2026-W46');
  });

  it('schedules Monday 08:00 Helsinki', () => {
    expect(nextWeeklyReviewAt(new Date('2026-11-15T12:00:00.000Z'), tz).toISOString()).toBe(
      '2026-11-16T06:00:00.000Z',
    );
    expect(nextWeeklyReviewAt(new Date('2026-11-16T07:00:00.000Z'), tz).toISOString()).toBe(
      '2026-11-23T06:00:00.000Z',
    );
  });
});
