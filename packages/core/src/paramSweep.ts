/**
 * Counterfactual parameter sweep.
 *
 * Pure replay: the server maps persisted shadow trades and real paper evidence
 * to signals/hire windows, then this module applies the SAME sizing, entry-risk
 * and day-trader exit functions the live worker uses. It never reads a database,
 * calls a provider, or writes trading state.
 *
 * Market-path assumption: the DB stores only a shadow trade's entry and exit,
 * never intermediate marks. The simulator walks a linear price path between
 * those two points at `pathStepMinutes` granularity. A trade whose leader exit
 * is after the run's end is treated as open at its entry mark (no future price
 * is used). That assumption is echoed in the report; it is not a claim about the
 * real intra-trade path.
 */

import type { RiskConfig } from '@zcode-bot/config';
import { dayTradeExitDecision, type DayTradeExit } from './positionAge.js';
import { bankrollHeadroom, capitalPctCapUsdMicro, evaluateEntryRisk } from './risk.js';
import { sizeCopy } from './sizing.js';
import { usdToMicro } from './money.js';

export interface SimulationParams {
  /** Adverse bps applied to the leader entry price. */
  entrySlippageBps: number;
  /** Adverse bps applied to every exit price. */
  exitSlippageBps: number;
  /** Round-trip cost in bps of entry notional / exit proceeds. */
  feeBps: number;
  /** Copy delay after the leader's block time, seconds. */
  delaySeconds: number;
  /** Linear-path sampling granularity, minutes. */
  pathStepMinutes: number;
  /** Hiring policy used by the caller to build the hire windows. */
  hiringPolicy?: 'actual' | 'shadow';
  /** Candidate ranking used by the shadow hiring policy. */
  ranking?: 'net' | 'net_per_trade' | 'win_rate' | 'recent';
}

export interface SweepSignal {
  id: string;
  candidateId: string;
  handle: string;
  mint: string;
  decimals: number;
  /** Leader buy block time, ms. */
  blockTimeMs: number;
  /** Leader entry price, micro-USD per whole token. */
  entryPriceUsdMicro: bigint;
  /** Last known terminal mark; null while the trade is still open. */
  exitAtMs: number | null;
  exitPriceUsdMicro: bigint | null;
  /**
   * Why the terminal mark exists. Only a leader sell is mirrored as an exit;
   * a shadow code exit or a paper close is a path end, so an alternate exit
   * rule is not forced to hold to the old exit time.
   */
  exitKind: 'leader_sell' | 'code_exit' | 'paper_close' | 'open';
  /** Measured leader buy notional, micro-USD. */
  leaderInputUsdMicro: bigint;
  source: 'shadow' | 'paper';
}

export interface HireWindow {
  id: string;
  seat: number;
  candidateId: string;
  handle: string;
  startMs: number;
  /** Null means the seat is still held at the simulation end. */
  endMs: number | null;
  startReason: string;
}

export interface SimulationInput {
  signals: SweepSignal[];
  hireWindows: HireWindow[];
  risk: RiskConfig;
  sim: SimulationParams;
  fromMs: number;
  toMs: number;
  equityStartUsdMicro: bigint;
}

export type SimExitReason =
  | 'leader_sell'
  | 'stop_loss'
  | 'trailing_stop'
  | 'partial_take_profit'
  | 'max_hold_green'
  | 'grace_green'
  | 'grace_expired'
  | 'grace_bounce'
  | 'fire_close'
  | 'path_end';

const EXIT_LABEL: Record<SimExitReason, string> = {
  leader_sell: 'Leader sold',
  stop_loss: 'Stop loss',
  trailing_stop: 'Trailing stop',
  partial_take_profit: 'Partial take-profit',
  max_hold_green: 'Max hold (green)',
  grace_green: 'Grace (green)',
  grace_expired: 'Grace expired',
  grace_bounce: 'Grace bounce',
  fire_close: 'Closed on firing',
  path_end: 'Path end (last known mark)',
};

export interface SimExitUnit {
  atMs: number;
  reason: SimExitReason;
  qtyBase: bigint;
  priceUsdMicro: bigint;
  proceedsUsdMicro: bigint;
  costUsdMicro: bigint;
  entryFeeUsdMicro: bigint;
  exitFeeUsdMicro: bigint;
  netUsdMicro: bigint;
  /** True when this unit closes the whole remaining position. */
  final: boolean;
}

export interface SimTrade {
  positionId: string;
  signalId: string;
  source: 'shadow' | 'paper';
  candidateId: string;
  handle: string;
  mint: string;
  windowId: string;
  openedAtMs: number;
  entryPriceUsdMicro: bigint;
  notionalUsdMicro: bigint;
  entryFeeUsdMicro: bigint;
  qtyBase: bigint;
  exitUnits: SimExitUnit[];
  netUsdMicro: bigint;
  open: boolean;
  openMarkUsdMicro: bigint | null;
  openUnrealizedUsdMicro: bigint | null;
}

