/**
 * Read-only counterfactual parameter sweep for Copydesk.
 *
 * The service loads historic evidence from a COPY of the desk database, maps
 * it to pure `@zcode-bot/core` signals and hire windows, and replays the real
 * sizing / risk / exit / promotion rules with alternate parameters. It never
 * opens the live database for writing, never calls a provider, and never
 * applies a parameter. Reports are plain JSON + Markdown.
 *
 * Data limits that matter:
 * - shadow trades store an entry and an exit, not intra-trade marks; the
 *   simulator walks a linear price path between them (assumption, not data);
 * - the DB does not store the risk config that was active at each historic
 *   fill; the baseline is the current config unless the caller supplies one;
 * - pool liquidity / price impact per trade is not stored, so slippage is
 *   calibrated from paper fill price vs the leader's print and exposed as a
 *   parameter;
 * - alternate hires are picked at the real seat-open moments but keep the
 *   real seat tenure (a different hire would not have fired identically).
 */

import type { DbHandle } from '@zcode-bot/db';
import { DEFAULT_RISK, riskConfigSchema, type RiskConfig } from '@zcode-bot/config';
import {
  buildSweepRuns,
  canPromote,
  simulateSweep,
  type GridRun,
  type HireWindow,
  type SimMetrics,
  type SimulationParams,
  type SimulationResult,
  type SweepGrid,
  type SweepRiskLabel,
  type SweepSignal,
  STABLE_MINTS,
} from '@zcode-bot/core';
import { usdToMicro } from '@zcode-bot/core';

// ---------------------------------------------------------------------------
// Inputs and dataset
// ---------------------------------------------------------------------------

export interface ParamSweepOptions {
  /** Baseline risk config. Defaults to the code's DEFAULT_RISK. */
  risk?: RiskConfig;
  /** Overrides for the simulator model (slippage, fees, delay, path step). */
  sim?: Partial<SimulationParams>;
  grid?: SweepGrid;
  fromMs?: number;
  toMs?: number;
  equityStartUsdMicro?: bigint;
  top?: number;
  /** Basename only; never a full operator path. */
  sourceDb?: string;
  generatedAtMs?: number;
}

export interface ActualPaperDecision {
  positionId: string;
  activationId: string;
  candidateId: string;
  handle: string;
  mint: string;
  mintSymbol: string | null;
  openedAtMs: number;
  inputUsdMicro: bigint;
  copiedTokenBase: bigint;
  feesUsdMicro: bigint;
  closedAtMs: number | null;
  closeReason: string | null;
  realizedPnlUsdMicro: bigint;
  /** Null when no leader buy could be matched to this position. */
  signalId: string | null;
}

interface BenchCandidate {
  candidateId: string;
  handle: string;
  closedCount: number;
  wins: number;
  netPnlUsdMicro: bigint;
  lastClosedAt: string | null;
  lastFundedBuyAt: string | null;
  lastFiredAt: string | null;
}

interface HireMoment {
  actual: HireWindow;
  activeCandidateIds: string[];
  bench: BenchCandidate[];
}

export interface Calibration {
  entrySlippageBps: number;
  rawEntrySlippageBps: number | null;
  exitSlippageBps: number;
  feeBps: number;
  delaySeconds: number;
  samples: number;
  notes: string[];
}

export interface DatasetCoverage {
  fromIso: string;
  toIso: string;
  shadowRows: number;
  shadowGroups: number;
  shadowSignals: number;
  shadowMissingWatch: number;
  shadowOpenGroups: number;
  paperPositions: number;
  paperSignals: number;
  paperMissingLeaderEvent: number;
  activations: number;
  hireWindows: number;
  fills: number;
  realizedLots: number;
  candidates: number;
  feeLedgerLamports: number | null;
}

