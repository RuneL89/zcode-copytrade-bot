/**
 * Weekly performance-review calculations.
 *
 * Pure: every input is normalized evidence (micro-USD bigints, ISO timestamps)
 * and every output is a value the report can render. The server maps DB rows to
 * these facts; this module never reads a database, a file, or the network.
 */

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface SeatFact {
  activationId: string;
  candidateId: string;
  handle: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface ShadowTradeFact {
  candidateId: string;
  mint: string;
  openedAt: string;
  closedAt: string | null;
  status: 'open' | 'closed';
  notionalUsdMicro: bigint;
  pnlUsdMicro: bigint | null;
  exitReason: string | null;
}

export interface PositionFact {
  positionId: string;
  activationId: string;
  mint: string;
  status: string;
  inputUsdMicro: bigint;
  feesUsdMicro: bigint;
  realizedPnlUsdMicro: bigint;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  /** The code-exit decision parsed from the audit trail ("stop_loss", "time_exit", ...). */
  auditDecision: string | null;
}

export interface LotFact {
  positionId: string;
  pnlUsdMicro: bigint;
  feesUsdMicro: bigint;
  closedAt: string;
  unitType: 'position_closed' | 'partial_close' | string;
}

export interface EntryFact {
  positionId: string;
  leaderAtIso: string | null;
  fillAtIso: string | null;
  leaderPriceUsdMicro: bigint | null;
  fillPriceUsdMicro: bigint | null;
  inputUsdMicro: bigint;
}

export interface SkippedBuyFact {
  activationId: string;
  mint: string;
  rule: string;
  reason: string;
  createdAt: string;
}

export interface FiringFact {
  candidateId: string;
  handle: string;
  firedAt: string;
  reason: string;
  watchStatus: 'watching' | 'bench' | 'hired' | 'cooling' | 'archived' | 'none';
}

// ---------------------------------------------------------------------------
// Shadow record
// ---------------------------------------------------------------------------

export interface ShadowSummary {
  closedTrades: number;
  netPnlUsdMicro: bigint;
  wins: number;
  losses: number;
  flats: number;
  winRatePct: number | null;
  openTrades: number;
  openNotionalUsdMicro: bigint;
}

/**
 * Summarize the shadow record as it stood at `untilIso`. A trade that was
 * opened before the cutoff but closed after it counts as open at the cutoff,
 * which is what a seat-boundary snapshot needs.
 */
export function summarizeShadowAt(trades: ShadowTradeFact[], untilIso: string): ShadowSummary {
  const until = Date.parse(untilIso);
  let closedTrades = 0;
  let net = 0n;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let openTrades = 0;
  let openNotional = 0n;
  for (const trade of trades) {
    const opened = Date.parse(trade.openedAt);
    if (!Number.isFinite(opened) || opened >= until) continue;
    const closedAt = trade.closedAt ? Date.parse(trade.closedAt) : NaN;
    if (trade.status === 'closed' && Number.isFinite(closedAt) && closedAt <= until) {
      closedTrades++;
      const pnl = trade.pnlUsdMicro ?? 0n;
      net += pnl;
      if (pnl > 0n) wins++;
      else if (pnl < 0n) losses++;
      else flats++;
      continue;
    }
    openTrades++;
    openNotional += trade.notionalUsdMicro;
  }
  return {
    closedTrades,
    netPnlUsdMicro: net,
    wins,
    losses,
    flats,
    winRatePct: closedTrades > 0 ? Math.round((wins / closedTrades) * 100) : null,
    openTrades,
    openNotionalUsdMicro: openNotional,
  };
}

/** The shadow record as it stands now (closed trades and currently open trades). */
export function summarizeShadow(trades: ShadowTradeFact[], untilIso: string): ShadowSummary {
  return summarizeShadowAt(trades, untilIso);
}

/** Shadow trades the leader opened while the seat was active. The watch list stops shadowing at hire, so this is usually empty. */
export function duringSeatShadow(trades: ShadowTradeFact[], seat: SeatFact): ShadowSummary {
  const start = Date.parse(seat.startedAt);
  const end = seat.endedAt ? Date.parse(seat.endedAt) : Number.POSITIVE_INFINITY;
  const inSeat = trades.filter((trade) => {
    const at = Date.parse(trade.openedAt);
    return Number.isFinite(at) && at >= start && at <= end;
  });
  return summarizeShadowAt(inSeat, seat.endedAt ?? new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Exit analysis
// ---------------------------------------------------------------------------

export type NormalizedExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'partial_take_profit'
  | 'sell_on_green'
  | 'time_exit'
  | 'leader_sold'
  | 'daily_loss_stop'
  | 'fire_close'
  | 'emergency'
  | 'manual'
  | 'other';

const EXIT_LABELS: Record<NormalizedExitReason, string> = {
  stop_loss: 'Stop loss',
  trailing_stop: 'Trailing stop',
  partial_take_profit: 'Partial take-profit',
  sell_on_green: 'Sell on green',
  time_exit: 'Time exit',
  leader_sold: 'Leader sold',
  daily_loss_stop: 'Daily loss stop',
  fire_close: 'Closed on firing',
  emergency: 'Emergency stop',
  manual: 'Manual',
  other: 'Other / unknown',
};

/**
 * The engine records every code exit as `time_exit`; the specific decision is
 * in the audit message. Prefer the audit decision, then the close reason.
 */
export function normalizeExitReason(
  closeReason: string | null | undefined,
  auditDecision: string | null | undefined,
): NormalizedExitReason {
  const raw = `${auditDecision ?? ''} ${closeReason ?? ''}`.toLowerCase();
  if (!raw.trim()) return 'other';
  if (raw.includes('daily')) return 'daily_loss_stop';
  if (raw.includes('stop_loss') || raw.includes('stop loss')) return 'stop_loss';
  if (raw.includes('trailing')) return 'trailing_stop';
  if (raw.includes('partial_take') || raw.includes('partial take') || raw.includes('partial_close')) {
    return 'partial_take_profit';
  }
  if (raw.includes('sell_on_green') || raw.includes('grace_green')) return 'sell_on_green';
  if (raw.includes('leader_exit') || raw.includes('leader_sell') || raw.includes('leader sold')) {
    return 'leader_sold';
  }
  if (raw.includes('fire_close')) return 'fire_close';
  if (raw.includes('emergency')) return 'emergency';
  if (raw.includes('manual')) return 'manual';
  if (raw.includes('time_exit') || raw.includes('max_hold') || raw.includes('grace_expired')) {
    return 'time_exit';
  }
  return 'other';
}

export function exitReasonLabel(reason: NormalizedExitReason): string {
  return EXIT_LABELS[reason];
}

export interface ExitGroup {
  reason: NormalizedExitReason;
  label: string;
  positions: number;
  lots: number;
  pnlUsdMicro: bigint;
  wins: number;
  losses: number;
  flats: number;
  /** Historical marks are not persisted; every post-exit price is unknown. */
  postExitOneHour: { known: number; unknown: number };
  postExitTwoHours: { known: number; unknown: number };
}

export function groupExitLots(
  positions: PositionFact[],
  lots: LotFact[],
  options: { postExitKnown?: boolean } = {},
): ExitGroup[] {
  const byPosition = new Map(positions.map((position) => [position.positionId, position]));
  const groups = new Map<
    NormalizedExitReason,
    { positions: Set<string>; lots: number; pnl: bigint; wins: number; losses: number; flats: number }
  >();
  for (const lot of lots) {
    const position = byPosition.get(lot.positionId);
    if (!position) continue;
    const reason =
      position.status === 'partially_closed' && !position.closeReason
        ? normalizeExitReason('partial_close', position.auditDecision)
        : normalizeExitReason(position.closeReason, position.auditDecision);
    const current = groups.get(reason) ?? {
      positions: new Set<string>(),
      lots: 0,
      pnl: 0n,
      wins: 0,
      losses: 0,
      flats: 0,
    };
    current.positions.add(position.positionId);
    current.lots++;
    current.pnl += lot.pnlUsdMicro;
    if (lot.pnlUsdMicro > 0n) current.wins++;
    else if (lot.pnlUsdMicro < 0n) current.losses++;
    else current.flats++;
    groups.set(reason, current);
  }
  return [...groups.entries()]
    .map(([reason, group]) => ({
      reason,
      label: EXIT_LABELS[reason],
      positions: group.positions.size,
      lots: group.lots,
      pnlUsdMicro: group.pnl,
      wins: group.wins,
      losses: group.losses,
      flats: group.flats,
      postExitOneHour: {
        known: options.postExitKnown ? group.positions.size : 0,
        unknown: options.postExitKnown ? 0 : group.positions.size,
      },
      postExitTwoHours: {
        known: options.postExitKnown ? group.positions.size : 0,
        unknown: options.postExitKnown ? 0 : group.positions.size,
      },
    }))
    .sort((a, b) => Number(b.pnlUsdMicro - a.pnlUsdMicro));
}

// ---------------------------------------------------------------------------
// Promised vs actual and attribution
// ---------------------------------------------------------------------------

export interface ActualSummary {
  positions: number;
  openPositions: number;
  realizedPnlUsdMicro: bigint;
  feesUsdMicro: bigint;
  openInputUsdMicro: bigint;
}

export function summarizeActual(positions: PositionFact[], lots: LotFact[]): ActualSummary {
  const positionIds = new Set(positions.map((position) => position.positionId));
  const ownLots = lots.filter((lot) => positionIds.has(lot.positionId));
  return {
    positions: positions.length,
    openPositions: positions.filter((position) => position.status !== 'closed').length,
    realizedPnlUsdMicro: ownLots.reduce((acc, lot) => acc + lot.pnlUsdMicro, 0n),
    feesUsdMicro:
      positions.reduce((acc, position) => acc + position.feesUsdMicro, 0n) +
      ownLots.reduce((acc, lot) => acc + lot.feesUsdMicro, 0n),
    openInputUsdMicro: positions
      .filter((position) => position.status !== 'closed')
      .reduce((acc, position) => acc + position.inputUsdMicro, 0n),
  };
}

export interface AttributionComponent {
  key: string;
  label: string;
  /** A known USD contribution, or null when the evidence cannot price it. */
  amountUsdMicro: bigint | null;
  detail: string;
}

export interface GapAttribution {
  promisedUsdMicro: bigint | null;
  actualUsdMicro: bigint;
  gapUsdMicro: bigint | null;
  components: AttributionComponent[];
  unresolvedUsdMicro: null;
  note: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function attributeTraderGap(input: {
  preHireShadow: ShadowSummary;
  duringSeatShadow: ShadowSummary;
  actual: ActualSummary;
  entries: EntryFact[];
  skipped: SkippedBuyFact[];
  nonLeaderExitPnlUsdMicro: bigint;
}): GapAttribution {
  const promised = input.preHireShadow.closedTrades > 0 ? input.preHireShadow.netPnlUsdMicro : null;
  const gap = promised === null ? null : input.actual.realizedPnlUsdMicro - promised;
  const delays = input.entries
    .filter((entry) => entry.leaderAtIso && entry.fillAtIso)
    .map((entry) => (Date.parse(entry.fillAtIso!) - Date.parse(entry.leaderAtIso!)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0);
  const priceDiffs = input.entries
    .filter(
      (entry) =>
        entry.leaderPriceUsdMicro !== null &&
        entry.fillPriceUsdMicro !== null &&
        entry.leaderPriceUsdMicro > 0n,
    )
    .map((entry) => {
      const leader = entry.leaderPriceUsdMicro!;
      const fill = entry.fillPriceUsdMicro!;
      return {
        bps: Number(((fill - leader) * 10_000n) / leader),
        amount: (entry.inputUsdMicro * (fill - leader)) / leader,
      };
    });
  const priceBps = mean(priceDiffs.map((row) => row.bps));
  const priceAmount = priceDiffs.reduce((acc, row) => acc + row.amount, 0n);
  const skippedByRule = new Map<string, number>();
  for (const skip of input.skipped) {
    skippedByRule.set(skip.rule, (skippedByRule.get(skip.rule) ?? 0) + 1);
  }
  const skippedDetail =
    [...skippedByRule.entries()].map(([rule, count]) => `${count}× ${rule}`).join(', ') || 'none';

  return {
    promisedUsdMicro: promised,
    actualUsdMicro: input.actual.realizedPnlUsdMicro,
    gapUsdMicro: gap,
    components: [
      {
        key: 'copy_delay',
        label: 'Copy fill delay',
        amountUsdMicro: null,
        detail:
          delays.length > 0
            ? `median ${median(delays)!.toFixed(1)}s across ${delays.length} copied buy(s); cost is inside the entry-price component`
            : 'no leader-to-fill timing pair was recorded',
      },
      {
        key: 'entry_price',
        label: 'Worse entry price',
        amountUsdMicro: priceDiffs.length > 0 ? priceAmount : null,
        detail:
          priceBps === null
            ? 'leader entry price unavailable for the copied buys'
            : `mean ${priceBps.toFixed(1)} bps vs the leader across ${priceDiffs.length} buy(s); positive means we paid more`,
      },
      {
        key: 'fees',
        label: 'Fees (SOL, informational)',
        amountUsdMicro: input.actual.feesUsdMicro,
        detail:
          'USDC PnL excludes fees by design; the fee figure is a separate SOL cost, not part of the gap',
      },
      {
        key: 'skipped_buys',
        label: 'Skipped copies',
        amountUsdMicro: null,
        detail: `${input.skipped.length} skipped buy(s): ${skippedDetail}; missed PnL needs post-skip prices, which are not tracked`,
      },
      {
        key: 'exit_policy',
        label: 'Exits not mirrored from the leader',
        amountUsdMicro: input.nonLeaderExitPnlUsdMicro,
        detail:
          'realized PnL of positions closed by a code exit or firing; a same-mint leader comparison is not stored',
      },
      {
        key: 'during_seat_shadow',
        label: 'Shadow during the seat',
        amountUsdMicro: null,
        detail:
          input.duringSeatShadow.closedTrades > 0
            ? `${input.duringSeatShadow.closedTrades} shadow trade(s) closed in the seat window`
            : 'the watch list stops shadowing a wallet when it is hired, so no same-period shadow record exists',
      },
    ],
    unresolvedUsdMicro: null,
    note: 'Components are evidence, not a reconciled bridge: fees are paid in SOL, skipped-buy PnL and post-exit prices are not tracked, so the gap is not fully attributable.',
  };
}

// ---------------------------------------------------------------------------
// Hiring-rule check
// ---------------------------------------------------------------------------

export interface HiringRuleRow {
  activationId: string;
  handle: string;
  preClosedTrades: number;
  preNetUsdMicro: bigint;
  preWinRatePct: number | null;
  actualPnlUsdMicro: bigint;
  gapUsdMicro: bigint;
}

export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export interface HiringRuleResult {
  correlation: number | null;
  sample: number;
  verdict: string;
  flags: string[];
}

export function evaluateHiringRule(rows: HiringRuleRow[]): HiringRuleResult {
  const sample = rows.length;
  const xs = rows.map((row) => Number(row.preNetUsdMicro) / 1_000_000);
  const ys = rows.map((row) => Number(row.actualPnlUsdMicro) / 1_000_000);
  const correlation = pearsonCorrelation(xs, ys);
  if (sample < 3) {
    return {
      correlation,
      sample,
      verdict: `Insufficient sample (n=${sample}); no promotion rule can be judged.`,
      flags: [],
    };
  }
  if (correlation === null) {
    return {
      correlation,
      sample,
      verdict: `No correlation could be computed (n=${sample}); actual P&L has no variance or the sample is degenerate.`,
      flags: [],
    };
  }
  if (sample < 5) {
    return {
      correlation,
      sample,
      verdict: `Sample too small to judge (n=${sample}, r=${correlation.toFixed(2)}); no rule flagged.`,
      flags: [],
    };
  }
  if (correlation < 0.2) {
    return {
      correlation,
      sample,
      verdict: `Pre-hire shadow net did not predict actual copied P&L (r=${correlation.toFixed(2)}, n=${sample}).`,
      flags: ['promotion_net_not_predictive'],
    };
  }
  return {
    correlation,
    sample,
    verdict: `Pre-hire shadow net showed a positive relationship (r=${correlation.toFixed(2)}, n=${sample}); not enough evidence to change a rule.`,
    flags: [],
  };
}

// ---------------------------------------------------------------------------
// Fired-trader check
// ---------------------------------------------------------------------------

export interface FiredTraderResult {
  shadowTrades: number;
  pnlUsdMicro: bigint | null;
  status: 'known' | 'unknown';
  note: string;
}

export function evaluateFiredTrader(firing: FiringFact, afterFiring: ShadowTradeFact[]): FiredTraderResult {
  const closed = afterFiring.filter((trade) => trade.status === 'closed');
  if (closed.length > 0) {
    return {
      shadowTrades: closed.length,
      pnlUsdMicro: closed.reduce((acc, trade) => acc + (trade.pnlUsdMicro ?? 0n), 0n),
      status: 'known',
      note: 'Closed shadow trades opened in the 7 days after the firing.',
    };
  }
  const watched = firing.watchStatus === 'watching' || firing.watchStatus === 'bench';
  return {
    shadowTrades: 0,
    pnlUsdMicro: null,
    status: 'unknown',
    note: watched
      ? 'The wallet remains shadowed, but no shadow trades were opened in the 7 days after firing; whether it traded is unknown.'
      : `The wallet is ${firing.watchStatus === 'none' ? 'no longer watched' : firing.watchStatus}; the watch list does not shadow it in that state, so post-firing P&L is unknown.`,
  };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalDirection = 'TIGHTENS' | 'LOOSENS' | 'NO CHANGE';

export interface Proposal {
  direction: ProposalDirection;
  parameter: string;
  change: string;
  evidence: string;
}

export function buildProposals(input: {
  closedPositions: number;
  copies: number;
  averageCopyUsdMicro: bigint;
  feesUsdMicro: bigint;
  hiring: HiringRuleResult;
}): Proposal[] {
  if (input.closedPositions === 0) {
    return [
      {
        direction: 'NO CHANGE',
        parameter: '—',
        change: 'No parameter change proposed.',
        evidence: 'There are no closed paper copies in the period, so no rule has evidence to act on.',
      },
    ];
  }
  const proposals: Proposal[] = [];
  if (input.hiring.flags.includes('promotion_net_not_predictive') && input.hiring.correlation !== null) {
    proposals.push({
      direction: 'TIGHTENS',
      parameter: 'PROMOTION_MIN_NET_USD',
      change: 'Raise the pre-hire net bar by $1 (or raise PROMOTION_MIN_CLOSED) until the next review.',
      evidence: `Pre-hire shadow net correlated r=${input.hiring.correlation.toFixed(2)} with actual copied P&L across n=${input.hiring.sample}; the promotion rule did not predict the seats.`,
    });
  }
  if (input.copies > 0 && input.averageCopyUsdMicro > 0n && input.feesUsdMicro > 0n) {
    const feeDragBps = Number(
      (input.feesUsdMicro * 10_000n) / (input.averageCopyUsdMicro * BigInt(input.copies)),
    );
    if (feeDragBps >= 100) {
      proposals.push({
        direction: 'TIGHTENS',
        parameter: 'MIN_PER_BUY_USD',
        change: 'Raise the per-buy floor until fee drag is under 1% of copy notional.',
        evidence: `Fees are ${(feeDragBps / 100).toFixed(2)}% of copied notional across ${input.copies} copy(s) (fees are paid in SOL, separately from USDC PnL).`,
      });
    }
  }
  if (proposals.length === 0) {
    return [
      {
        direction: 'NO CHANGE',
        parameter: '—',
        change: 'No parameter change proposed.',
        evidence:
          'No exit group or attribution component in this period clears the evidence bar for a rule change.',
      },
    ];
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Week / schedule helpers
// ---------------------------------------------------------------------------

export interface WeekRange {
  label: string;
  isoYear: number;
  isoWeek: number;
  startIso: string;
  endIso: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 1;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday,
  };
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

/** UTC instant for a wall-clock time in `timeZone`. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const first = new Date(guess - offset);
  // Re-read the offset at the guessed instant: one correction handles DST edges.
  const corrected = new Date(guess - zoneOffsetMs(first, timeZone));
  return corrected;
}

function localDateToUtcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function isoWeekLabelForLocal(
  year: number,
  month: number,
  day: number,
): { isoYear: number; isoWeek: number } {
  const target = localDateToUtcDate(year, month, day);
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = localDateToUtcDate(target.getUTCFullYear(), 1, 4);
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const isoWeek = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { isoYear: target.getUTCFullYear(), isoWeek };
}

/** ISO week of a local date in the given zone. */
export function isoWeekOf(date: Date, timeZone: string): WeekRange {
  const local = localParts(date, timeZone);
  const { isoYear, isoWeek } = isoWeekLabelForLocal(local.year, local.month, local.day);
  const dayNr = (localDateToUtcDate(local.year, local.month, local.day).getUTCDay() + 6) % 7;
  const monday = localDateToUtcDate(local.year, local.month, local.day);
  monday.setUTCDate(monday.getUTCDate() - dayNr);
  const start = zonedTimeToUtc(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    0,
    0,
    timeZone,
  );
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return {
    label: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
    isoYear,
    isoWeek,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

/** Parse and resolve an ISO week label (YYYY-Www) to its local Monday–Sunday range. */
export function weekRange(label: string, timeZone: string): WeekRange {
  const match = /^(\d{4})-W(\d{2})$/.exec(label.trim());
  if (!match) throw new Error(`invalid ISO week label: ${label} (expected YYYY-Www)`);
  const isoYear = Number(match[1]);
  const isoWeek = Number(match[2]);
  if (!Number.isInteger(isoWeek) || isoWeek < 1 || isoWeek > 53) {
    throw new Error(`invalid ISO week number: ${label}`);
  }
  const jan4 = localDateToUtcDate(isoYear, 1, 4);
  const jan4DayNr = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4.getTime() - jan4DayNr * 86_400_000 + (isoWeek - 1) * 7 * 86_400_000);
  const start = zonedTimeToUtc(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    0,
    0,
    timeZone,
  );
  const end = new Date(start.getTime() + 7 * 86_400_000);
  const actual = isoWeekLabelForLocal(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  return {
    label: `${actual.isoYear}-W${String(actual.isoWeek).padStart(2, '0')}`,
    isoYear: actual.isoYear,
    isoWeek: actual.isoWeek,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

/** The week that ended most recently (the one a Monday 08:00 report covers). */
export function lastCompletedWeek(now: Date, timeZone: string): WeekRange {
  const current = isoWeekOf(now, timeZone);
  const currentStart = new Date(current.startIso);
  const previous = new Date(currentStart.getTime() - 7 * 86_400_000);
  return isoWeekOf(previous, timeZone);
}

/** Next Monday at 08:00 in `timeZone` (strictly after `now`). */
export function nextWeeklyReviewAt(now: Date, timeZone: string, hour = 8): Date {
  const local = localParts(now, timeZone);
  const today = localDateToUtcDate(local.year, local.month, local.day);
  const daysUntilMonday = (8 - local.weekday) % 7;
  const monday = new Date(today.getTime() + daysUntilMonday * 86_400_000);
  let candidate = zonedTimeToUtc(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    hour,
    0,
    timeZone,
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(candidate.getTime() + 7 * 86_400_000);
  }
  return candidate;
}
