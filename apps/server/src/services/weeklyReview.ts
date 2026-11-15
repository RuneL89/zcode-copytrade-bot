import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DbHandle } from '@zcode-bot/db';
import {
  attributeTraderGap,
  buildProposals,
  duringSeatShadow,
  evaluateFiredTrader,
  evaluateHiringRule,
  exitReasonLabel,
  groupExitLots,
  isoWeekOf,
  lastCompletedWeek,
  nextWeeklyReviewAt,
  summarizeActual,
  summarizeShadowAt,
  weekRange,
  zonedTimeToUtc,
  type ActualSummary,
  type EntryFact,
  type ExitGroup,
  type FiringFact,
  type GapAttribution,
  type HiringRuleResult,
  type HiringRuleRow,
  type LotFact,
  type PositionFact,
  type Proposal,
  type SeatFact,
  type ShadowSummary,
  type ShadowTradeFact,
  type SkippedBuyFact,
  type WeekRange,
} from '@zcode-bot/core';

type Sqlite = DbHandle['sqlite'];

const HELSINKI = 'Europe/Helsinki';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface ActivationRow {
  activationId: string;
  candidateId: string;
  handle: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

interface PositionRow {
  positionId: string;
  activationId: string;
  mint: string;
  status: string;
  inputUsdMicro: string;
  feesUsdMicro: string;
  realizedPnlUsdMicro: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

interface LotRow {
  positionId: string;
  pnlUsdMicro: string;
  feesUsdMicro: string;
  closedAt: string;
  unitType: string;
}

interface ShadowRow {
  candidateId: string;
  mint: string;
  openedAt: string;
  closedAt: string | null;
  status: string;
  notionalUsdMicro: string;
  pnlUsdMicro: string | null;
  exitReason: string | null;
}

interface FillRow {
  positionId: string | null;
  intentId: string;
  confirmedAt: string;
  outputAmountBase: string;
  inputMint: string;
  inputUsdMicro: string | null;
  inputAmountBase: string;
  idempotencyKey: string;
}

interface ObservedRow {
  activationId: string;
  signature: string;
  blockTime: number | null;
  detailJson: string | null;
}

interface IntentRow {
  activationId: string;
  mint: string;
  state: string;
  reason: string | null;
  createdAt: string;
}

interface FiringRow {
  candidateId: string;
  firedAt: string;
  reason: string;
}

interface WatchRow {
  candidateId: string;
  status: string;
}

interface AuditRow {
  createdAt: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

export interface WeeklyTraderReview {
  activationId: string;
  candidateId: string;
  handle: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  seatedHours: number;
  /** Why the gap is known/unknown (reset truncation, no shadow sample, open marks). */
  gapNote: string;
  promised: {
    preHireShadow: ShadowSummary;
    duringSeatShadow: ShadowSummary;
    note: string;
  };
  actual: ActualSummary;
  gapUsdMicro: bigint | null;
  attribution: GapAttribution;
  dataGaps: string[];
}

export interface WeeklyReviewReport {
  version: 1;
  week: { label: string; startIso: string; endIso: string; timeZone: string };
  generatedAt: string;
  mode: string;
  source: { dbPath: string; resetAt: string | null; resetBasis: string };
  summary: {
    seats: number;
    copies: number;
    openPositions: number;
    realizedPnlUsdMicro: bigint;
    feesUsdMicro: bigint;
    unrealizedPnlUsdMicro: null;
    shadowClosedTrades: number;
    shadowPnlUsdMicro: bigint;
    shadowOpenTrades: number;
    gapUsdMicro: bigint | null;
  };
  sinceReset: {
    fromIso: string | null;
    basis: string;
    seats: number;
    copies: number;
    openPositions: number;
    realizedPnlUsdMicro: bigint;
    feesUsdMicro: bigint;
    shadowClosedTrades: number;
    shadowOpenTrades: number;
  };
  traders: WeeklyTraderReview[];
  exitGroups: ExitGroup[];
  hiringRule: HiringRuleResult & { rows: HiringRuleRow[] };
  firedTraders: Array<{
    candidateId: string;
    handle: string;
    firedAt: string;
    reason: string;
    watchStatus: string;
    shadowTrades: number;
    pnlUsdMicro: bigint | null;
    status: 'known' | 'unknown';
    note: string;
  }>;
  proposals: Proposal[];
  dataGaps: string[];
}

export interface WeeklyReviewInput {
  sqlite: Sqlite;
  mode: string;
  dbPath: string;
  week?: WeekRange;
  now?: Date;
  timeZone?: string;
  resetAt?: string | null;
}

// ---------------------------------------------------------------------------
// Build the report (read-only queries only)
// ---------------------------------------------------------------------------

export function buildWeeklyReview(input: WeeklyReviewInput): WeeklyReviewReport {
  const sqlite = input.sqlite;
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? HELSINKI;
  const week = input.week ?? lastCompletedWeek(now, timeZone);
  const reset = resolveReset(input.resetAt, sqlite, input.dbPath, timeZone);
  const seats = activationRows(sqlite, week, now);
  const positions = positionsFor(
    sqlite,
    seats.map((seat) => seat.activationId),
  );
  const lots = lotsFor(
    sqlite,
    positions.map((position) => position.positionId),
  );
  const shadow = allShadow(sqlite);
  const observed = observedFor(
    sqlite,
    seats.map((seat) => seat.activationId),
  );
  const fills = fillsFor(
    sqlite,
    positions.map((position) => position.positionId),
  );
  const intents = skippedIntentsFor(
    sqlite,
    seats.map((seat) => seat.activationId),
    week,
  );
  const auditDecisions = codeExitDecisions(sqlite, week);
  const watch = watchStatuses(sqlite);
  const weekStart = Date.parse(week.startIso);
  const weekEnd = Date.parse(week.endIso);
  const nowMs = now.getTime();

  const weeklyPositions = positions.filter((position) => {
    const opened = Date.parse(position.openedAt);
    const closed = position.closedAt ? Date.parse(position.closedAt) : null;
    return opened < weekEnd && (closed === null || closed >= weekStart);
  });
  const weeklyLots = lots.filter((lot) => {
    const at = Date.parse(lot.closedAt);
    return at >= weekStart && at < weekEnd;
  });
  const positionFacts = weeklyPositions.map((position) => toPositionFact(position, auditDecisions));
  const lotFacts = weeklyLots.map(toLotFact);
  const weeklyLotFacts = filterLotsForPositions(
    lotFacts,
    positionFacts.map((p) => p.positionId),
  );
  const entries = entriesForTraders(fills, observed, positions, weekPositionsSet(weeklyPositions));
  const skipped = intents.map(toSkippedFact);

  const traders: WeeklyTraderReview[] = seats.map((seat) => {
    const candidateShadow = shadow
      .filter((trade) => trade.candidateId === seat.candidateId)
      .map(toShadowFact);
    const preHireShadow = summarizeShadowAt(candidateShadow, seat.startedAt);
    const duringSeat = duringSeatShadow(candidateShadow, toSeatFact(seat));
    const seatPositions = positionFacts.filter((position) =>
      weeklyPositions.some(
        (row) => row.activationId === seat.activationId && row.positionId === position.positionId,
      ),
    );
    const seatPositionIds = new Set(seatPositions.map((position) => position.positionId));
    const seatLots = weeklyLotFacts.filter((lot) => seatPositionIds.has(lot.positionId));
    const actual = summarizeActual(seatPositions, seatLots);
    const nonLeaderExitPnl = seatLots
      .filter((lot) => {
        const position = weeklyPositions.find((row) => row.positionId === lot.positionId);
        return position && position.closeReason !== 'leader_exit';
      })
      .reduce((acc, lot) => acc + lot.pnlUsdMicro, 0n);
    const attribution = attributeTraderGap({
      preHireShadow,
      duringSeatShadow: duringSeat,
      actual,
      entries: entries.filter((entry) =>
        seatPositions.some((position) => position.positionId === entry.positionId),
      ),
      skipped: skipped.filter((skip) => skip.activationId === seat.activationId),
      nonLeaderExitPnlUsdMicro: nonLeaderExitPnl,
    });
    const gaps: string[] = [];
    if (!preHireShadow.closedTrades) {
      gaps.push('No pre-hire closed shadow sample; the promised baseline is unknown.');
    }
    if (!duringSeat.closedTrades) {
      gaps.push('The watch list stops shadowing at hire, so no same-period shadow record exists.');
    }
    if (actual.openPositions > 0) {
      gaps.push('Open-position unrealized P&L is not stored in the DB; only realized lots are reported.');
    }
    if (reset.at && seat.startedAt < reset.at && (!seat.endedAt || seat.endedAt > reset.at)) {
      gaps.push(`This seat spans the paper reset (${reset.at}); paper rows before it were deleted.`);
    }
    return {
      activationId: seat.activationId,
      candidateId: seat.candidateId,
      handle: seat.handle,
      startedAt: seat.startedAt,
      endedAt: seat.endedAt,
      endReason: seat.endReason,
      seatedHours: seatedHours(seat, week, now),
      gapNote: gapNote(seat, reset.at, preHireShadow, actual),
      promised: {
        preHireShadow,
        duringSeatShadow: duringSeat,
        note: 'Promised is the pre-hire shadow record (the promotion evidence). The watch list does not shadow a wallet after it is hired.',
      },
      actual,
      gapUsdMicro:
        preHireShadow.closedTrades > 0 && !(reset.at && seat.startedAt < reset.at)
          ? actual.realizedPnlUsdMicro - preHireShadow.netPnlUsdMicro
          : null,
      attribution,
      dataGaps: gaps,
    };
  });

  const weeklyShadowClosed = shadow.filter((trade) => {
    const at = trade.closedAt ? Date.parse(trade.closedAt) : NaN;
    return trade.status === 'closed' && Number.isFinite(at) && at >= weekStart && at < weekEnd;
  });
  const weeklyShadowPnl = weeklyShadowClosed.reduce((acc, trade) => acc + parseMicro(trade.pnlUsdMicro), 0n);
  const weeklyShadowOpen = shadow.filter((trade) => {
    const opened = Date.parse(trade.openedAt);
    const closed = trade.closedAt ? Date.parse(trade.closedAt) : null;
    return opened < weekEnd && (closed === null || closed >= weekEnd);
  }).length;

  const exitGroups = groupExitLots(positionFacts, weeklyLotFacts);
  const hiringRows = traders
    .filter((trader) => trader.promised.preHireShadow.closedTrades > 0 && trader.gapUsdMicro !== null)
    .map((trader) => ({
      activationId: trader.activationId,
      handle: trader.handle,
      preClosedTrades: trader.promised.preHireShadow.closedTrades,
      preNetUsdMicro: trader.promised.preHireShadow.netPnlUsdMicro,
      preWinRatePct: trader.promised.preHireShadow.winRatePct,
      actualPnlUsdMicro: trader.actual.realizedPnlUsdMicro,
      gapUsdMicro: trader.actual.realizedPnlUsdMicro - trader.promised.preHireShadow.netPnlUsdMicro,
    }));
  const hiringRule = { ...evaluateHiringRule(hiringRows), rows: hiringRows };

  const firings = firingRows(sqlite, week);
  const firedTraders = firings.map((firing) => {
    const until = Math.min(Date.parse(firing.firedAt) + 7 * 86_400_000, nowMs);
    const after = shadow
      .filter((trade) => trade.candidateId === firing.candidateId)
      .map(toShadowFact)
      .filter((trade) => {
        const at = Date.parse(trade.openedAt);
        return at >= Date.parse(firing.firedAt) && at <= until;
      });
    const result = evaluateFiredTrader(
      {
        candidateId: firing.candidateId,
        handle: candidateHandle(sqlite, firing.candidateId),
        firedAt: firing.firedAt,
        reason: firing.reason,
        watchStatus: (watch.get(firing.candidateId) as FiringFact['watchStatus']) ?? 'none',
      },
      after,
    );
    return {
      candidateId: firing.candidateId,
      handle: candidateHandle(sqlite, firing.candidateId),
      firedAt: firing.firedAt,
      reason: firing.reason,
      watchStatus: watch.get(firing.candidateId) ?? 'none',
      shadowTrades: result.shadowTrades,
      pnlUsdMicro: result.pnlUsdMicro,
      status: result.status,
      note: result.note,
    };
  });

  const closedPositions = new Set(weeklyLotFacts.map((lot) => lot.positionId)).size;
  const averageCopy =
    weeklyPositions.length > 0
      ? weeklyPositions.reduce((acc, position) => acc + parseMicro(position.inputUsdMicro), 0n) /
        BigInt(weeklyPositions.length)
      : 0n;
  const proposals = buildProposals({
    closedPositions,
    copies: weeklyPositions.length,
    averageCopyUsdMicro: averageCopy,
    feesUsdMicro: traders.reduce((acc, trader) => acc + trader.actual.feesUsdMicro, 0n),
    hiring: hiringRule,
  });

  const sinceResetAt = reset.at ?? '1970-01-01T00:00:00.000Z';
  const sincePositions = positions.filter((position) => position.openedAt >= sinceResetAt);
  const sinceLots = lots.filter((lot) => lot.closedAt >= sinceResetAt);
  const sinceSeats = allSeats(sqlite).filter(
    (seat) => seat.startedAt < now.toISOString() && (!seat.endedAt || seat.endedAt >= sinceResetAt),
  );
  const sinceActual = summarizeActual(
    sincePositions.map((position) => toPositionFact(position, auditDecisions)),
    sinceLots.map(toLotFact),
  );
  const sinceShadowClosed = shadow.filter((trade) => {
    const at = trade.closedAt ? Date.parse(trade.closedAt) : NaN;
    return trade.status === 'closed' && Number.isFinite(at) && at >= Date.parse(sinceResetAt);
  });
  const sinceShadowOpen = shadow.filter((trade) => {
    const opened = Date.parse(trade.openedAt);
    const closed = trade.closedAt ? Date.parse(trade.closedAt) : null;
    return opened >= Date.parse(sinceResetAt) && (closed === null || closed >= nowMs);
  }).length;

  const dataGaps = [
    'Post-exit 1h/2h prices are unknown: the DB stores no historical marks and the report makes no external price calls.',
    'Open-position unrealized P&L is not stored; only realized lots are reported.',
    'The watch list stops shadowing a wallet when it is hired; the promised baseline is the pre-hire shadow record, not a same-period shadow ledger.',
    'Fees are paid in SOL and are excluded from USDC PnL; they are shown as a separate cost.',
    'Skipped-buy missed P&L and post-exit prices need marks the runtime does not persist; those components are marked unknown.',
    'Fired wallets are not shadowed while cooling or hired; post-firing P&L is unknown unless the wallet was still watching.',
  ];
  if (reset.at) {
    dataGaps.push(
      `Paper rows before the reset (${reset.at}) were deleted; pre-reset actual P&L is unavailable. Reset basis: ${reset.basis}.`,
    );
  }

  const knownGaps = traders.map((trader) => trader.gapUsdMicro).filter((gap): gap is bigint => gap !== null);
  return {
    version: 1,
    week: {
      label: week.label,
      startIso: week.startIso,
      endIso: week.endIso,
      timeZone,
    },
    generatedAt: now.toISOString(),
    mode: input.mode,
    source: { dbPath: input.dbPath, resetAt: reset.at, resetBasis: reset.basis },
    summary: {
      seats: seats.length,
      copies: weeklyPositions.length,
      openPositions: weeklyPositions.filter((position) => position.status !== 'closed').length,
      realizedPnlUsdMicro: weeklyLotFacts.reduce((acc, lot) => acc + lot.pnlUsdMicro, 0n),
      feesUsdMicro:
        weeklyPositions.reduce((acc, position) => acc + parseMicro(position.feesUsdMicro), 0n) +
        weeklyLotFacts.reduce((acc, lot) => acc + lot.feesUsdMicro, 0n),
      unrealizedPnlUsdMicro: null,
      shadowClosedTrades: weeklyShadowClosed.length,
      shadowPnlUsdMicro: weeklyShadowPnl,
      shadowOpenTrades: weeklyShadowOpen,
      gapUsdMicro: knownGaps.length > 0 ? knownGaps.reduce((acc, gap) => acc + gap, 0n) : null,
    },
    sinceReset: {
      fromIso: reset.at,
      basis: reset.basis,
      seats: sinceSeats.length,
      copies: sinceActual.positions,
      openPositions: sinceActual.openPositions,
      realizedPnlUsdMicro: sinceActual.realizedPnlUsdMicro,
      feesUsdMicro: sinceActual.feesUsdMicro,
      shadowClosedTrades: sinceShadowClosed.length,
      shadowOpenTrades: sinceShadowOpen,
    },
    traders,
    exitGroups,
    hiringRule,
    firedTraders,
    proposals,
    dataGaps,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function renderWeeklyReviewMarkdown(report: WeeklyReviewReport): string {
  const usd = (micro: bigint | string | null): string => {
    if (micro === null || micro === undefined) return 'unknown';
    const n = typeof micro === 'bigint' ? micro : BigInt(micro);
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const whole = abs / 1_000_000n;
    const frac = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
    return `${neg ? '−' : ''}$${whole.toLocaleString('en-US')}.${frac}`;
  };
  const signed = (micro: bigint | string | null): string => {
    if (micro === null || micro === undefined) return 'unknown';
    const n = typeof micro === 'bigint' ? micro : BigInt(micro);
    return n > 0n ? `+${usd(n)}` : usd(n);
  };
  const esc = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const when = (iso: string): string =>
    new Date(iso).toLocaleString('en-GB', {
      timeZone: report.week.timeZone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const lines: string[] = [];
  lines.push(`# Copydesk weekly review — ${report.week.label}`);
  lines.push('');
  lines.push(
    `**Period:** ${when(report.week.startIso)} → ${when(report.week.endIso)} (${report.week.timeZone}) · **Mode:** ${report.mode} · **Generated:** ${when(report.generatedAt)}`,
  );
  lines.push(`**Source:** \`${report.source.dbPath}\``);
  if (report.source.resetAt) {
    lines.push(`**Reset basis:** ${report.source.resetAt} (${report.source.resetBasis})`);
  } else {
    lines.push(`**Reset basis:** no reset marker; using retained data (${report.source.resetBasis})`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Seats active in the period: **${report.summary.seats}**`);
  lines.push(
    `- Paper copies: **${report.summary.copies}** · open at period end: **${report.summary.openPositions}**`,
  );
  lines.push(`- Realised P&L: **${signed(report.summary.realizedPnlUsdMicro)}**`);
  lines.push(`- Unrealised P&L: **unknown** (the DB does not store open marks)`);
  lines.push(`- Fees (SOL, informational): **${usd(report.summary.feesUsdMicro)}**`);
  lines.push(
    `- Promise-vs-actual gap: **${signed(report.summary.gapUsdMicro)}** ${report.summary.gapUsdMicro === null ? '(no seat has a comparable actual P&L)' : '(seats with comparable actual P&L)'}`,
  );
  lines.push(
    `- Watch shadow in the period: **${report.summary.shadowClosedTrades}** closed (**${signed(report.summary.shadowPnlUsdMicro)}**) · **${report.summary.shadowOpenTrades}** open at period end`,
  );
  lines.push('');
  lines.push('## Since the reset');
  lines.push('');
  lines.push(
    `From **${report.sinceReset.fromIso ?? 'all retained data'}** (${report.sinceReset.basis}): **${report.sinceReset.seats}** seat(s), **${report.sinceReset.copies}** paper copy(ies), **${report.sinceReset.openPositions}** open, realised **${signed(report.sinceReset.realizedPnlUsdMicro)}**, fees **${usd(report.sinceReset.feesUsdMicro)}**, shadow **${report.sinceReset.shadowClosedTrades}** closed / **${report.sinceReset.shadowOpenTrades}** open.`,
  );
  lines.push('');
  lines.push('## Promised vs actual');
  lines.push('');
  if (report.traders.length === 0) {
    lines.push('No seats were active in this period.');
  } else {
    lines.push('| Seat | Handle | Seated | Pre-hire shadow | Actual realised | Gap | Open | Notes |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---|');
    for (const trader of report.traders) {
      const shadow = trader.promised.preHireShadow;
      const note = trader.gapNote;
      lines.push(
        `| ${esc(trader.activationId.slice(-8))} | @${esc(trader.handle.replace(/^@/, ''))} | ${trader.seatedHours.toFixed(1)}h | ${shadow.closedTrades} closed / ${signed(shadow.netPnlUsdMicro)} | ${signed(trader.actual.realizedPnlUsdMicro)} | ${signed(trader.gapUsdMicro)} | ${trader.actual.openPositions} | ${note} |`,
      );
    }
    lines.push('');
    lines.push(
      "The gap is measured against the wallet's pre-hire shadow record, which is the evidence promotion used. The watch list stops shadowing a wallet at hire, so a true same-period shadow P&L is not available.",
    );
  }
  lines.push('');
  lines.push('## Gap attribution');
  lines.push('');
  if (report.traders.length === 0) {
    lines.push('No seats to attribute.');
  } else {
    for (const trader of report.traders) {
      lines.push(`### @${esc(trader.handle.replace(/^@/, ''))}`);
      lines.push('');
      for (const component of trader.attribution.components) {
        lines.push(
          `- **${component.label}:** ${component.amountUsdMicro === null ? 'unknown' : signed(component.amountUsdMicro)} — ${component.detail}`,
        );
      }
      lines.push(`- ${trader.attribution.note}`);
      if (trader.dataGaps.length) {
        for (const gap of trader.dataGaps) lines.push(`- **Gap:** ${gap}`);
      }
      lines.push('');
    }
  }
  lines.push('## Exit analysis');
  lines.push('');
  if (report.exitGroups.length === 0) {
    lines.push('No closed paper positions in this period.');
  } else {
    lines.push('| Exit reason | Positions | Lots | P&L | W / L / Flat | Price +1h | Price +2h |');
    lines.push('|---|---:|---:|---:|---:|---|---|');
    for (const group of report.exitGroups) {
      lines.push(
        `| ${exitReasonLabel(group.reason)} | ${group.positions} | ${group.lots} | ${signed(group.pnlUsdMicro)} | ${group.wins} / ${group.losses} / ${group.flats} | ${group.postExitOneHour.known} known / ${group.postExitOneHour.unknown} unknown | ${group.postExitTwoHours.known} known / ${group.postExitTwoHours.unknown} unknown |`,
      );
    }
    lines.push('');
    lines.push(
      'Post-exit prices are unknown for every position: the DB stores no historical marks and this report made no external price calls.',
    );
  }
  lines.push('');
  lines.push('## Hiring-rule check');
  lines.push('');
  lines.push(report.hiringRule.verdict);
  if (report.hiringRule.rows.length) {
    lines.push('');
    lines.push('| Handle | Pre-hire closed | Pre-hire net | Actual P&L | Gap |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const row of report.hiringRule.rows) {
      lines.push(
        `| @${esc(row.handle.replace(/^@/, ''))} | ${row.preClosedTrades} | ${signed(row.preNetUsdMicro)} | ${signed(row.actualPnlUsdMicro)} | ${signed(row.gapUsdMicro)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Fired-trader check');
  lines.push('');
  if (report.firedTraders.length === 0) {
    lines.push('No firings in this period.');
  } else {
    lines.push('| Handle | Fired | Reason | Watch state | Shadow 7d | P&L | Status |');
    lines.push('|---|---|---|---|---:|---:|---|');
    for (const row of report.firedTraders) {
      lines.push(
        `| @${esc(row.handle.replace(/^@/, ''))} | ${when(row.firedAt)} | ${esc(row.reason)} | ${row.watchStatus} | ${row.shadowTrades} | ${signed(row.pnlUsdMicro)} | ${row.status} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Proposals');
  lines.push('');
  for (const proposal of report.proposals) {
    lines.push(
      `- **${proposal.direction} · ${proposal.parameter}:** ${proposal.change} Evidence: ${proposal.evidence}`,
    );
  }
  lines.push('');
  lines.push('## Data gaps');
  lines.push('');
  for (const gap of report.dataGaps) lines.push(`- ${gap}`);
  lines.push('');
  return lines.join('\n');
}

export function weeklyReportPaths(reportDir: string, report: WeeklyReviewReport, name?: string) {
  const base = name ?? `weekly-review-${report.week.label}`;
  return {
    markdown: join(reportDir, `${base}.md`),
    json: join(reportDir, `${base}.json`),
  };
}

export function writeWeeklyReview(
  reportDir: string,
  report: WeeklyReviewReport,
  name?: string,
): { markdown: string; json: string } {
  mkdirSync(reportDir, { recursive: true });
  const paths = weeklyReportPaths(reportDir, report, name);
  writeFileSync(paths.markdown, renderWeeklyReviewMarkdown(report), 'utf8');
  writeFileSync(paths.json, `${JSON.stringify(report, jsonReplacer, 2)}\n`, 'utf8');
  return paths;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** JSON-safe copy for the HTTP endpoint (micro-USD bigints become strings). */
export function weeklyReviewJson(report: WeeklyReviewReport): unknown {
  return JSON.parse(JSON.stringify(report, jsonReplacer)) as unknown;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class WeeklyReviewScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private opts: {
      sqlite: Sqlite;
      mode: string;
      dbPath: string;
      reportDir: string;
      timeZone?: string;
      now?: () => Date;
      onAudit?: (message: string, error?: string) => void;
    },
  ) {}

  start(): void {
    if (this.opts.mode === 'demo') return;
    const now = this.now();
    const timeZone = this.opts.timeZone ?? HELSINKI;
    // Catch up on a missed Monday 08:00 report once the last completed week is due.
    const last = lastCompletedWeek(now, timeZone);
    const due = Date.parse(last.endIso) + 8 * 3_600_000;
    if (now.getTime() >= due) {
      const markdown = join(this.opts.reportDir, `weekly-review-${last.label}.md`);
      if (!existsSync(markdown)) this.run(last);
    }
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const next = nextWeeklyReviewAt(now, this.opts.timeZone ?? HELSINKI);
    const delay = Math.max(1_000, next.getTime() - now.getTime());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run(lastCompletedWeek(this.now(), this.opts.timeZone ?? HELSINKI));
      this.schedule();
    }, delay);
  }

  private run(week: WeekRange): void {
    try {
      const report = buildWeeklyReview({
        sqlite: this.opts.sqlite,
        mode: this.opts.mode,
        dbPath: this.opts.dbPath,
        week,
        now: this.now(),
        timeZone: this.opts.timeZone,
      });
      const paths = writeWeeklyReview(this.opts.reportDir, report);
      this.opts.onAudit?.(`weekly review written: ${paths.markdown}`);
    } catch (e) {
      this.opts.onAudit?.(`weekly review failed: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function all<T>(sqlite: Sqlite, sql: string, ...params: Array<string | number>): T[] {
  return sqlite.prepare(sql).all(...params) as T[];
}

function one<T>(sqlite: Sqlite, sql: string, ...params: Array<string | number>): T | undefined {
  return sqlite.prepare(sql).get(...params) as T | undefined;
}

function activationRows(sqlite: Sqlite, week: WeekRange, now: Date): ActivationRow[] {
  return all<ActivationRow>(
    sqlite,
    `SELECT a.activation_id AS activationId, a.candidate_id AS candidateId,
            COALESCE(c.handle, a.candidate_id) AS handle,
            a.started_at AS startedAt, a.ended_at AS endedAt,
            COALESCE(a.end_reason, a.fired_reason) AS endReason
       FROM trader_activations a
       LEFT JOIN trader_candidates c ON c.candidate_id = a.candidate_id
      WHERE a.started_at < ? AND (a.ended_at IS NULL OR a.ended_at >= ?)
      ORDER BY a.started_at`,
    week.endIso,
    week.startIso,
  ).filter((row) => row.startedAt <= now.toISOString());
}

function allSeats(sqlite: Sqlite): ActivationRow[] {
  return all<ActivationRow>(
    sqlite,
    `SELECT a.activation_id AS activationId, a.candidate_id AS candidateId,
            COALESCE(c.handle, a.candidate_id) AS handle,
            a.started_at AS startedAt, a.ended_at AS endedAt,
            COALESCE(a.end_reason, a.fired_reason) AS endReason
       FROM trader_activations a
       LEFT JOIN trader_candidates c ON c.candidate_id = a.candidate_id
      ORDER BY a.started_at`,
  );
}

function positionsFor(sqlite: Sqlite, activationIds: string[]): PositionRow[] {
  if (activationIds.length === 0) return [];
  const placeholders = activationIds.map(() => '?').join(',');
  return all<PositionRow>(
    sqlite,
    `SELECT position_id AS positionId, activation_id AS activationId, mint, status,
            input_usd_micro AS inputUsdMicro, fees_usd_micro AS feesUsdMicro,
            realized_pnl_usd_micro AS realizedPnlUsdMicro, opened_at AS openedAt,
            closed_at AS closedAt, close_reason AS closeReason
       FROM copied_positions
      WHERE activation_id IN (${placeholders})
      ORDER BY opened_at`,
    ...activationIds,
  );
}

function lotsFor(sqlite: Sqlite, positionIds: string[]): LotRow[] {
  if (positionIds.length === 0) return [];
  const placeholders = positionIds.map(() => '?').join(',');
  return all<LotRow>(
    sqlite,
    `SELECT position_id AS positionId, pnl_usd_micro AS pnlUsdMicro,
            fees_usd_micro AS feesUsdMicro, closed_at AS closedAt, unit_type AS unitType
       FROM realized_pnl_lots
      WHERE position_id IN (${placeholders})
      ORDER BY closed_at`,
    ...positionIds,
  );
}

function allShadow(sqlite: Sqlite): ShadowRow[] {
  return all<ShadowRow>(
    sqlite,
    `SELECT candidate_id AS candidateId, mint, opened_at AS openedAt,
            closed_at AS closedAt, status, notional_usd_micro AS notionalUsdMicro,
            pnl_usd_micro AS pnlUsdMicro, exit_reason AS exitReason
       FROM shadow_trades
      ORDER BY opened_at`,
  );
}

function observedFor(sqlite: Sqlite, activationIds: string[]): ObservedRow[] {
  if (activationIds.length === 0) return [];
  const placeholders = activationIds.map(() => '?').join(',');
  return all<ObservedRow>(
    sqlite,
    `SELECT activation_id AS activationId, signature, block_time AS blockTime,
            detail_json AS detailJson
       FROM observed_leader_events
      WHERE activation_id IN (${placeholders})`,
    ...activationIds,
  );
}

function fillsFor(sqlite: Sqlite, positionIds: string[]): FillRow[] {
  if (positionIds.length === 0) return [];
  const placeholders = positionIds.map(() => '?').join(',');
  return all<FillRow>(
    sqlite,
    `SELECT f.position_id AS positionId, f.intent_id AS intentId, f.confirmed_at AS confirmedAt,
            f.output_amount_base AS outputAmountBase, i.input_mint AS inputMint,
            i.input_usd_micro AS inputUsdMicro, i.input_amount_base AS inputAmountBase,
            i.idempotency_key AS idempotencyKey
       FROM fills f
       JOIN order_intents i ON i.intent_id = f.intent_id
      WHERE f.position_id IN (${placeholders}) AND i.kind = 'entry'
      ORDER BY f.confirmed_at`,
    ...positionIds,
  );
}

function skippedIntentsFor(sqlite: Sqlite, activationIds: string[], week: WeekRange): IntentRow[] {
  if (activationIds.length === 0) return [];
  const placeholders = activationIds.map(() => '?').join(',');
  return all<IntentRow>(
    sqlite,
    `SELECT activation_id AS activationId, mint, state, reason, created_at AS createdAt
       FROM order_intents
      WHERE activation_id IN (${placeholders})
        AND kind = 'entry'
        AND state IN ('skipped', 'quote_rejected')
        AND created_at >= ? AND created_at < ?
      ORDER BY created_at`,
    ...activationIds,
    week.startIso,
    week.endIso,
  );
}

function firingRows(sqlite: Sqlite, week: WeekRange): FiringRow[] {
  return all<FiringRow>(
    sqlite,
    `SELECT candidate_id AS candidateId, fired_at AS firedAt, reason
       FROM firing_events
      WHERE fired_at >= ? AND fired_at < ?
      ORDER BY fired_at`,
    week.startIso,
    week.endIso,
  );
}

function watchStatuses(sqlite: Sqlite): Map<string, string> {
  const rows = all<WatchRow>(sqlite, 'SELECT candidate_id AS candidateId, status FROM watch_wallets');
  return new Map(rows.map((row) => [row.candidateId, row.status]));
}

function candidateHandle(sqlite: Sqlite, candidateId: string): string {
  const row = one<{ handle: string }>(
    sqlite,
    'SELECT handle FROM trader_candidates WHERE candidate_id = ?',
    candidateId,
  );
  return row?.handle ?? candidateId;
}

function codeExitDecisions(sqlite: Sqlite, week: WeekRange): Map<string, string> {
  const rows = all<AuditRow>(
    sqlite,
    `SELECT created_at AS createdAt, message
       FROM audit_events
      WHERE category = 'monitor' AND message LIKE 'code exit:%'
        AND created_at >= ? AND created_at < ?
      ORDER BY created_at`,
    week.startIso,
    week.endIso,
  );
  const decisions = new Map<string, string>();
  for (const row of rows) {
    const match = /^code exit: (\S+) held [\d.]+h \((.+)\)$/.exec(row.message);
    if (match) decisions.set(`${match[1]}|${row.createdAt}`, match[2]!);
  }
  return decisions;
}

function resolveReset(
  override: string | null | undefined,
  sqlite: Sqlite,
  dbPath: string,
  timeZone: string,
): { at: string | null; basis: string } {
  if (override !== undefined) {
    return override === null
      ? { at: null, basis: 'no reset marker provided' }
      : { at: override, basis: 'provided reset timestamp' };
  }
  const marker = one<{ value: string }>(sqlite, "SELECT value FROM kv WHERE key = 'paper.reset_at'");
  if (marker?.value) {
    return { at: marker.value, basis: 'paper.reset_at marker' };
  }
  const backup = resetFromBackup(dbPath, timeZone);
  if (backup) return backup;
  const candidates: string[] = [];
  const add = (row: { m: string | null } | undefined) => {
    if (row?.m) candidates.push(row.m);
  };
  add(one<{ m: string | null }>(sqlite, 'SELECT MIN(opened_at) AS m FROM copied_positions'));
  add(one<{ m: string | null }>(sqlite, "SELECT MIN(confirmed_at) AS m FROM fills WHERE mode = 'paper'"));
  add(
    one<{ m: string | null }>(sqlite, "SELECT MIN(created_at) AS m FROM order_intents WHERE mode = 'paper'"),
  );
  add(one<{ m: string | null }>(sqlite, 'SELECT MIN(closed_at) AS m FROM realized_pnl_lots'));
  add(one<{ m: string | null }>(sqlite, 'SELECT MIN(created_at) AS m FROM loss_streak_events'));
  if (candidates.length > 0) {
    candidates.sort();
    return { at: candidates[0]!, basis: 'earliest retained paper evidence' };
  }
  const start = one<{ createdAt: string }>(
    sqlite,
    `SELECT created_at AS createdAt FROM audit_events
      WHERE category = 'system' AND message LIKE 'runtime starting (mode=paper)%'
      ORDER BY created_at DESC LIMIT 1`,
  );
  return start
    ? { at: start.createdAt, basis: 'last paper-mode runtime start (no paper rows retained)' }
    : { at: null, basis: 'no paper evidence and no paper-mode start found' };
}

function toSeatFact(row: ActivationRow): SeatFact {
  return {
    activationId: row.activationId,
    candidateId: row.candidateId,
    handle: row.handle,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
  };
}

function toPositionFact(row: PositionRow, decisions: Map<string, string>): PositionFact {
  let auditDecision: string | null = null;
  if (row.closedAt) {
    const closed = Date.parse(row.closedAt);
    for (const [key, decision] of decisions) {
      const [mint, at] = key.split('|');
      if (mint !== row.mint) continue;
      const delta = Math.abs(Date.parse(at!) - closed);
      if (delta <= 120_000) auditDecision = decision;
    }
  }
  return {
    positionId: row.positionId,
    activationId: row.activationId,
    mint: row.mint,
    status: row.status,
    inputUsdMicro: parseMicro(row.inputUsdMicro),
    feesUsdMicro: parseMicro(row.feesUsdMicro),
    realizedPnlUsdMicro: parseMicro(row.realizedPnlUsdMicro),
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason,
    auditDecision,
  };
}

function toLotFact(row: LotRow): LotFact {
  return {
    positionId: row.positionId,
    pnlUsdMicro: parseMicro(row.pnlUsdMicro),
    feesUsdMicro: parseMicro(row.feesUsdMicro),
    closedAt: row.closedAt,
    unitType: row.unitType,
  };
}

function toShadowFact(row: ShadowRow): ShadowTradeFact {
  return {
    candidateId: row.candidateId,
    mint: row.mint,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    status: row.status === 'closed' ? 'closed' : 'open',
    notionalUsdMicro: parseMicro(row.notionalUsdMicro),
    pnlUsdMicro: row.pnlUsdMicro === null ? null : parseMicro(row.pnlUsdMicro),
    exitReason: row.exitReason,
  };
}

function toSkippedFact(row: IntentRow): SkippedBuyFact {
  const rule = row.reason?.split(':')[0]?.trim() || row.state.toUpperCase();
  return {
    activationId: row.activationId,
    mint: row.mint,
    rule,
    reason: row.reason ?? row.state,
    createdAt: row.createdAt,
  };
}

function entriesForTraders(
  fills: FillRow[],
  observed: ObservedRow[],
  positions: PositionRow[],
  positionIds: Set<string>,
): EntryFact[] {
  const observedByKey = new Map(observed.map((row) => [`${row.activationId}:${row.signature}`, row]));
  const positionById = new Map(positions.map((position) => [position.positionId, position]));
  const result: EntryFact[] = [];
  for (const fill of fills) {
    if (!fill.positionId || !positionIds.has(fill.positionId)) continue;
    const position = positionById.get(fill.positionId);
    if (!position) continue;
    const signature = fill.idempotencyKey.split(':')[2];
    const event = signature ? observedByKey.get(`${position.activationId}:${signature}`) : undefined;
    const detail = parseDetail(event?.detailJson ?? null);
    const leaderAtIso =
      event?.blockTime !== null && event?.blockTime !== undefined
        ? new Date(event.blockTime * 1000).toISOString()
        : null;
    const leaderPriceUsdMicro = leaderPrice(detail);
    const fillPriceUsdMicro = fillPrice(fill, detail);
    result.push({
      positionId: fill.positionId,
      leaderAtIso,
      fillAtIso: fill.confirmedAt,
      leaderPriceUsdMicro,
      fillPriceUsdMicro,
      inputUsdMicro:
        fill.inputUsdMicro !== null ? parseMicro(fill.inputUsdMicro) : parseMicro(fill.inputAmountBase),
    });
  }
  return result;
}

function parseDetail(json: string | null): {
  fundingMint?: string;
  fundingDeltaBase?: string | number;
  tokenDeltaBase?: string | number;
  mintDecimals?: number;
} | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as {
      fundingMint?: string;
      fundingDeltaBase?: string | number;
      tokenDeltaBase?: string | number;
      mintDecimals?: number;
    };
  } catch {
    return null;
  }
}

function parseBigInt(value: string | number | undefined): bigint | null {
  if (value === undefined || value === null) return null;
  try {
    const text = String(value).trim().replace(/n$/, '');
    return BigInt(text);
  } catch {
    return null;
  }
}

function parseMicro(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  try {
    return BigInt(String(value).trim().replace(/n$/, ''));
  } catch {
    return 0n;
  }
}

function leaderPrice(detail: ReturnType<typeof parseDetail>): bigint | null {
  if (!detail?.fundingMint || !(detail.fundingMint === USDC_MINT || detail.fundingMint === USDT_MINT)) {
    return null;
  }
  const funding = parseBigInt(detail.fundingDeltaBase);
  const tokens = parseBigInt(detail.tokenDeltaBase);
  const decimals = Number(detail.mintDecimals);
  if (funding === null || tokens === null || tokens <= 0n || !Number.isInteger(decimals)) {
    return null;
  }
  return (funding * 10n ** BigInt(decimals)) / tokens;
}

function fillPrice(fill: FillRow, detail: ReturnType<typeof parseDetail>): bigint | null {
  if (!(fill.inputMint === USDC_MINT || fill.inputMint === USDT_MINT)) return null;
  const usd = parseBigInt(fill.inputUsdMicro ?? fill.inputAmountBase);
  const tokens = parseBigInt(fill.outputAmountBase);
  const decimals = Number(detail?.mintDecimals);
  if (usd === null || tokens === null || tokens <= 0n || !Number.isInteger(decimals)) {
    return null;
  }
  return (usd * 10n ** BigInt(decimals)) / tokens;
}

function weekPositionsSet(positions: PositionRow[]): Set<string> {
  return new Set(positions.map((position) => position.positionId));
}

function filterLotsForPositions(lots: LotFact[], positionIds: string[]): LotFact[] {
  const set = new Set(positionIds);
  return lots.filter((lot) => set.has(lot.positionId));
}

/**
 * The paper reset is a manual ops action and leaves no row. The standard
 * backup filename does carry its timestamp (`zcode-bot-before-paper-reset-…`),
 * so use the latest one when it exists. This reads directory names only.
 */
function resetFromBackup(dbPath: string, timeZone: string): { at: string; basis: string } | null {
  const backupDir = join(dirname(dbPath), 'backups');
  if (!existsSync(backupDir)) return null;
  const found: Array<{ at: string; name: string }> = [];
  for (const name of readdirSync(backupDir)) {
    const match = /^zcode-bot-before-paper-reset-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name);
    if (!match) continue;
    const at = zonedTimeToUtc(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      timeZone,
      Number(match[6]),
    );
    found.push({ at: at.toISOString(), name });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.at.localeCompare(a.at));
  return {
    at: found[0]!.at,
    basis: `latest before-paper-reset backup (${found[0]!.name})`,
  };
}

function gapNote(
  seat: ActivationRow,
  resetAt: string | null,
  preHire: ShadowSummary,
  actual: ActualSummary,
): string {
  if (preHire.closedTrades === 0) return 'no pre-hire shadow sample';
  if (resetAt && seat.startedAt < resetAt) {
    return 'pre-reset paper rows deleted; actual unknown';
  }
  if (actual.openPositions > 0) return 'unrealised unknown';
  return 'realised only';
}

function seatedHours(seat: ActivationRow, week: WeekRange, now: Date): number {
  const start = Math.max(Date.parse(seat.startedAt), Date.parse(week.startIso));
  const end = Math.min(seat.endedAt ? Date.parse(seat.endedAt) : now.getTime(), Date.parse(week.endIso));
  return end > start ? (end - start) / 3_600_000 : 0;
}

// `isoWeekOf`/`weekRange` are re-exported through the core package for callers
// that build a week label from a date.
export { isoWeekOf, weekRange };