export interface SimHire {
  windowId: string;
  seat: number;
  candidateId: string;
  handle: string;
  startMs: number;
  endMs: number | null;
  startReason: string;
  trades: number;
  netUsdMicro: bigint;
}

export interface SimMetrics {
  netPnlUsdMicro: bigint;
  realizedPnlUsdMicro: bigint;
  openUnrealizedUsdMicro: bigint;
  trades: number;
  exitUnits: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  worstDayUsdMicro: bigint;
  maxDrawdownUsdMicro: bigint;
  worstTradeUsdMicro: bigint;
  openPositions: number;
  feesUsdMicro: bigint;
}

export interface SweepCoverage {
  signalsSeen: number;
  signalsCopied: number;
  skippedNotHired: number;
  skippedCoalesced: number;
  skippedSizing: number;
  skippedRisk: number;
  skippedStale: number;
  entryRejections: Array<{ rule: string; count: number }>;
  firstSignalIso: string | null;
  lastSignalIso: string | null;
}

export interface SimulationResult {
  metrics: SimMetrics;
  trades: SimTrade[];
  hires: SimHire[];
  exitGroups: Array<{ reason: SimExitReason; label: string; units: number; pnlUsdMicro: bigint }>;
  coverage: SweepCoverage;
}

interface ActivePosition {
  trade: SimTrade;
  windowId: string;
  signal: SweepSignal;
  entryAtMs: number;
  remainingQtyBase: bigint;
  remainingCostUsdMicro: bigint;
  remainingEntryFeeUsdMicro: bigint;
}