export interface SweepDataset {
  sourceDb: string;
  risk: RiskConfig;
  sim: SimulationParams;
  signals: SweepSignal[];
  actualWindows: HireWindow[];
  hireMoments: HireMoment[];
  paperDecisions: ActualPaperDecision[];
  calibration: Calibration;
  coverage: DatasetCoverage;
  fromMs: number;
  toMs: number;
  equityStartUsdMicro: bigint;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type Sqlite = DbHandle['sqlite'];

const all = <T>(sqlite: Sqlite, sql: string, params: unknown[] = []): T[] =>
  sqlite.prepare(sql).all(...params) as unknown as T[];

const one = <T>(sqlite: Sqlite, sql: string, params: unknown[] = []): T | undefined =>
  sqlite.prepare(sql).get(...params) as unknown as T | undefined;

const ms = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = (value: number): string => new Date(value).toISOString();

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

function tokenSymbols(sqlite: Sqlite): Map<string, string> {
  const row = one<{ value: string }>(sqlite, "select value from kv where key = 'token.symbols'");
  if (!row?.value) return new Map();
  try {
    const parsed = JSON.parse(row.value) as Record<string, string>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function candidateHandles(sqlite: Sqlite): Map<string, string> {
  const rows = all<{ candidate_id: string; handle: string }>(
    sqlite,
    'select candidate_id, handle from trader_candidates',
  );
  return new Map(rows.map((row) => [row.candidate_id, row.handle]));
}

interface ShadowRow {
  id: number;
  candidate_id: string;
  mint: string;
  opened_at: string;
  entry_price_usd_micro: string;
  notional_usd_micro: string;
  status: string;
  closed_at: string | null;
  exit_reason: string | null;
  exit_price_usd_micro: string | null;
  pnl_usd_micro: string | null;
}

interface WatchBuyRow {
  candidate_id: string;
  mint: string;
  token_amount_base: string;
  decimals: number;
  block_time: number;
}

interface ObservedRow {
  candidate_id: string;
  activation_id: string;
  mint: string;
  decimals: number;
  token_delta_base: string;
  funding_delta_base: string;
  funding_mint: string | null;
  block_time: number;
  processed_at: string;
}

function observedBuys(sqlite: Sqlite): ObservedRow[] {
  const rows = all<{
    candidate_id: string;
    activation_id: string;
    block_time: number | null;
    processed_at: string;
    detail_json: string | null;
  }>(
    sqlite,
    "select candidate_id, activation_id, block_time, processed_at, detail_json from observed_leader_events where kind = 'swap_buy' order by block_time",
  );
  const out: ObservedRow[] = [];
  for (const row of rows) {
    if (!row.detail_json) continue;
    try {
      const detail = JSON.parse(row.detail_json) as {
        mint?: string;
        mintDecimals?: number;
        tokenDeltaBase?: string;
        fundingDeltaBase?: string;
        fundingMint?: string;
      };
      if (!detail.mint || !detail.tokenDeltaBase || !detail.fundingDeltaBase) continue;
      const blockTime = row.block_time ?? 0;
      if (!Number.isFinite(blockTime) || blockTime <= 0) continue;
      out.push({
        candidate_id: row.candidate_id,
        activation_id: row.activation_id,
        mint: detail.mint,
        decimals: detail.mintDecimals ?? 6,
        // Historic detail JSON serialized bigints as "123n"; normalize here.
        token_delta_base: String(detail.tokenDeltaBase).replace(/n$/, ''),
        funding_delta_base: String(detail.fundingDeltaBase).replace(/n$/, ''),
        funding_mint: detail.fundingMint ?? null,
        block_time: blockTime,
        processed_at: row.processed_at,
      });
    } catch {
      // A malformed historic detail is a data gap, never a guessed signal.
    }
  }
  return out;
}

function buildShadowSignals(
  sqlite: Sqlite,
  handles: Map<string, string>,
): {
  signals: SweepSignal[];
  rows: number;
  groups: number;
  missingWatch: number;
  openGroups: number;
} {
  const rows = all<ShadowRow>(
    sqlite,
    `select id, candidate_id, mint, opened_at, entry_price_usd_micro, notional_usd_micro,
            status, closed_at, exit_reason, exit_price_usd_micro, pnl_usd_micro
       from shadow_trades order by opened_at, id`,
  );
  const buys = all<WatchBuyRow>(
    sqlite,
    `select candidate_id, mint, token_amount_base, decimals, block_time
       from watch_events where side = 'buy' order by id`,
  );
  const buyMap = new Map<string, WatchBuyRow>();
  for (const buy of buys) {
    const key = `${buy.candidate_id}|${buy.mint}|${buy.block_time}`;
    if (!buyMap.has(key) && BigInt(buy.token_amount_base) > 0n) buyMap.set(key, buy);
  }
  const groups = new Map<string, ShadowRow[]>();
  for (const row of rows) {
    const key = `${row.candidate_id}|${row.mint}|${row.opened_at}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const signals: SweepSignal[] = [];
  let missingWatch = 0;
  let openGroups = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    const openedMs = ms(first.opened_at);
    if (openedMs === null) {
      missingWatch++;
      continue;
    }
    const blockTimeSec = Math.floor(openedMs / 1000);
    const watch = buyMap.get(`${first.candidate_id}|${first.mint}|${blockTimeSec}`);
    if (!watch) {
      missingWatch++;
      continue;
    }
    const entryPrice = BigInt(first.entry_price_usd_micro);
    const tokenBase = BigInt(watch.token_amount_base);
    if (entryPrice <= 0n || tokenBase <= 0n || watch.decimals < 0) {
      missingWatch++;
      continue;
    }
    const leaderInput = (tokenBase * entryPrice) / 10n ** BigInt(watch.decimals);
    if (leaderInput <= 0n) {
      missingWatch++;
      continue;
    }
    const open = group.some((row) => row.status === 'open');
    if (open) openGroups++;
    let exitAtMs: number | null = null;
    let exitPriceUsdMicro: bigint | null = null;
    let exitKind: SweepSignal['exitKind'] = 'open';
    if (!open) {
      const closed = group
        .filter((row) => row.closed_at && row.exit_price_usd_micro)
        .sort((a, b) => (a.closed_at! < b.closed_at! ? 1 : -1));
      const latest = closed[0];
      if (latest) {
        exitAtMs = ms(latest.closed_at);
        exitPriceUsdMicro = BigInt(latest.exit_price_usd_micro!);
        exitKind = latest.exit_reason === 'leader_sell' ? 'leader_sell' : 'code_exit';
      }
    }
    signals.push({
      id: `shadow_${first.candidate_id}_${first.mint}_${first.opened_at}`,
      candidateId: first.candidate_id,
      handle: handles.get(first.candidate_id) ?? first.candidate_id,
      mint: first.mint,
      decimals: watch.decimals,
      blockTimeMs: openedMs,
      entryPriceUsdMicro: entryPrice,
      exitAtMs,
      exitPriceUsdMicro,
      exitKind,
      leaderInputUsdMicro: leaderInput,
      source: 'shadow',
    });
  }
  return { signals, rows: rows.length, groups: groups.size, missingWatch, openGroups };
}

interface PositionRow {
  position_id: string;
  activation_id: string;
  candidate_id: string;
  mint: string;
  mint_symbol: string | null;
  status: string;
  input_usd_micro: string;
  copied_token_base: string;
  realized_pnl_usd_micro: string;
  fees_usd_micro: string;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
}

function buildPaperSignals(
  sqlite: Sqlite,
  handles: Map<string, string>,
  symbols: Map<string, string>,
): {
  signals: SweepSignal[];
  decisions: ActualPaperDecision[];
  positions: number;
  missingLeader: number;
} {
  const positions = all<PositionRow>(
    sqlite,
    `select position_id, activation_id, candidate_id, mint, mint_symbol, status,
            input_usd_micro, copied_token_base, realized_pnl_usd_micro, fees_usd_micro,
            opened_at, closed_at, close_reason
       from copied_positions order by opened_at, position_id`,
  );
  const observed = observedBuys(sqlite);
  const signals: SweepSignal[] = [];
  const decisions: ActualPaperDecision[] = [];
  let missingLeader = 0;
  for (const position of positions) {
    const openedAtMs = ms(position.opened_at);
    if (openedAtMs === null) continue;
    const input = BigInt(position.input_usd_micro);
    const copied = BigInt(position.copied_token_base);
    const closedAtMs = ms(position.closed_at);
    const match = observed
      .filter(
        (row) =>
          row.activation_id === position.activation_id &&
          row.mint === position.mint &&
          (row.funding_mint === null || STABLE_MINTS.has(row.funding_mint)) &&
          Math.abs(row.block_time * 1000 - openedAtMs) <= 10 * 60_000,
      )
      .sort(
        (a, b) => Math.abs(a.block_time * 1000 - openedAtMs) - Math.abs(b.block_time * 1000 - openedAtMs),
      )[0];
    let signalId: string | null = null;
    if (!match) {
      missingLeader++;
    } else {
      const tokenDelta = BigInt(match.token_delta_base);
      const fundingDelta = BigInt(match.funding_delta_base);
      const scale = 10n ** BigInt(match.decimals);
      if (tokenDelta > 0n && fundingDelta > 0n) {
        const entryPrice = (fundingDelta * scale) / tokenDelta;
        const leaderInput = fundingDelta;
        let exitAtMs: number | null = null;
        let exitPriceUsdMicro: bigint | null = null;
        let exitKind: SweepSignal['exitKind'] = 'open';
        if (closedAtMs !== null && copied > 0n) {
          exitAtMs = closedAtMs;
          // Gross proceeds: paper realized PnL excludes the fee estimate in the
          // stored lot (fees are a separate column).
          exitPriceUsdMicro = ((input + BigInt(position.realized_pnl_usd_micro)) * scale) / copied;
          exitKind = 'paper_close';
        }
        signalId = `paper_${position.position_id}`;
        signals.push({
          id: signalId,
          candidateId: position.candidate_id,
          handle: handles.get(position.candidate_id) ?? position.candidate_id,
          mint: position.mint,
          decimals: match.decimals,
          blockTimeMs: match.block_time * 1000,
          entryPriceUsdMicro: entryPrice,
          exitAtMs,
          exitPriceUsdMicro,
          exitKind,
          leaderInputUsdMicro: leaderInput,
          source: 'paper',
        });
      } else {
        missingLeader++;
      }
    }
    decisions.push({
      positionId: position.position_id,
      activationId: position.activation_id,
      candidateId: position.candidate_id,
      handle: handles.get(position.candidate_id) ?? position.candidate_id,
      mint: position.mint,
      mintSymbol: position.mint_symbol ?? symbols.get(position.mint) ?? null,
      openedAtMs,
      inputUsdMicro: input,
      copiedTokenBase: copied,
      feesUsdMicro: BigInt(position.fees_usd_micro),
      closedAtMs,
      closeReason: position.close_reason,
      realizedPnlUsdMicro: BigInt(position.realized_pnl_usd_micro),
      signalId,
    });
  }
  return { signals, decisions, positions: positions.length, missingLeader };
}

interface ActivationRow {
  activation_id: string;
  candidate_id: string;
  started_at: string;
  ended_at: string | null;
  source: string;
  state: string;
}

function buildHireMoments(
  sqlite: Sqlite,
  handles: Map<string, string>,
  risk: RiskConfig,
  fromMs: number,
  toMs: number,
): { windows: HireWindow[]; moments: HireMoment[] } {
  const activations = all<ActivationRow>(
    sqlite,
    'select activation_id, candidate_id, started_at, ended_at, source, state from trader_activations order by started_at',
  ).filter((row) => {
    const start = ms(row.started_at);
    const end = ms(row.ended_at);
    return start !== null && start < toMs && (end === null || end > fromMs);
  });
  const shadow = all<{
    candidate_id: string;
    closed_at: string | null;
    pnl_usd_micro: string | null;
    backfilled: number | null;
  }>(
    sqlite,
    'select candidate_id, closed_at, pnl_usd_micro, backfilled from shadow_trades where status = ' +
      "'closed' and closed_at is not null order by closed_at",
  );
  const watchBuys = all<{ candidate_id: string; block_time: number }>(
    sqlite,
    "select candidate_id, block_time from watch_events where side = 'buy' and block_time > 0 order by block_time",
  );
  const firings = all<{ candidate_id: string; fired_at: string }>(
    sqlite,
    'select candidate_id, fired_at from firing_events order by fired_at',
  );
  const byCandidate = new Map<string, typeof shadow>();
  for (const row of shadow) {
    // The live gate judges forward closes only; the admission backfill is
    // ledger evidence, not promotion proof.
    if (row.backfilled === 1) continue;
    const list = byCandidate.get(row.candidate_id) ?? [];
    list.push(row);
    byCandidate.set(row.candidate_id, list);
  }
  const lastBuy = new Map<string, number>();
  for (const row of watchBuys) lastBuy.set(row.candidate_id, row.block_time * 1000);
  const lastFired = new Map<string, number>();
  for (const row of firings) {
    const t = ms(row.fired_at);
    if (t !== null) lastFired.set(row.candidate_id, t);
  }
  const allCandidates = new Set<string>([
    ...byCandidate.keys(),
    ...lastBuy.keys(),
    ...activations.map((row) => row.candidate_id),
  ]);

  const windows: HireWindow[] = [];
  const moments: HireMoment[] = [];
  const sorted = [...activations].sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  for (const row of sorted) {
    const start = ms(row.started_at);
    const end = ms(row.ended_at);
    if (start === null) continue;
    const active = sorted.filter((other) => {
      const otherStart = ms(other.started_at);
      const otherEnd = ms(other.ended_at);
      return otherStart !== null && otherStart < start && (otherEnd === null || otherEnd > start);
    });
    const seat = active.length + 1;
    const window: HireWindow = {
      id: row.activation_id,
      seat,
      candidateId: row.candidate_id,
      handle: handles.get(row.candidate_id) ?? row.candidate_id,
      startMs: start,
      endMs: end,
      startReason: row.source,
    };
    windows.push(window);

    const bench: BenchCandidate[] = [];
    for (const candidateId of allCandidates) {
      const closed = (byCandidate.get(candidateId) ?? []).filter(
        (trade) => trade.closed_at !== null && (ms(trade.closed_at) ?? Infinity) < start,
      );
      const net = closed.reduce((sum, trade) => sum + BigInt(trade.pnl_usd_micro ?? '0'), 0n);
      const wins = closed.filter((trade) => BigInt(trade.pnl_usd_micro ?? '0') > 0n).length;
      const lastClosedAt = closed.reduce<string | null>(
        (latest, trade) => (latest === null || trade.closed_at! > latest ? trade.closed_at! : latest),
        null,
      );
      const buyMs = lastBuy.get(candidateId);
      const firedMs = lastFired.get(candidateId);
      bench.push({
        candidateId,
        handle: handles.get(candidateId) ?? candidateId,
        closedCount: closed.length,
        wins,
        netPnlUsdMicro: net,
        lastClosedAt,
        lastFundedBuyAt: buyMs !== undefined && buyMs < start ? iso(buyMs) : null,
        lastFiredAt: firedMs !== undefined && firedMs < start ? iso(firedMs) : null,
      });
    }
    moments.push({
      actual: window,
      activeCandidateIds: active.map((other) => other.candidate_id),
      bench,
    });
  }
  return { windows, moments };
}

export function calibrateFromPaper(
  sqlite: Sqlite,
  decisions: ActualPaperDecision[],
  observed: ObservedRow[],
  fallback: { entrySlippageBps: number; exitSlippageBps: number; feeBps: number; delaySeconds: number },
): Calibration {
  const entryBps: number[] = [];
  const delays: number[] = [];
  const fees: number[] = [];
  for (const decision of decisions) {
    const match = observed.find(
      (row) =>
        row.activation_id === decision.activationId &&
        row.mint === decision.mint &&
        (row.funding_mint === null || STABLE_MINTS.has(row.funding_mint)) &&
        Math.abs(row.block_time * 1000 - decision.openedAtMs) <= 10 * 60_000,
    );
    if (!match || decision.copiedTokenBase <= 0n || decision.inputUsdMicro <= 0n) continue;
    const tokenDelta = BigInt(match.token_delta_base);
    const funding = BigInt(match.funding_delta_base);
    if (tokenDelta <= 0n || funding <= 0n) continue;
    const scale = 10n ** BigInt(match.decimals);
    const paperPrice = (decision.inputUsdMicro * scale) / decision.copiedTokenBase;
    const leaderPrice = (funding * scale) / tokenDelta;
    if (leaderPrice <= 0n) continue;
    entryBps.push(Number((paperPrice * 10_000n) / leaderPrice - 10_000n));
    delays.push(Math.max(0, (decision.openedAtMs - match.block_time * 1000) / 1000));
    fees.push(Number((decision.feesUsdMicro * 10_000n) / decision.inputUsdMicro));
  }
  const rawEntry = median(entryBps);
  const fee = median(fees);
  const delay = median(delays);
  const notes: string[] = [];
  if (rawEntry === null) {
    notes.push('No paper fill could be paired with a leader print; entry slippage uses the fallback.');
  } else if (rawEntry < 0) {
    notes.push(
      `Paper fills were ${Math.abs(Math.round(rawEntry))} bps better than the leader's print; ` +
        'the replay applies 0 adverse entry slippage, which is conservative.',
    );
  } else {
    notes.push(`Paper fills were ${Math.round(rawEntry)} bps worse than the leader's print.`);
  }
  notes.push(
    'Exit slippage is not observable in the DB (no pre-exit mark); it stays the paper 30 bps assumption.',
  );
  notes.push('Pool depth / price impact per trade is not stored; slippage is a flat calibrated bps.');
  return {
    entrySlippageBps: rawEntry === null ? fallback.entrySlippageBps : Math.max(0, Math.round(rawEntry)),
    rawEntrySlippageBps: rawEntry === null ? null : Math.round(rawEntry),
    exitSlippageBps: fallback.exitSlippageBps,
    feeBps: fee === null ? fallback.feeBps : Math.max(0, Math.round(fee)),
    delaySeconds: delay === null ? fallback.delaySeconds : Math.max(0, Math.round(delay)),
    samples: entryBps.length,
    notes,
  };
}

export function loadSweepDataset(db: DbHandle, options: ParamSweepOptions = {}): SweepDataset {
  const sqlite = db.sqlite;
  const handles = candidateHandles(sqlite);
  const symbols = tokenSymbols(sqlite);
  const risk = options.risk ?? DEFAULT_RISK;
  const shadow = buildShadowSignals(sqlite, handles);
  const paper = buildPaperSignals(sqlite, handles, symbols);
  const observed = observedBuys(sqlite);

  const timestamps: number[] = [];
  for (const signal of [...shadow.signals, ...paper.signals]) timestamps.push(signal.blockTimeMs);
  for (const decision of paper.decisions) {
    timestamps.push(decision.openedAtMs);
    if (decision.closedAtMs !== null) timestamps.push(decision.closedAtMs);
  }
  const activationTimes = all<{ started_at: string; ended_at: string | null }>(
    sqlite,
    'select started_at, ended_at from trader_activations',
  );
  for (const row of activationTimes) {
    const start = ms(row.started_at);
    if (start !== null) timestamps.push(start);
    const end = ms(row.ended_at);
    if (end !== null) timestamps.push(end);
  }
  const now = options.generatedAtMs ?? Date.now();
  const dataMin = timestamps.length > 0 ? Math.min(...timestamps) : now - 24 * 3_600_000;
  const dataMax = timestamps.length > 0 ? Math.max(...timestamps) : now;
  const fromMs = options.fromMs ?? dataMin;
  // Leave room for the copy delay after the last observed block so the last
  // signal is inside the run window instead of falling on the boundary.
  const toMs = options.toMs ?? Math.max(dataMax + 60_000, fromMs + 3_600_000);
  if (fromMs >= toMs) throw new Error('sweep window is empty: from must be before to');
  const equityStartUsdMicro = options.equityStartUsdMicro ?? usdToMicro(100);
  if (equityStartUsdMicro <= 0n) throw new Error('equity start must be positive');

  const calibration = calibrateFromPaper(sqlite, paper.decisions, observed, {
    entrySlippageBps: 0,
    exitSlippageBps: 30,
    feeBps: 5,
    delaySeconds: 2,
  });
  const sim: SimulationParams = {
    entrySlippageBps: calibration.entrySlippageBps,
    exitSlippageBps: calibration.exitSlippageBps,
    feeBps: calibration.feeBps,
    delaySeconds: calibration.delaySeconds,
    pathStepMinutes: 1,
    hiringPolicy: 'actual',
    ranking: 'net',
    ...options.sim,
  };
  const hire = buildHireMoments(sqlite, handles, risk, fromMs, toMs);
  const fills = one<{ c: number }>(sqlite, 'select count(*) c from fills')?.c ?? 0;
  const realizedLots = one<{ c: number }>(sqlite, 'select count(*) c from realized_pnl_lots')?.c ?? 0;
  const candidates = one<{ c: number }>(sqlite, 'select count(*) c from trader_candidates')?.c ?? 0;
  const feeLedgerRow = one<{ value: string }>(sqlite, "select value from kv where key = 'fees.ledger'");
  let feeLedgerLamports: number | null = null;
  if (feeLedgerRow?.value) {
    try {
      const ledger = JSON.parse(feeLedgerRow.value) as { totals?: { feeLamports?: number } };
      if (typeof ledger.totals?.feeLamports === 'number') {
        feeLedgerLamports = ledger.totals.feeLamports;
      }
    } catch {
      feeLedgerLamports = null;
    }
  }

  return {
    sourceDb: options.sourceDb ?? 'database copy',
    risk,
    sim,
    signals: [...shadow.signals, ...paper.signals].sort((a, b) => a.blockTimeMs - b.blockTimeMs),
    actualWindows: hire.windows,
    hireMoments: hire.moments,
    paperDecisions: paper.decisions,
    calibration,
    coverage: {
      fromIso: iso(fromMs),
      toIso: iso(toMs),
      shadowRows: shadow.rows,
      shadowGroups: shadow.groups,
      shadowSignals: shadow.signals.length,
      shadowMissingWatch: shadow.missingWatch,
      shadowOpenGroups: shadow.openGroups,
      paperPositions: paper.positions,
      paperSignals: paper.signals.length,
      paperMissingLeaderEvent: paper.missingLeader,
      activations: activationTimes.length,
      hireWindows: hire.windows.length,
      fills,
      realizedLots,
      candidates,
      feeLedgerLamports,
    },
    fromMs,
    toMs,
    equityStartUsdMicro,
  };
}

// ---------------------------------------------------------------------------
// Alternate hiring
// ---------------------------------------------------------------------------

type HiringPolicy = 'actual' | 'shadow';
type Ranking = 'net' | 'net_per_trade' | 'win_rate' | 'recent';

function rankBench(bench: BenchCandidate[], ranking: Ranking): BenchCandidate[] {
  return [...bench].sort((a, b) => {
    const netA = Number(a.netPnlUsdMicro);
    const netB = Number(b.netPnlUsdMicro);
    if (ranking === 'net')
      return netB - netA || b.closedCount - a.closedCount || a.handle.localeCompare(b.handle);
    if (ranking === 'net_per_trade') {
      const perA = a.closedCount > 0 ? netA / a.closedCount : Number.NEGATIVE_INFINITY;
      const perB = b.closedCount > 0 ? netB / b.closedCount : Number.NEGATIVE_INFINITY;
      return perB - perA || netB - netA || a.handle.localeCompare(b.handle);
    }
    if (ranking === 'win_rate') {
      const winA = a.closedCount > 0 ? a.wins / a.closedCount : -1;
      const winB = b.closedCount > 0 ? b.wins / b.closedCount : -1;
      return winB - winA || netB - netA || a.handle.localeCompare(b.handle);
    }
    const recentA = Math.max(ms(a.lastClosedAt) ?? 0, ms(a.lastFundedBuyAt) ?? 0);
    const recentB = Math.max(ms(b.lastClosedAt) ?? 0, ms(b.lastFundedBuyAt) ?? 0);
    return recentB - recentA || netB - netA || a.handle.localeCompare(b.handle);
  });
}

export function windowsForRun(
  dataset: SweepDataset,
  risk: RiskConfig,
  policy: HiringPolicy,
  ranking: Ranking,
): HireWindow[] {
  if (policy === 'actual') return dataset.actualWindows;
  const windows: HireWindow[] = [];
  const selectedAtStart = new Map<number, Set<string>>();
  const actualHires = dataset.actualWindows.map((window) => ({
    candidateId: window.candidateId,
    startMs: window.startMs,
  }));
  const simulatedHires: Array<{ candidateId: string; startMs: number }> = [];
  for (const moment of [...dataset.hireMoments].sort((a, b) => a.actual.startMs - b.actual.startMs)) {
    const selected = selectedAtStart.get(moment.actual.startMs) ?? new Set<string>();
    selectedAtStart.set(moment.actual.startMs, selected);
    const active = new Set([...moment.activeCandidateIds, ...selected]);
    const eligible = moment.bench.filter((candidate) => {
      if (active.has(candidate.candidateId)) return false;
      const firedMs = candidate.lastFiredAt === null ? null : ms(candidate.lastFiredAt);
      const anotherHiredSinceFire =
        firedMs !== null &&
        [...actualHires, ...simulatedHires].some(
          (hire) =>
            hire.candidateId !== candidate.candidateId &&
            hire.startMs > firedMs &&
            hire.startMs < moment.actual.startMs,
        );
      const decision = canPromote({
        aggregates: {
          closedCount: candidate.closedCount,
          netPnlUsdMicro: candidate.netPnlUsdMicro,
          lastClosedAt: candidate.lastClosedAt,
        },
        lastFundedBuyAt: candidate.lastFundedBuyAt,
        lastFiredAt: candidate.lastFiredAt,
        nowMs: moment.actual.startMs,
        anotherHiredSinceFire,
        freeChair: active.size < risk.ROSTER_SIZE,
        config: {
          promotionMinClosed: risk.PROMOTION_MIN_CLOSED,
          promotionMinNetUsdMicro: usdToMicro(risk.PROMOTION_MIN_NET_USD),
          promotionMaxLastBuyHours: risk.PROMOTION_MAX_LAST_BUY_HOURS,
          promotionMaxClosesPerHour: risk.PROMOTION_MAX_CLOSES_PER_HOUR,
          cooldownHours: risk.COOLDOWN_HOURS,
        },
      });
      return decision.ok;
    });
    const pick = rankBench(eligible, ranking)[0];
    if (!pick && active.has(moment.actual.candidateId)) {
      // The real candidate is already in another chair, and the bench has no
      // eligible alternative: leave this chair empty rather than double-hire.
      continue;
    }
    const chosen = pick ?? {
      candidateId: moment.actual.candidateId,
      handle: moment.actual.handle,
    };
    selected.add(chosen.candidateId);
    simulatedHires.push({ candidateId: chosen.candidateId, startMs: moment.actual.startMs });
    windows.push({
      ...moment.actual,
      id: `${moment.actual.id}_${policy}_${ranking}`,
      candidateId: chosen.candidateId,
      handle: chosen.handle,
      startReason: `${policy} replay (${ranking})`,
    });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

export interface SweepMetricsJson {
  netPnlUsdMicro: string;
  realizedPnlUsdMicro: string;
  openUnrealizedUsdMicro: string;
  trades: number;
  exitUnits: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  worstDayUsdMicro: string;
  maxDrawdownUsdMicro: string;
  worstTradeUsdMicro: string;
  openPositions: number;
  feesUsdMicro: string;
}

export interface RunReport {
  id: string;
  label: string;
  riskLabel: SweepRiskLabel;
  overrides: Record<string, number | string | boolean>;
  train: SweepMetricsJson;
  test: SweepMetricsJson;
  full: SweepMetricsJson;
  robust: boolean;
  sameSign: boolean;
  notes: string[];
  neighbors: Array<{ label: string; testNetPnlUsdMicro: string; testTrades: number }>;
}

export interface HireDelta {
  windowId: string;
  seat: number;
  startIso: string;
  actualHandle: string;
  alternativeHandle: string;
  actualNetUsdMicro: string;
  alternativeNetUsdMicro: string;
  deltaUsdMicro: string;
  changed: boolean;
}

export interface HiringAlternativeReport {
  policy: string;
  ranking: string;
  riskLabel: SweepRiskLabel;
  full: SweepMetricsJson;
  test: SweepMetricsJson;
  hires: HireDelta[];
}

export interface BaselineMatchDetail {
  positionId: string;
  handle: string;
  mintSymbol: string | null;
  signalId: string | null;
  actualInputUsdMicro: string;
  replayInputUsdMicro: string | null;
  inputMatch: boolean;
  entryTimeDeltaSeconds: number | null;
  actualCloseReason: string | null;
  replayExitReason: string | null;
  actualNetUsdMicro: string | null;
  replayNetUsdMicro: string | null;
  exitRuleMatch: boolean;
  exitPnlMatch: boolean;
  exitMatch: boolean;
  note: string;
}

export interface BaselineMatch {
  paperPositions: number;
  withReplaySignal: number;
  entriesCompared: number;
  entryMatches: number;
  exitsCompared: number;
  exitRuleMatches: number;
  exitPnlMatches: number;
  exitMatches: number;
  details: BaselineMatchDetail[];
  note: string;
}

export interface ParamSweepReport {
  schemaVersion: 1;
  kind: 'param-sweep';
  generatedAt: string;
  sourceDb: string;
  mode: 'read-only counterfactual replay';
  range: { fromIso: string; toIso: string; days: number };
  split: { trainToIso: string };
  runsEvaluated: number;
  runsShown: number;
  baseline: RunReport;
  baselineCoverage: {
    signalsTotal: number;
    signalsSeen: number;
    signalsCopied: number;
    skippedNotHired: number;
    skippedCoalesced: number;
    skippedSizing: number;
    skippedRisk: number;
    skippedStale: number;
    entryRejections: Array<{ rule: string; count: number }>;
  };
  alternatives: RunReport[];
  hiringAlternatives: HiringAlternativeReport[];
  baselineMatch: BaselineMatch;
  coverage: DatasetCoverage;
  calibration: Calibration;
  dataGaps: string[];
  assumptions: string[];
  runtimeMs: number;
}

export function metricsJson(metrics: SimMetrics): SweepMetricsJson {
  return {
    netPnlUsdMicro: metrics.netPnlUsdMicro.toString(),
    realizedPnlUsdMicro: metrics.realizedPnlUsdMicro.toString(),
    openUnrealizedUsdMicro: metrics.openUnrealizedUsdMicro.toString(),
    trades: metrics.trades,
    exitUnits: metrics.exitUnits,
    wins: metrics.wins,
    losses: metrics.losses,
    winRatePct: metrics.winRatePct,
    worstDayUsdMicro: metrics.worstDayUsdMicro.toString(),
    maxDrawdownUsdMicro: metrics.maxDrawdownUsdMicro.toString(),
    worstTradeUsdMicro: metrics.worstTradeUsdMicro.toString(),
    openPositions: metrics.openPositions,
    feesUsdMicro: metrics.feesUsdMicro.toString(),
  };
}

function sign(value: bigint): number {
  return value > 0n ? 1 : value < 0n ? -1 : 0;
}

interface Evaluated {
  run: GridRun;
  full: SimulationResult;
  train: SimulationResult;
  test: SimulationResult;
}

function runReport(evaluation: Evaluated, neighbors: RunReport['neighbors']): RunReport {
  const sameSign =
    sign(evaluation.train.metrics.netPnlUsdMicro) === sign(evaluation.test.metrics.netPnlUsdMicro) &&
    sign(evaluation.test.metrics.netPnlUsdMicro) !== 0;
  const notes: string[] = [];
  if (evaluation.test.metrics.trades === 0) {
    notes.push('No trades in the test half; rank it only as weak evidence.');
  } else if (evaluation.test.metrics.trades < 3) {
    notes.push('Fewer than 3 test trades; treat the out-of-sample result as thin.');
  }
  if (!sameSign) notes.push('Train and test P&L do not agree in sign.');
  if (evaluation.run.sim.hiringPolicy === 'shadow' && !('hiringPolicy' in evaluation.run.overrides)) {
    notes.push(
      'Evaluated with shadow bench hiring so this promotion/cooldown rule can change the seat pick.',
    );
  }
  return {
    id: evaluation.run.id,
    label: evaluation.run.label,
    riskLabel: evaluation.run.riskLabel,
    overrides: evaluation.run.overrides,
    train: metricsJson(evaluation.train.metrics),
    test: metricsJson(evaluation.test.metrics),
    full: metricsJson(evaluation.full.metrics),
    robust: sameSign && evaluation.test.metrics.trades >= 3,
    sameSign,
    notes,
    neighbors,
  };
}

function primaryField(run: GridRun): string | null {
  const keys = Object.keys(run.overrides).filter((key) => key !== 'hiringPolicy' && key !== 'ranking');
  return keys.length === 1 ? keys[0]! : null;
}

function neighborsFor(
  evaluation: Evaluated,
  allEvaluations: Evaluated[],
  grid: SweepGrid | undefined,
): RunReport['neighbors'] {
  const field = primaryField(evaluation.run);
  if (!field || !grid?.values?.[field]) return [];
  const values = grid.values[field]!.map((value) => String(value));
  const index = values.indexOf(String(evaluation.run.overrides[field]));
  if (index === -1) return [];
  const out: RunReport['neighbors'] = [];
  for (const offset of [-1, 1]) {
    const value = values[index + offset];
    if (value === undefined) continue;
    const label = `${field}=${value}`;
    const found = allEvaluations.find((item) => item.run.label === label);
    if (!found) continue;
    out.push({
      label,
      testNetPnlUsdMicro: found.test.metrics.netPnlUsdMicro.toString(),
      testTrades: found.test.metrics.trades,
    });
  }
  return out;
}

function baselineMatch(dataset: SweepDataset, baseline: SimulationResult): BaselineMatch {
  const details: BaselineMatchDetail[] = [];
  let entriesCompared = 0;
  let entryMatches = 0;
  let exitsCompared = 0;
  let exitRuleMatches = 0;
  let exitPnlMatches = 0;
  let exitMatches = 0;
  for (const decision of dataset.paperDecisions) {
    if (decision.signalId === null) {
      details.push({
        positionId: decision.positionId,
        handle: decision.handle,
        mintSymbol: decision.mintSymbol,
        signalId: null,
        actualInputUsdMicro: decision.inputUsdMicro.toString(),
        replayInputUsdMicro: null,
        inputMatch: false,
        entryTimeDeltaSeconds: null,
        actualCloseReason: decision.closeReason,
        replayExitReason: null,
        actualNetUsdMicro:
          decision.closedAtMs === null
            ? null
            : (decision.realizedPnlUsdMicro - decision.feesUsdMicro).toString(),
        replayNetUsdMicro: null,
        exitRuleMatch: false,
        exitPnlMatch: false,
        exitMatch: false,
        note: 'No leader buy could be matched to this paper position; it is not replayed.',
      });
      continue;
    }
    const trade = baseline.trades.find((item) => item.signalId === decision.signalId);
    if (!trade) {
      details.push({
        positionId: decision.positionId,
        handle: decision.handle,
        mintSymbol: decision.mintSymbol,
        signalId: decision.signalId,
        actualInputUsdMicro: decision.inputUsdMicro.toString(),
        replayInputUsdMicro: null,
        inputMatch: false,
        entryTimeDeltaSeconds: null,
        actualCloseReason: decision.closeReason,
        replayExitReason: null,
        actualNetUsdMicro:
          decision.closedAtMs === null
            ? null
            : (decision.realizedPnlUsdMicro - decision.feesUsdMicro).toString(),
        replayNetUsdMicro: null,
        exitRuleMatch: false,
        exitPnlMatch: false,
        exitMatch: false,
        note: 'The signal existed but was not copied (not hired, stale, sized out or risk-blocked).',
      });
      continue;
    }
    entriesCompared++;
    const inputMatch = trade.notionalUsdMicro === decision.inputUsdMicro;
    if (inputMatch) entryMatches++;
    const lastExit = [...trade.exitUnits].sort((a, b) => a.atMs - b.atMs).at(-1) ?? null;
    const actualNet =
      decision.closedAtMs === null ? null : decision.realizedPnlUsdMicro - decision.feesUsdMicro;
    let exitRuleMatch = false;
    let exitPnlMatch = false;
    let note = '';
    if (decision.closedAtMs !== null) {
      exitsCompared++;
      if (!trade.open && lastExit && actualNet !== null) {
        const actualRule = (decision.closeReason ?? '').toLowerCase();
        const replayRule = lastExit.reason;
        const timeRules = new Set(['max_hold_green', 'grace_green', 'grace_bounce', 'grace_expired']);
        exitRuleMatch =
          actualRule === replayRule ||
          (actualRule === 'time_exit' && timeRules.has(replayRule)) ||
          (actualRule === 'leader_exit' && replayRule === 'leader_sell') ||
          (actualRule === 'fire_close_all' && replayRule === 'fire_close');
        const tolerance =
          (actualNet < 0n ? -actualNet : actualNet) / 10n > 250_000n
            ? (actualNet < 0n ? -actualNet : actualNet) / 10n
            : 250_000n;
        const delta = trade.netUsdMicro - actualNet;
        const timingDelta = Math.abs(lastExit.atMs - decision.closedAtMs);
        exitPnlMatch = (delta < 0n ? -delta : delta) <= tolerance && timingDelta <= 2 * 3_600_000;
        if (!exitRuleMatch) {
          note =
            `Replay exit ${lastExit.reason} vs actual ${decision.closeReason ?? 'close'}; ` + `rule differs.`;
        } else if (!exitPnlMatch) {
          note =
            `Exit rule matched (${lastExit.reason}); P&L differs by ` +
            `${formatSignedUsd(delta)} because size/price inputs differ.`;
        }
      } else {
        note = 'Replay position is still open or has no exit unit.';
      }
      if (exitRuleMatch) exitRuleMatches++;
      if (exitPnlMatch) exitPnlMatches++;
      if (exitRuleMatch && exitPnlMatch) exitMatches++;
    }
    if (!inputMatch) {
      note =
        `Replay input ${formatUsd(trade.notionalUsdMicro)} vs actual ` +
        `${formatUsd(decision.inputUsdMicro)}; a historic risk config or a quote difference ` +
        `can explain it. ${note}`.trim();
    }
    details.push({
      positionId: decision.positionId,
      handle: decision.handle,
      mintSymbol: decision.mintSymbol,
      signalId: decision.signalId,
      actualInputUsdMicro: decision.inputUsdMicro.toString(),
      replayInputUsdMicro: trade.notionalUsdMicro.toString(),
      inputMatch,
      entryTimeDeltaSeconds: Math.round((trade.openedAtMs - decision.openedAtMs) / 1000),
      actualCloseReason: decision.closeReason,
      replayExitReason: lastExit?.reason ?? null,
      actualNetUsdMicro: actualNet === null ? null : actualNet.toString(),
      replayNetUsdMicro: trade.netUsdMicro.toString(),
      exitRuleMatch,
      exitPnlMatch,
      exitMatch: exitRuleMatch && exitPnlMatch,
      note,
    });
  }
  const note =
    details.length === 0
      ? 'No paper positions in this DB copy; entry/exit match is 0/0 (not applicable).'
      : `${entryMatches}/${entriesCompared} entries match exact input; ` +
        `${exitRuleMatches}/${exitsCompared} exit rules match the historic close; ` +
        `${exitPnlMatches}/${exitsCompared} exit P&L values match within 10% or $0.25 ` +
        '(and close times within 2h).';
  return {
    paperPositions: dataset.paperDecisions.length,
    withReplaySignal: dataset.paperDecisions.filter((decision) => decision.signalId !== null).length,
    entriesCompared,
    entryMatches,
    exitsCompared,
    exitRuleMatches,
    exitPnlMatches,
    exitMatches,
    details,
    note,
  };
}

function formatUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const dollars = abs / 1_000_000n;
  const cents = (abs % 1_000_000n) / 10_000n;
  return `${negative ? '-' : ''}$${dollars.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}

function formatSignedUsd(micro: bigint): string {
  return `${micro > 0n ? '+' : ''}${formatUsd(micro)}`;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export function buildSweepReport(dataset: SweepDataset, options: ParamSweepOptions = {}): ParamSweepReport {
  const started = Date.now();
  const topCount = options.top ?? 10;
  if (!Number.isInteger(topCount) || topCount < 1) {
    throw new Error('top must be a positive integer');
  }
  const grid: SweepGrid = options.grid ?? defaultSweepGrid();
  const baselineRun: GridRun = {
    id: 'baseline',
    label: 'CURRENT PARAMS',
    risk: dataset.risk,
    sim: dataset.sim,
    overrides: {},
    riskLabel: 'UNCHANGED',
  };
  const runs = [baselineRun, ...buildSweepRuns(dataset.risk, dataset.sim, grid)];
  for (const run of runs) {
    // Fail closed on a grid that would produce a risk config the desk itself
    // would refuse; do not replay an impossible parameter set.
    const parsed = riskConfigSchema.safeParse(run.risk);
    if (!parsed.success) {
      throw new Error(`invalid risk parameters in sweep run "${run.label}": ${parsed.error.message}`);
    }
  }
  const midMs = dataset.fromMs + Math.floor((dataset.toMs - dataset.fromMs) / 2);
  const evaluations: Evaluated[] = [];
  for (const run of runs) {
    const policy: HiringPolicy = run.sim.hiringPolicy === 'shadow' ? 'shadow' : 'actual';
    const ranking: Ranking = run.sim.ranking ?? 'net';
    const windows = windowsForRun(dataset, run.risk, policy, ranking);
    const simulate = (fromMs: number, toMs: number) =>
      simulateSweep({
        signals: dataset.signals,
        hireWindows: windows,
        risk: run.risk,
        sim: run.sim,
        fromMs,
        toMs,
        equityStartUsdMicro: dataset.equityStartUsdMicro,
      });
    evaluations.push({
      run,
      full: simulate(dataset.fromMs, dataset.toMs),
      train: simulate(dataset.fromMs, midMs),
      test: simulate(midMs, dataset.toMs),
    });
  }
  const baselineEvaluation = evaluations[0]!;
  const alternatives = evaluations.slice(1);
  const ranked = [...alternatives].sort((a, b) => {
    const testDiff = b.test.metrics.netPnlUsdMicro - a.test.metrics.netPnlUsdMicro;
    if (testDiff !== 0n) return testDiff > 0n ? 1 : -1;
    const fullDiff = b.full.metrics.netPnlUsdMicro - a.full.metrics.netPnlUsdMicro;
    if (fullDiff !== 0n) return fullDiff > 0n ? 1 : -1;
    return a.run.label.localeCompare(b.run.label);
  });
  // With no trades anywhere, ranking by P&L is noise; show the empty baseline
  // and say so rather than presenting an arbitrary order.
  const tradeful = ranked.filter(
    (evaluation) => evaluation.full.metrics.trades > 0 || evaluation.test.metrics.trades > 0,
  );
  const top = tradeful.slice(0, topCount);
  const baselineReport = runReport(baselineEvaluation, []);
  const topReports = top.map((evaluation) =>
    runReport(evaluation, neighborsFor(evaluation, evaluations, grid)),
  );
  const baselineHires = new Map(
    baselineEvaluation.full.hires.map((hire) => [`${hire.seat}|${hire.startMs}`, hire]),
  );
  const hiringAlternatives: HiringAlternativeReport[] = alternatives
    .filter(
      (evaluation) =>
        evaluation.run.sim.hiringPolicy === 'shadow' && 'hiringPolicy' in evaluation.run.overrides,
    )
    .map((evaluation) => {
      const hires: HireDelta[] = evaluation.full.hires.map((hire) => {
        const actual = baselineHires.get(`${hire.seat}|${hire.startMs}`);
        const delta = hire.netUsdMicro - (actual?.netUsdMicro ?? 0n);
        return {
          windowId: hire.windowId,
          seat: hire.seat,
          startIso: iso(hire.startMs),
          actualHandle: actual?.handle ?? '(none)',
          alternativeHandle: hire.handle,
          actualNetUsdMicro: (actual?.netUsdMicro ?? 0n).toString(),
          alternativeNetUsdMicro: hire.netUsdMicro.toString(),
          deltaUsdMicro: delta.toString(),
          changed: actual?.candidateId !== hire.candidateId,
        };
      });
      hires.sort((a, b) => (BigInt(b.deltaUsdMicro) > BigInt(a.deltaUsdMicro) ? 1 : -1));
      return {
        policy: evaluation.run.sim.hiringPolicy ?? 'shadow',
        ranking: evaluation.run.sim.ranking ?? 'net',
        riskLabel: evaluation.run.riskLabel,
        full: metricsJson(evaluation.full.metrics),
        test: metricsJson(evaluation.test.metrics),
        hires,
      };
    });

  const match = baselineMatch(dataset, baselineEvaluation.full);
  const dataGaps = buildDataGaps(dataset, baselineEvaluation, match, grid, top.length);
  return {
    schemaVersion: 1,
    kind: 'param-sweep',
    generatedAt: iso(options.generatedAtMs ?? Date.now()),
    sourceDb: dataset.sourceDb,
    mode: 'read-only counterfactual replay',
    range: {
      fromIso: iso(dataset.fromMs),
      toIso: iso(dataset.toMs),
      days: Math.round(((dataset.toMs - dataset.fromMs) / 86_400_000) * 10) / 10,
    },
    split: { trainToIso: iso(midMs) },
    runsEvaluated: evaluations.length,
    runsShown: topReports.length,
    baseline: baselineReport,
    baselineCoverage: {
      signalsTotal: dataset.signals.length,
      signalsSeen: baselineEvaluation.full.coverage.signalsSeen,
      signalsCopied: baselineEvaluation.full.coverage.signalsCopied,
      skippedNotHired: baselineEvaluation.full.coverage.skippedNotHired,
      skippedCoalesced: baselineEvaluation.full.coverage.skippedCoalesced,
      skippedSizing: baselineEvaluation.full.coverage.skippedSizing,
      skippedRisk: baselineEvaluation.full.coverage.skippedRisk,
      skippedStale: baselineEvaluation.full.coverage.skippedStale,
      entryRejections: baselineEvaluation.full.coverage.entryRejections,
    },
    alternatives: topReports,
    hiringAlternatives,
    baselineMatch: match,
    coverage: dataset.coverage,
    calibration: dataset.calibration,
    dataGaps,
    assumptions: [
      'The DB stores the leader entry and exit, never intra-trade marks; the replay walks a linear price path between them at 1-minute steps.',
      'A leader exit inside the run window is mirrored; a shadow code exit or paper close is only a last-known mark (path end), so an alternate rule is not forced to obey it.',
      'A leader exit after the run window is not used (no future price); the position is marked at its entry price and reported open.',
      'The historical risk config is not stored; the baseline is the current config supplied to the sweep.',
      'Copy delay shifts the entry time, but the path starts at the leader print; no separate delay price impact is stored.',
      'Price and leaderboard freshness gates see age 0 because the DB does not store historic quote/leaderboard ages; quote-impact gates are not evaluated.',
      'Max drawdown and worst day are realized-PnL measures plus the final open mark, not intra-trade mark-to-market.',
      'Alternate hires use the real seat-open times and seat tenure; a different hire would have changed future firing times.',
      'A hired wallet stops being shadowed, so the actual hire has no in-seat shadow signal while an alternate bench wallet may have one. Hiring comparisons are indicative, not like-for-like P&L.',
      'Signals are watch-list shadow buys plus paper fills; a live seat with neither contributes no baseline trade.',
      'No provider calls, no live trading, no parameter application. Slippage/fees are flat calibrated bps, not a pool-depth model.',
      'MAX_POSITION_AGE_HOURS=8760 in the default grid is the practical "none" value (one year); it is not infinite.',
      'Seat tenure is pinned to the historic activations: roster size and idle-fire values have no mechanical effect here; cooldown and promotion bars can change alternative hires.',
      'Fees paid in SOL are excluded from USDC P&L; paper fills are simulated and labeled PAPER.',
    ],
    runtimeMs: Date.now() - started,
  };
}

function buildDataGaps(
  dataset: SweepDataset,
  baseline: Evaluated,
  match: BaselineMatch,
  grid: SweepGrid,
  alternativesShown: number,
): string[] {
  const gaps: string[] = [];
  if (dataset.paperDecisions.length === 0) {
    gaps.push('No paper positions in this DB copy; baseline replay match is not applicable.');
  } else if (dataset.paperDecisions.length < 3) {
    gaps.push(
      `Only ${dataset.paperDecisions.length} paper position(s); the baseline similarity is a thin sample.`,
    );
  }
  if (dataset.coverage.shadowMissingWatch > 0) {
    gaps.push(
      `${dataset.coverage.shadowMissingWatch} shadow group(s) had no exact watch-buy match; their ` +
        'leader input could not be reconstructed, so they were skipped.',
    );
  }
  if (dataset.coverage.paperMissingLeaderEvent > 0) {
    gaps.push(
      `${dataset.coverage.paperMissingLeaderEvent} paper position(s) had no observed leader buy; ` +
        'they are reported but not replayed.',
    );
  }
  if (baseline.full.metrics.trades === 0) {
    gaps.push(
      'The baseline copied no trade: the watch list stops shadowing a hired wallet, so in-seat ' +
        'shadow buys are usually absent, and this DB copy has no paper fills to supply them. ' +
        'That is a coverage result, not a simulator failure.',
    );
  }
  if (baseline.test.metrics.trades < 3) {
    gaps.push(
      `The test half has ${baseline.test.metrics.trades} baseline trade(s); out-of-sample ranking is thin.`,
    );
  }
  if (match.entryMatches < match.entriesCompared) {
    gaps.push(
      `${match.entriesCompared - match.entryMatches} baseline entry input(s) differ from the real ` +
        'paper fill; a historic risk config or execution quote is the likely cause.',
    );
  }
  if (!grid.values || Object.keys(grid.values).length === 0) {
    gaps.push('No parameter grid values were supplied; only the baseline ran.');
  }
  if (alternativesShown === 0) {
    gaps.push(
      'No run produced a trade on this history, so the grid has nothing to rank; ' +
        'the empty baseline is reported instead of an arbitrary winner.',
    );
  }
  return gaps;
}

export function defaultSweepGrid(): SweepGrid {
  return {
    values: {
      STOP_LOSS_BPS: [1500, 2000, 2500, 3000, 3500],
      TRAIL_ARM_BPS: [1000, 1500, 2000, 2500],
      TRAIL_DISTANCE_BPS: [500, 1000, 1500, 2000],
      MAX_POSITION_AGE_HOURS: [3, 5, 8, 12, 8760],
      COPY_SCALE: [0.1, 0.25, 0.5, 0.75, 1],
      MIN_PER_BUY_USD: [1, 2, 5, 10],
      MAX_PER_BUY_PCT: [5, 10, 20, 40],
      MAX_OPEN_PER_TRADER_PCT: [10, 20, 40, 80],
      MAX_DEPLOYED_PCT: [25, 50, 80, 100],
      IDLE_FIRE_HOURS: [4, 8, 12, 24],
      COOLDOWN_HOURS: [1, 6, 12, 24],
      PROMOTION_MIN_CLOSED: [4, 8, 12, 20],
      PROMOTION_MIN_NET_USD: [1, 3, 5, 10],
      PROMOTION_MAX_LAST_BUY_HOURS: [1, 4, 8, 24],
      ROSTER_SIZE: [3, 4, 5, 6],
      SELL_ON_GREEN: [true, false],
    },
    hiring: ['actual', 'net', 'net_per_trade', 'win_rate', 'recent'],
    combinations: [
      { STOP_LOSS_BPS: 2000, TRAIL_ARM_BPS: 1000, TRAIL_DISTANCE_BPS: 500 },
      { STOP_LOSS_BPS: 3000, TRAIL_ARM_BPS: 2000, TRAIL_DISTANCE_BPS: 1500 },
      { MAX_PER_BUY_PCT: 20, MAX_OPEN_PER_TRADER_PCT: 80, MAX_DEPLOYED_PCT: 100 },
    ],
    maxRuns: 400,
  };
}

// ---------------------------------------------------------------------------
// Markdown + files
// ---------------------------------------------------------------------------

export function renderSweepMarkdown(report: ParamSweepReport): string {
  const lines: string[] = [];
  const day = report.generatedAt.slice(0, 10);
  lines.push(`# Copydesk counterfactual parameter sweep — ${day}`);
  lines.push('');
  lines.push('> Read-only replay of historic evidence. **Nothing here was applied**; no trading');
  lines.push('> parameter, order, wallet or live setting was changed. Paper fills are simulated.');
  lines.push('');
  lines.push(`- Source: \`${report.sourceDb}\` (read-only copy)`);
  lines.push(`- Data range: ${report.range.fromIso} → ${report.range.toIso} (${report.range.days} days)`);
  lines.push(`- Split: train ends ${report.split.trainToIso}; test follows`);
  lines.push(
    `- Runtime: ${(report.runtimeMs / 1000).toFixed(1)}s; ${report.runsEvaluated} run(s) evaluated, ` +
      `${report.runsShown} alternative(s) shown`,
  );
  lines.push('');
  lines.push('## Baseline (current parameters)');
  lines.push('');
  lines.push(metricsTable(report.baseline));
  lines.push('');
  lines.push('### Baseline replay coverage');
  lines.push('');
  lines.push(
    `Signals ${report.baselineCoverage.signalsTotal}; inside the run window ` +
      `${report.baselineCoverage.signalsSeen}; copied ${report.baselineCoverage.signalsCopied}; ` +
      `not hired ${report.baselineCoverage.skippedNotHired}; coalesced ${report.baselineCoverage.skippedCoalesced}; ` +
      `sized out ${report.baselineCoverage.skippedSizing}; risk-blocked ${report.baselineCoverage.skippedRisk}; ` +
      `stale ${report.baselineCoverage.skippedStale}.`,
  );
  if (report.baselineCoverage.entryRejections.length > 0) {
    lines.push('');
    lines.push(
      'Entry rejections: ' +
        report.baselineCoverage.entryRejections.map((row) => `${row.rule} x${row.count}`).join(', '),
    );
  }
  lines.push('');
  lines.push('## Top alternatives by test-half net P&L');
  lines.push('');
  lines.push('Ranked out-of-sample (test half). A positive train and test half is required for the');
  lines.push('`robust` flag; a run with fewer than 3 test trades is never flagged robust.');
  lines.push('');
  if (report.alternatives.length === 0) {
    lines.push(
      'No run produced a trade on this history, so there is no meaningful ranking. ' +
        'The empty baseline above is the whole result; this is a data-coverage outcome, not a winner.',
    );
    lines.push('');
  } else {
    lines.push(
      '| # | Change | Risk | Train net | Test net | Full net | Trades | Win rate | Worst day | Max DD | Worst trade | Robust |',
    );
    lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    report.alternatives.forEach((run, index) => {
      lines.push(
        `| ${index + 1} | ${escapeCell(run.label)} | ${run.riskLabel} | ${formatUsd(BigInt(run.train.netPnlUsdMicro))} | ` +
          `${formatUsd(BigInt(run.test.netPnlUsdMicro))} | ${formatUsd(BigInt(run.full.netPnlUsdMicro))} | ` +
          `${run.full.trades} | ${pct(run.full.winRatePct)} | ${formatUsd(BigInt(run.full.worstDayUsdMicro))} | ` +
          `${formatUsd(BigInt(run.full.maxDrawdownUsdMicro))} | ${formatUsd(BigInt(run.full.worstTradeUsdMicro))} | ` +
          `${run.robust ? 'YES' : 'no'} |`,
      );
    });
    lines.push('');
  }
  if (report.alternatives[0]) {
    lines.push(`### Top alternative detail: ${escapeCell(report.alternatives[0].label)}`);
    lines.push('');
    lines.push(metricsTable(report.alternatives[0]));
    lines.push('');
    if (report.alternatives[0].notes.length > 0) {
      for (const note of report.alternatives[0].notes) lines.push(`- ${note}`);
      lines.push('');
    }
  }
  const neighborRuns = report.alternatives.filter((run) => run.neighbors.length > 0).slice(0, 6);
  if (neighborRuns.length > 0) {
    lines.push('## Robustness: neighbouring grid values');
    lines.push('');
    lines.push('| Change | Neighbour | Neighbour test net | Test trades |');
    lines.push('|---|---|---:|---:|');
    for (const run of neighborRuns) {
      for (const neighbor of run.neighbors) {
        lines.push(
          `| ${escapeCell(run.label)} | ${escapeCell(neighbor.label)} | ` +
            `${formatUsd(BigInt(neighbor.testNetPnlUsdMicro))} | ${neighbor.testTrades} |`,
        );
      }
    }
    lines.push('');
  }
  if (report.hiringAlternatives.length > 0) {
    lines.push('## Hiring alternatives');
    lines.push('');
    lines.push("Alternate bench wallets were picked at the real seat-open moments under the run's promotion");
    lines.push('bars and ranking, then held for the real seat tenure.');
    lines.push('');
    lines.push('| Policy | Ranking | Risk | Test net | Full net | Hires that would earn more |');
    lines.push('|---|---|---|---:|---:|---:|');
    for (const alt of report.hiringAlternatives) {
      const better = alt.hires.filter((hire) => BigInt(hire.deltaUsdMicro) > 0n).length;
      lines.push(
        `| ${alt.policy} | ${alt.ranking} | ${alt.riskLabel} | ${formatUsd(BigInt(alt.test.netPnlUsdMicro))} | ` +
          `${formatUsd(BigInt(alt.full.netPnlUsdMicro))} | ${better}/${alt.hires.length} |`,
      );
    }
    lines.push('');
    const notable = report.hiringAlternatives[0];
    if (notable) {
      lines.push('### Largest hire deltas (best alternate ranking)');
      lines.push('');
      lines.push('| Seat | Window open | Actual hire | Alternative | Actual net | Alternative net | Delta |');
      lines.push('|---:|---|---|---|---:|---:|---:|');
      for (const hire of notable.hires.slice(0, 8)) {
        lines.push(
          `| ${hire.seat} | ${hire.startIso} | ${escapeCell(hire.actualHandle)} | ` +
            `${escapeCell(hire.alternativeHandle)} | ${formatUsd(BigInt(hire.actualNetUsdMicro))} | ` +
            `${formatUsd(BigInt(hire.alternativeNetUsdMicro))} | ${formatSignedUsd(BigInt(hire.deltaUsdMicro))} |`,
        );
      }
      lines.push('');
    }
  }
  lines.push('## Baseline replay match');
  lines.push('');
  lines.push(report.baselineMatch.note);
  lines.push('');
  if (report.baselineMatch.details.length > 0) {
    lines.push(
      '| Position | Handle | Actual input | Replay input | Match | Actual close | Replay exit | Actual net | Replay net | Exit rule | Exit P&L |',
    );
    lines.push('|---|---|---:|---:|---|---|---|---:|---:|---|---|');
    for (const detail of report.baselineMatch.details) {
      lines.push(
        `| ${detail.mintSymbol ?? detail.positionId.slice(0, 12)} | ${escapeCell(detail.handle)} | ` +
          `${formatUsd(BigInt(detail.actualInputUsdMicro))} | ` +
          `${detail.replayInputUsdMicro === null ? '—' : formatUsd(BigInt(detail.replayInputUsdMicro))} | ` +
          `${detail.inputMatch ? 'yes' : 'no'} | ${detail.actualCloseReason ?? 'open'} | ` +
          `${detail.replayExitReason ?? 'open'} | ` +
          `${detail.actualNetUsdMicro === null ? '—' : formatUsd(BigInt(detail.actualNetUsdMicro))} | ` +
          `${detail.replayNetUsdMicro === null ? '—' : formatUsd(BigInt(detail.replayNetUsdMicro))} | ` +
          `${detail.exitRuleMatch ? 'yes' : 'no'} | ${detail.exitPnlMatch ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
    for (const detail of report.baselineMatch.details) {
      if (detail.note) lines.push(`- ${detail.mintSymbol ?? detail.positionId}: ${detail.note}`);
    }
    lines.push('');
  }
  lines.push('## Calibration');
  lines.push('');
  lines.push(
    `- Entry slippage: ${report.calibration.entrySlippageBps} bps applied` +
      `${report.calibration.rawEntrySlippageBps === null ? '' : ` (raw ${report.calibration.rawEntrySlippageBps} bps)`}; ` +
      `${report.calibration.samples} paper/leader pair(s).`,
  );
  lines.push(
    `- Exit slippage: ${report.calibration.exitSlippageBps} bps; fee: ${report.calibration.feeBps} bps; delay: ${report.calibration.delaySeconds}s.`,
  );
  for (const note of report.calibration.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('## Data coverage');
  lines.push('');
  lines.push('| Evidence | Count |');
  lines.push('|---|---:|');
  lines.push(
    `| Shadow trade rows / groups / replayed signals | ${report.coverage.shadowRows} / ${report.coverage.shadowGroups} / ${report.coverage.shadowSignals} |`,
  );
  lines.push(`| Shadow groups without an exact watch-buy match | ${report.coverage.shadowMissingWatch} |`);
  lines.push(
    `| Paper positions / replayed signals / missing leader buy | ${report.coverage.paperPositions} / ${report.coverage.paperSignals} / ${report.coverage.paperMissingLeaderEvent} |`,
  );
  lines.push(
    `| Activations / hire windows | ${report.coverage.activations} / ${report.coverage.hireWindows} |`,
  );
  lines.push(`| Paper fills / realized lots | ${report.coverage.fills} / ${report.coverage.realizedLots} |`);
  lines.push(`| Candidates in the DB | ${report.coverage.candidates} |`);
  lines.push(
    `| Operator SOL fee ledger | ${
      report.coverage.feeLedgerLamports === null
        ? 'not present'
        : `${report.coverage.feeLedgerLamports.toLocaleString('en-US')} lamports (excluded from USD P&L)`
    } |`,
  );
  lines.push('');
  lines.push('## Data gaps');
  lines.push('');
  for (const gap of report.dataGaps) lines.push(`- ${gap}`);
  lines.push('');
  lines.push('## Assumptions');
  lines.push('');
  for (const assumption of report.assumptions) lines.push(`- ${assumption}`);
  lines.push('');
  lines.push('## Suggested next step');
  lines.push('');
  lines.push('Review the top test-half run and its neighbours with Copytrader. Any parameter change is a');
  lines.push('separate, explicit operator action; this report never applies one.');
  lines.push('');
  return lines.join('\n');
}

function metricsTable(run: RunReport): string {
  return [
    '| Window | Net P&L | Trades | Win rate | Worst day | Max drawdown | Worst trade |',
    '|---|---:|---:|---:|---:|---:|---:|',
    `| Full | ${formatUsd(BigInt(run.full.netPnlUsdMicro))} | ${run.full.trades} | ${pct(run.full.winRatePct)} | ${formatUsd(BigInt(run.full.worstDayUsdMicro))} | ${formatUsd(BigInt(run.full.maxDrawdownUsdMicro))} | ${formatUsd(BigInt(run.full.worstTradeUsdMicro))} |`,
    `| Train | ${formatUsd(BigInt(run.train.netPnlUsdMicro))} | ${run.train.trades} | ${pct(run.train.winRatePct)} | ${formatUsd(BigInt(run.train.worstDayUsdMicro))} | ${formatUsd(BigInt(run.train.maxDrawdownUsdMicro))} | ${formatUsd(BigInt(run.train.worstTradeUsdMicro))} |`,
    `| Test | ${formatUsd(BigInt(run.test.netPnlUsdMicro))} | ${run.test.trades} | ${pct(run.test.winRatePct)} | ${formatUsd(BigInt(run.test.worstDayUsdMicro))} | ${formatUsd(BigInt(run.test.maxDrawdownUsdMicro))} | ${formatUsd(BigInt(run.test.worstTradeUsdMicro))} |`,
  ].join('\n');
}

export { formatUsd, formatSignedUsd };