interface PendingExit {
  atMs: number;
  position: ActivePosition;
  unit: SimExitUnit;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function adjustedPrice(price: bigint, bps: number, direction: 1 | -1): bigint {
  const factor =
    direction === 1
      ? 10_000n + BigInt(Math.max(0, Math.round(bps)))
      : 10_000n - BigInt(Math.max(0, Math.round(bps)));
  return (price * factor) / 10_000n;
}

function valueOf(qtyBase: bigint, priceUsdMicro: bigint, decimals: number): bigint {
  return (qtyBase * priceUsdMicro) / 10n ** BigInt(decimals);
}

function qtyFor(notionalUsdMicro: bigint, priceUsdMicro: bigint, decimals: number): bigint {
  return (notionalUsdMicro * 10n ** BigInt(decimals)) / priceUsdMicro;
}

function makeUnit(
  qtyBase: bigint,
  costUsdMicro: bigint,
  entryFeeUsdMicro: bigint,
  priceUsdMicro: bigint,
  decimals: number,
  reason: SimExitReason,
  final: boolean,
  sim: SimulationParams,
): SimExitUnit {
  const proceeds = valueOf(qtyBase, priceUsdMicro, decimals);
  const exitFee = (proceeds * BigInt(Math.max(0, Math.round(sim.feeBps)))) / 10_000n;
  return {
    atMs: 0,
    reason,
    qtyBase,
    priceUsdMicro,
    proceedsUsdMicro: proceeds,
    costUsdMicro,
    entryFeeUsdMicro,
    exitFeeUsdMicro: exitFee,
    netUsdMicro: proceeds - costUsdMicro - entryFeeUsdMicro - exitFee,
    final,
  };
}

function priceAt(position: ActivePosition, atMs: number, toMs: number): bigint {
  const signal = position.signal;
  if (signal.exitAtMs !== null && signal.exitAtMs <= toMs) {
    if (atMs >= signal.exitAtMs) return signal.exitPriceUsdMicro ?? signal.entryPriceUsdMicro;
    if (signal.exitAtMs <= position.entryAtMs) return signal.entryPriceUsdMicro;
    const fraction = Math.min(
      1,
      Math.max(0, (atMs - position.entryAtMs) / (signal.exitAtMs - position.entryAtMs)),
    );
    return (
      signal.entryPriceUsdMicro +
      (((signal.exitPriceUsdMicro ?? signal.entryPriceUsdMicro) - signal.entryPriceUsdMicro) *
        BigInt(Math.round(fraction * 1_000_000))) /
        1_000_000n
    );
  }
  // The leader exit is outside this run: never use its future price.
  return signal.entryPriceUsdMicro;
}

/**
 * Build the full exit schedule for one position from a linear leader-price
 * path. Local quantity/cost state is used so partials reduce later units;
 * the active position is only reduced when a unit is actually applied.
 */
function buildExitSchedule(
  position: ActivePosition,
  risk: RiskConfig,
  sim: SimulationParams,
  toMs: number,
): SimExitUnit[] {
  const signal = position.signal;
  const terminalAt = signal.exitAtMs !== null && signal.exitAtMs <= toMs ? signal.exitAtMs : null;
  const terminalPrice = terminalAt !== null ? (signal.exitPriceUsdMicro ?? signal.entryPriceUsdMicro) : null;
  const maxHoldMs = risk.MAX_POSITION_AGE_HOURS * 3_600_000;
  const graceEndMs =
    position.entryAtMs + (risk.MAX_POSITION_AGE_HOURS + risk.POSITION_GRACE_HOURS) * 3_600_000;
  // No path sample beyond the unconditional grace close is relevant.
  const pathEnd = Math.min(terminalAt ?? toMs, graceEndMs);
  if (pathEnd <= position.entryAtMs) return [];
  let remainingQty = position.trade.qtyBase;
  let remainingCost = position.trade.notionalUsdMicro;
  let remainingFee = position.trade.entryFeeUsdMicro;
  // Price-based peak/low: a partial exit halves the position value, but it
  // must not halve the trailing-stop high-water mark.
  let peak = position.trade.entryPriceUsdMicro;
  let low: bigint | null = null;
  let partialTaken = false;
  let graceEntered = false;
  const units: SimExitUnit[] = [];
  const stepMinutes =
    Number.isFinite(sim.pathStepMinutes) && sim.pathStepMinutes > 0 ? sim.pathStepMinutes : 1;
  const stepMs = Math.max(60_000, Math.round(stepMinutes * 60_000));
  const times = new Set<number>();
  for (let t = position.entryAtMs; t < pathEnd; t += stepMs) times.add(t);
  times.add(pathEnd);
  if (terminalAt !== null && terminalAt <= pathEnd) times.add(terminalAt);
  if (position.entryAtMs + maxHoldMs <= pathEnd) times.add(position.entryAtMs + maxHoldMs);
  if (graceEndMs <= pathEnd) times.add(graceEndMs);

  for (const t of [...times].sort((a, b) => a - b)) {
    if (signal.exitKind === 'leader_sell' && terminalAt !== null && t >= terminalAt) {
      const price = adjustedPrice(terminalPrice!, sim.exitSlippageBps, -1);
      const unit = makeUnit(
        remainingQty,
        remainingCost,
        remainingFee,
        price,
        signal.decimals,
        'leader_sell',
        true,
        sim,
      );
      unit.atMs = t;
      units.push(unit);
      return units;
    }
    const markPrice = priceAt(position, t, toMs);
    peak = markPrice > peak ? markPrice : peak;
    if (t - position.entryAtMs >= maxHoldMs) {
      low = low === null || markPrice < low ? markPrice : low;
    }
    const decision: DayTradeExit | 'none' = dayTradeExitDecision({
      openedAtIso: new Date(position.entryAtMs).toISOString(),
      nowMs: t,
      maxAgeHours: risk.MAX_POSITION_AGE_HOURS,
      graceHours: risk.POSITION_GRACE_HOURS,
      entryUsdMicro: position.trade.entryPriceUsdMicro,
      markUsdMicro: markPrice,
      peakUsdMicro: peak,
      lowSinceMaxHoldUsdMicro: low,
      stopLossBps: risk.STOP_LOSS_BPS,
      trailArmBps: risk.TRAIL_ARM_BPS,
      trailDistanceBps: risk.TRAIL_DISTANCE_BPS,
      partialTpBps: risk.PARTIAL_TP_BPS,
      partialTaken,
      graceBounceBps: risk.GRACE_BOUNCE_BPS,
      sellOnGreen: risk.SELL_ON_GREEN,
      graceEntered,
    });
    if (decision === 'none') {
      if (!risk.SELL_ON_GREEN && !graceEntered && t - position.entryAtMs >= maxHoldMs) {
        graceEntered = true;
      }
      // A shadow code exit or a paper close is a last known mark, not a rule
      // the alternative parameter set must obey. Realize it at the path end.
      if (
        signal.exitKind !== 'leader_sell' &&
        terminalAt !== null &&
        terminalAt === pathEnd &&
        t >= terminalAt
      ) {
        const price = adjustedPrice(terminalPrice!, sim.exitSlippageBps, -1);
        const unit = makeUnit(
          remainingQty,
          remainingCost,
          remainingFee,
          price,
          signal.decimals,
          'path_end',
          true,
          sim,
        );
        unit.atMs = t;
        units.push(unit);
        return units;
      }
      continue;
    }
    if (decision === 'partial_take_profit') {
      const qty = remainingQty / 2n;
      if (qty <= 0n) continue;
      const cost = (remainingCost * qty) / remainingQty;
      const fee = (remainingFee * qty) / remainingQty;
      const price = adjustedPrice(markPrice, sim.exitSlippageBps, -1);
      const unit = makeUnit(qty, cost, fee, price, signal.decimals, 'partial_take_profit', false, sim);
      unit.atMs = t;
      units.push(unit);
      remainingQty -= qty;
      remainingCost -= cost;
      remainingFee -= fee;
      partialTaken = true;
      continue;
    }
    const price = adjustedPrice(markPrice, sim.exitSlippageBps, -1);
    const unit = makeUnit(
      remainingQty,
      remainingCost,
      remainingFee,
      price,
      signal.decimals,
      decision,
      true,
      sim,
    );
    unit.atMs = t;
    units.push(unit);
    return units;
  }
  return units;
}

function unitCmp(a: PendingExit, b: PendingExit): number {
  return a.atMs - b.atMs;
}

/** Run one parameter set over one signal set and one hire timeline. */
export function simulateSweep(input: SimulationInput): SimulationResult {
  const { risk, sim, fromMs, toMs, equityStartUsdMicro } = input;
  const windows = input.hireWindows.filter(
    (window) => window.startMs < toMs && (window.endMs === null || window.endMs > fromMs),
  );
  const winByCandidate = new Map<string, HireWindow[]>();
  for (const window of windows) {
    const list = winByCandidate.get(window.candidateId) ?? [];
    list.push(window);
    winByCandidate.set(window.candidateId, list);
  }
  for (const list of winByCandidate.values()) list.sort((a, b) => a.startMs - b.startMs);

  type Event =
    | { kind: 'entry'; atMs: number; signal: SweepSignal }
    | { kind: 'windowEnd'; atMs: number; window: HireWindow };
  const events: Event[] = [];
  for (const signal of input.signals) {
    const atMs = signal.blockTimeMs + sim.delaySeconds * 1000;
    if (atMs < fromMs || atMs > toMs) continue;
    events.push({ kind: 'entry', atMs, signal });
  }
  for (const window of windows) {
    if (window.endMs !== null && window.endMs >= fromMs && window.endMs < toMs) {
      events.push({ kind: 'windowEnd', atMs: window.endMs, window });
    }
  }
  events.sort((a, b) => a.atMs - b.atMs);

  const active = new Map<string, ActivePosition>();
  const pending: PendingExit[] = [];
  const positions: SimTrade[] = [];
  const lastEntryByMint = new Map<string, number>();
  const hireStats = new Map<string, SimHire>();
  for (const window of windows) {
    hireStats.set(window.id, {
      windowId: window.id,
      seat: window.seat,
      candidateId: window.candidateId,
      handle: window.handle,
      startMs: window.startMs,
      endMs: window.endMs,
      startReason: window.startReason,
      trades: 0,
      netUsdMicro: 0n,
    });
  }
  let realized = 0n;
  let fees = 0n;
  let exitUnits = 0;
  const daily = new Map<string, bigint>();
  const entryRejections = new Map<string, number>();
  const coverage: SweepCoverage = {
    signalsSeen: 0,
    signalsCopied: 0,
    skippedNotHired: 0,
    skippedCoalesced: 0,
    skippedSizing: 0,
    skippedRisk: 0,
    skippedStale: 0,
    entryRejections: [],
    firstSignalIso: null,
    lastSignalIso: null,
  };

  const applyExit = (exit: PendingExit) => {
    const position = exit.position;
    const unit = exit.unit;
    position.trade.exitUnits.push(unit);
    position.trade.netUsdMicro += unit.netUsdMicro;
    position.remainingQtyBase -= unit.qtyBase;
    position.remainingCostUsdMicro -= unit.costUsdMicro;
    position.remainingEntryFeeUsdMicro -= unit.entryFeeUsdMicro;
    if (position.remainingQtyBase < 0n) position.remainingQtyBase = 0n;
    if (position.remainingCostUsdMicro < 0n) position.remainingCostUsdMicro = 0n;
    if (position.remainingEntryFeeUsdMicro < 0n) position.remainingEntryFeeUsdMicro = 0n;
    realized += unit.netUsdMicro;
    fees += unit.entryFeeUsdMicro + unit.exitFeeUsdMicro;
    exitUnits++;
    daily.set(utcDay(unit.atMs), (daily.get(utcDay(unit.atMs)) ?? 0n) + unit.netUsdMicro);
    const hire = hireStats.get(position.windowId);
    if (hire) hire.netUsdMicro += unit.netUsdMicro;
    if (unit.final) {
      position.trade.open = false;
      position.trade.openMarkUsdMicro = null;
      position.trade.openUnrealizedUsdMicro = null;
      active.delete(position.trade.positionId);
    }
  };

  const applyPendingUpTo = (atMs: number) => {
    pending.sort(unitCmp);
    while (pending.length > 0 && pending[0]!.atMs <= atMs) {
      applyExit(pending.shift()!);
    }
  };

  const closeWindowAt = (window: HireWindow, atMs: number) => {
    for (const position of [...active.values()].filter(
      (p) => p.windowId === window.id && p.remainingQtyBase > 0n,
    )) {
      const price = adjustedPrice(priceAt(position, atMs, toMs), sim.exitSlippageBps, -1);
      const unit = makeUnit(
        position.remainingQtyBase,
        position.remainingCostUsdMicro,
        position.remainingEntryFeeUsdMicro,
        price,
        position.signal.decimals,
        'fire_close',
        true,
        sim,
      );
      unit.atMs = atMs;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.position === position) pending.splice(i, 1);
      }
      applyExit({ atMs, position, unit });
    }
  };

  const findWindow = (candidateId: string, atMs: number): HireWindow | null => {
    const list = winByCandidate.get(candidateId) ?? [];
    let found: HireWindow | null = null;
    for (const window of list) {
      if (window.startMs <= atMs && (window.endMs === null || atMs < window.endMs)) found = window;
    }
    return found;
  };

  for (const event of events) {
    applyPendingUpTo(event.atMs);
    if (event.kind === 'windowEnd') {
      closeWindowAt(event.window, event.atMs);
      continue;
    }
    const signal = event.signal;
    const atMs = event.atMs;
    coverage.signalsSeen++;
    const signalIso = new Date(signal.blockTimeMs).toISOString();
    if (coverage.firstSignalIso === null || signalIso < coverage.firstSignalIso) {
      coverage.firstSignalIso = signalIso;
    }
    if (coverage.lastSignalIso === null || signalIso > coverage.lastSignalIso) {
      coverage.lastSignalIso = signalIso;
    }
    if (signal.entryPriceUsdMicro <= 0n || signal.blockTimeMs <= 0) {
      coverage.skippedStale++;
      continue;
    }
    if (signal.exitAtMs !== null && atMs >= signal.exitAtMs) {
      coverage.skippedStale++;
      continue;
    }
    const window = findWindow(signal.candidateId, atMs);
    if (!window) {
      coverage.skippedNotHired++;
      continue;
    }
    const mintKey = `${signal.candidateId}|${signal.mint}`;
    const lastEntry = lastEntryByMint.get(mintKey);
    if (lastEntry !== undefined && atMs - lastEntry < 60_000) {
      coverage.skippedCoalesced++;
      continue;
    }
    const open = [...active.values()];
    const bank = bankrollHeadroom({
      equityStartUsdMicro,
      openEntriesUsdMicro: open.reduce((acc, p) => acc + p.trade.notionalUsdMicro, 0n),
      openFeesUsdMicro: open.reduce((acc, p) => acc + p.trade.entryFeeUsdMicro, 0n),
      realizedNetUsdMicro: realized,
      maxDeployedPct: risk.MAX_DEPLOYED_PCT,
    });
    const traderOpen = open
      .filter((position) => position.signal.candidateId === signal.candidateId)
      .reduce((acc, p) => acc + p.trade.notionalUsdMicro + p.trade.entryFeeUsdMicro, 0n);
    const minPerBuy = usdToMicro(risk.MIN_PER_BUY_USD);
    const maxPerBuy = capitalPctCapUsdMicro(bank.capitalUsdMicro, risk.MAX_PER_BUY_PCT, minPerBuy);
    const maxOpenPerTrader = capitalPctCapUsdMicro(
      bank.capitalUsdMicro,
      risk.MAX_OPEN_PER_TRADER_PCT,
      maxPerBuy,
    );
    const sized = sizeCopy({
      leaderInputUsdMicro: signal.leaderInputUsdMicro,
      scaleNumerator: BigInt(Math.round(risk.COPY_SCALE * 10_000)),
      scaleDenominator: 10_000n,
      minPerBuyUsdMicro: minPerBuy,
      maxPerBuyUsdMicro: maxPerBuy,
      traderOpenUsdMicro: traderOpen,
      maxOpenPerTraderUsdMicro: maxOpenPerTrader,
      bankrollHeadroomUsdMicro: bank.headroomUsdMicro,
    });
    if (sized.action !== 'copy' || sized.finalUsdMicro === null) {
      coverage.skippedSizing++;
      const rule = sized.action === 'skip_headroom' ? sized.rule : 'SIZE_INVALID';
      entryRejections.set(rule, (entryRejections.get(rule) ?? 0) + 1);
      continue;
    }
    const notional = sized.finalUsdMicro;
    const riskDecision = evaluateEntryRisk(risk, {
      entryUsdMicro: notional,
      maxEntryUsdMicro: maxPerBuy,
      eventAgeSeconds: sim.delaySeconds,
      priceAgeSeconds: 0,
      leaderboardAgeSeconds: 0,
      // Feed the calibrated entry penalty through the real slippage gate; the
      // DB stores no per-trade quote impact, so that gate stays unknown.
      quoteSlippageBps: sim.entrySlippageBps,
      quotePriceImpactBps: null,
    });
    if (!riskDecision.allowed) {
      coverage.skippedRisk++;
      entryRejections.set(riskDecision.rule, (entryRejections.get(riskDecision.rule) ?? 0) + 1);
      continue;
    }
    const entryPrice = adjustedPrice(signal.entryPriceUsdMicro, sim.entrySlippageBps, 1);
    const qty = qtyFor(notional, entryPrice, signal.decimals);
    if (qty <= 0n) {
      coverage.skippedSizing++;
      continue;
    }
    const entryFee = (notional * BigInt(Math.max(0, Math.round(sim.feeBps)))) / 10_000n;
    const positionId = `sim_${signal.id}_${atMs}`;
    const trade: SimTrade = {
      positionId,
      signalId: signal.id,
      source: signal.source,
      candidateId: signal.candidateId,
      handle: signal.handle,
      mint: signal.mint,
      windowId: window.id,
      openedAtMs: atMs,
      entryPriceUsdMicro: entryPrice,
      notionalUsdMicro: notional,
      entryFeeUsdMicro: entryFee,
      qtyBase: qty,
      exitUnits: [],
      netUsdMicro: 0n,
      open: true,
      openMarkUsdMicro: null,
      openUnrealizedUsdMicro: null,
    };
    const activePosition: ActivePosition = {
      trade,
      windowId: window.id,
      signal,
      entryAtMs: atMs,
      remainingQtyBase: qty,
      remainingCostUsdMicro: notional,
      remainingEntryFeeUsdMicro: entryFee,
    };
    positions.push(trade);
    active.set(positionId, activePosition);
    lastEntryByMint.set(mintKey, atMs);
    coverage.signalsCopied++;
    const hire = hireStats.get(window.id);
    if (hire) hire.trades++;
    for (const unit of buildExitSchedule(activePosition, risk, sim, toMs)) {
      pending.push({ atMs: unit.atMs, position: activePosition, unit });
    }
  }
  applyPendingUpTo(toMs);

  let openUnrealized = 0n;
  let openPositions = 0;
  for (const position of active.values()) {
    const mark = valueOf(position.remainingQtyBase, priceAt(position, toMs, toMs), position.signal.decimals);
    position.trade.openMarkUsdMicro = mark;
    position.trade.openUnrealizedUsdMicro =
      mark - position.remainingCostUsdMicro - position.remainingEntryFeeUsdMicro;
    position.trade.netUsdMicro += position.trade.openUnrealizedUsdMicro;
    const hire = hireStats.get(position.windowId);
    if (hire) hire.netUsdMicro += position.trade.openUnrealizedUsdMicro;
    openUnrealized += position.trade.openUnrealizedUsdMicro;
    openPositions++;
  }

  const dailyValues = [...daily.values()];
  const worstDay = dailyValues.length > 0 ? dailyValues.reduce((a, b) => (b < a ? b : a)) : 0n;
  const closed = positions.filter((trade) => !trade.open);
  const worstTrade =
    closed.length > 0 ? closed.map((trade) => trade.netUsdMicro).reduce((a, b) => (b < a ? b : a)) : 0n;
  const wins = closed.filter((trade) => trade.netUsdMicro > 0n).length;
  const losses = closed.filter((trade) => trade.netUsdMicro < 0n).length;
  const units = positions.flatMap((position) => position.exitUnits).sort((a, b) => a.atMs - b.atMs);
  let running = equityStartUsdMicro;
  let peakEquity = equityStartUsdMicro;
  let maxDrawdown = 0n;
  for (const unit of units) {
    running += unit.netUsdMicro;
    if (running > peakEquity) peakEquity = running;
    const drawdown = peakEquity - running;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  running += openUnrealized;
  if (running > peakEquity) peakEquity = running;
  const finalDrawdown = peakEquity - running;
  if (finalDrawdown > maxDrawdown) maxDrawdown = finalDrawdown;

  const exitGroupsMap = new Map<SimExitReason, { units: number; pnl: bigint }>();
  for (const position of positions) {
    for (const unit of position.exitUnits) {
      const row = exitGroupsMap.get(unit.reason) ?? { units: 0, pnl: 0n };
      row.units++;
      row.pnl += unit.netUsdMicro;
      exitGroupsMap.set(unit.reason, row);
    }
  }
  coverage.entryRejections = [...entryRejections.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);

  return {
    metrics: {
      netPnlUsdMicro: realized + openUnrealized,
      realizedPnlUsdMicro: realized,
      openUnrealizedUsdMicro: openUnrealized,
      trades: positions.length,
      exitUnits,
      wins,
      losses,
      winRatePct: closed.length > 0 ? Math.round((wins / closed.length) * 100) : null,
      worstDayUsdMicro: worstDay,
      maxDrawdownUsdMicro: maxDrawdown,
      worstTradeUsdMicro: worstTrade,
      openPositions,
      feesUsdMicro: fees,
    },
    trades: positions,
    hires: [...hireStats.values()],
    exitGroups: [...exitGroupsMap.entries()]
      .map(([reason, row]) => ({
        reason,
        label: EXIT_LABEL[reason],
        units: row.units,
        pnlUsdMicro: row.pnl,
      }))
      .sort((a, b) => Number(b.pnlUsdMicro - a.pnlUsdMicro)),
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Grid and risk labelling
// ---------------------------------------------------------------------------

export type SweepRiskLabel = 'TIGHTENS' | 'LOOSENS' | 'MIXED' | 'UNCHANGED';

const HIGHER_IS_RISKIER = [
  'COPY_SCALE',
  'MAX_PER_BUY_PCT',
  'MAX_OPEN_PER_TRADER_PCT',
  'MAX_DEPLOYED_PCT',
  'STOP_LOSS_BPS',
  'TRAIL_ARM_BPS',
  'TRAIL_DISTANCE_BPS',
  'MAX_POSITION_AGE_HOURS',
  'POSITION_GRACE_HOURS',
  'IDLE_FIRE_HOURS',
  'ROSTER_SIZE',
  'PROMOTION_MAX_LAST_BUY_HOURS',
] as const;
const LOWER_IS_RISKIER = [
  'MIN_PER_BUY_USD',
  'COOLDOWN_HOURS',
  'PROMOTION_MIN_CLOSED',
  'PROMOTION_MIN_NET_USD',
] as const;

export function classifyRiskDirection(
  baselineRisk: RiskConfig,
  baselineSim: SimulationParams,
  candidateRisk: RiskConfig,
  candidateSim: SimulationParams,
): SweepRiskLabel {
  let loosens = false;
  let tightens = false;
  for (const key of HIGHER_IS_RISKIER) {
    if (candidateRisk[key] > baselineRisk[key]) loosens = true;
    if (candidateRisk[key] < baselineRisk[key]) tightens = true;
  }
  for (const key of LOWER_IS_RISKIER) {
    if (candidateRisk[key] < baselineRisk[key]) loosens = true;
    if (candidateRisk[key] > baselineRisk[key]) tightens = true;
  }
  if (candidateRisk.SELL_ON_GREEN !== baselineRisk.SELL_ON_GREEN) {
    if (!candidateRisk.SELL_ON_GREEN) loosens = true;
    else tightens = true;
  }
  const known = new Set<string>([...HIGHER_IS_RISKIER, ...LOWER_IS_RISKIER, 'SELL_ON_GREEN']);
  for (const key of Object.keys(baselineRisk) as Array<keyof RiskConfig>) {
    if (!known.has(key) && candidateRisk[key] !== baselineRisk[key]) return 'MIXED';
  }
  if (
    candidateSim.hiringPolicy !== baselineSim.hiringPolicy ||
    candidateSim.ranking !== baselineSim.ranking
  ) {
    return 'MIXED';
  }
  if (loosens && tightens) return 'MIXED';
  if (loosens) return 'LOOSENS';
  if (tightens) return 'TIGHTENS';
  return 'UNCHANGED';
}

export interface GridRun {
  id: string;
  label: string;
  risk: RiskConfig;
  sim: SimulationParams;
  overrides: Record<string, number | string | boolean>;
  riskLabel: SweepRiskLabel;
}

export interface SweepGrid {
  /** One-factor-at-a-time values; every value is applied alone against baseline. */
  values?: Record<string, Array<number | string | boolean>>;
  /** Hiring policy/ranking alternatives. */
  hiring?: Array<'actual' | 'net' | 'net_per_trade' | 'win_rate' | 'recent'>;
  /** Explicit combinations (each is a partial override). */
  combinations?: Array<Record<string, number | string | boolean>>;
  maxRuns?: number;
}

/**
 * Build candidate runs: OFAT values, hiring alternatives and explicit
 * combinations. Never exceeds `maxRuns` (default 400) so the default sweep
 * stays comfortably under the CLI's time budget.
 */
export function buildSweepRuns(
  baselineRisk: RiskConfig,
  baselineSim: SimulationParams,
  grid: SweepGrid,
): GridRun[] {
  const riskKeys = new Set(Object.keys(baselineRisk));
  const simKeys = new Set([
    'entrySlippageBps',
    'exitSlippageBps',
    'feeBps',
    'delaySeconds',
    'pathStepMinutes',
    'hiringPolicy',
    'ranking',
  ]);
  const assertKey = (key: string) => {
    if (!riskKeys.has(key) && !simKeys.has(key)) {
      throw new Error(`unknown sweep parameter: ${key}`);
    }
  };
  const hiringValues = new Set(['actual', 'net', 'net_per_trade', 'win_rate', 'recent']);
  for (const key of Object.keys(grid.values ?? {})) assertKey(key);
  for (const combo of grid.combinations ?? []) {
    for (const key of Object.keys(combo)) assertKey(key);
  }
  for (const hiring of grid.hiring ?? []) {
    if (!hiringValues.has(hiring)) throw new Error(`unknown hiring policy: ${hiring}`);
  }
  if (grid.maxRuns !== undefined && (!Number.isFinite(grid.maxRuns) || grid.maxRuns < 1)) {
    throw new Error('grid.maxRuns must be a positive number');
  }
  // A promotion/cooldown rule only changes anything if the replay re-picks the
  // bench wallet. Evaluate those runs with the shadow hiring policy so the
  // rule actually reaches `canPromote`.
  const hiringRuleKeys = new Set([
    'PROMOTION_MIN_CLOSED',
    'PROMOTION_MIN_NET_USD',
    'PROMOTION_MAX_LAST_BUY_HOURS',
    'COOLDOWN_HOURS',
  ]);
  const runs: GridRun[] = [];
  const push = (
    label: string,
    riskPatch: Partial<RiskConfig>,
    simPatch: Partial<SimulationParams>,
    overrides: Record<string, number | string | boolean>,
  ) => {
    const risk = { ...baselineRisk, ...riskPatch };
    const sim = { ...baselineSim, ...simPatch };
    runs.push({
      id: label.replace(/[^a-z0-9]+/gi, '_').toLowerCase(),
      label,
      risk,
      sim,
      overrides,
      riskLabel: classifyRiskDirection(baselineRisk, baselineSim, risk, sim),
    });
  };
  for (const [key, values] of Object.entries(grid.values ?? {})) {
    for (const value of values) {
      const base =
        (baselineRisk as unknown as Record<string, unknown>)[key] ??
        (baselineSim as unknown as Record<string, unknown>)[key];
      if (base === value) continue;
      if (key in baselineRisk) {
        const simPatch: Partial<SimulationParams> = {};
        if (hiringRuleKeys.has(key) && (baselineSim.hiringPolicy ?? 'actual') === 'actual') {
          simPatch.hiringPolicy = 'shadow';
          simPatch.ranking = 'net';
        }
        push(`${key}=${String(value)}`, { [key]: value } as Partial<RiskConfig>, simPatch, { [key]: value });
      } else {
        push(`${key}=${String(value)}`, {}, { [key]: value } as Partial<SimulationParams>, { [key]: value });
      }
    }
  }
  for (const hiring of grid.hiring ?? []) {
    const policy = hiring === 'actual' ? 'actual' : 'shadow';
    const ranking = hiring === 'actual' ? 'net' : hiring;
    // The baseline already is the actual hiring policy/ranking.
    if (policy === (baselineSim.hiringPolicy ?? 'actual') && ranking === (baselineSim.ranking ?? 'net')) {
      continue;
    }
    push(`hiring=${hiring}`, {}, { hiringPolicy: policy, ranking }, { hiringPolicy: policy, ranking });
  }
  for (const combo of grid.combinations ?? []) {
    const riskPatch: Partial<RiskConfig> = {};
    const simPatch: Partial<SimulationParams> = {};
    for (const [key, value] of Object.entries(combo)) {
      if (key in baselineRisk) (riskPatch as Record<string, unknown>)[key] = value;
      else (simPatch as Record<string, unknown>)[key] = value;
    }
    if (
      Object.keys(combo).some((key) => hiringRuleKeys.has(key)) &&
      !('hiringPolicy' in combo) &&
      (baselineSim.hiringPolicy ?? 'actual') === 'actual'
    ) {
      simPatch.hiringPolicy = 'shadow';
      simPatch.ranking = 'net';
    }
    push(
      Object.entries(combo)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' + '),
      riskPatch,
      simPatch,
      combo,
    );
  }
  return runs.slice(0, grid.maxRuns ?? 400);
}

export { EXIT_LABEL };
