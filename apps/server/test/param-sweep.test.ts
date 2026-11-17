import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import {
  buildSweepReport,
  loadSweepDataset,
  renderSweepMarkdown,
  type ParamSweepOptions,
} from '../src/services/paramSweep.js';

const T0 = Date.parse('2026-11-15T06:00:00.000Z');
const HOUR = 3_600_000;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const M1 = 'MintOne111111111111111111111111111111111111';
const M2 = 'MintTwo111111111111111111111111111111111111';

let dir: string;
let handle: DbHandle;

function insertCandidate(id: string, handleName: string) {
  handle.sqlite
    .prepare(
      `insert into trader_candidates (candidate_id, handle, enabled, source, observed_at, created_at, updated_at)
       values (?, ?, 1, 'test', ?, ?, ?)`,
    )
    .run(id, handleName, new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0).toISOString());
}

function insertWatchBuy(candidateId: string, mint: string, blockSec: number, tokenBase: string) {
  handle.sqlite
    .prepare(
      `insert into watch_events
         (candidate_id, address, signature, side, mint, token_amount_base, decimals, usd_micro, block_time, observed_at, source)
       values (?, ?, ?, 'buy', ?, ?, 6, '0', ?, ?, 'watch-poll')`,
    )
    .run(
      candidateId,
      'addr_' + candidateId,
      'sig_' + candidateId + '_' + blockSec + '_' + mint,
      mint,
      tokenBase,
      blockSec,
      new Date(blockSec * 1000).toISOString(),
    );
}

function insertShadow(input: {
  candidateId: string;
  mint: string;
  openedAt: string;
  entryPrice: string;
  notional: string;
  status: 'open' | 'closed';
  closedAt?: string;
  exitReason?: string;
  exitPrice?: string;
  pnl?: string;
  backfilled?: boolean;
}) {
  handle.sqlite
    .prepare(
      `insert into shadow_trades
         (candidate_id, mint, opened_at, entry_price_usd_micro, notional_usd_micro, status,
          closed_at, exit_reason, exit_price_usd_micro, pnl_usd_micro, backfilled)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.candidateId,
      input.mint,
      input.openedAt,
      input.entryPrice,
      input.notional,
      input.status,
      input.closedAt ?? null,
      input.exitReason ?? null,
      input.exitPrice ?? null,
      input.pnl ?? null,
      input.backfilled ? 1 : 0,
    );
}

function insertActivation(id: string, candidateId: string, start: number, end: number | null) {
  handle.sqlite
    .prepare(
      `insert into trader_activations
         (activation_id, candidate_id, state, started_at, ended_at, end_reason, loss_streak, fired_reason, source)
       values (?, ?, ?, ?, ?, ?, 0, null, 'watch_promotion')`,
    )
    .run(
      id,
      candidateId,
      end === null ? 'ACTIVE' : 'FIRED',
      new Date(start).toISOString(),
      end === null ? null : new Date(end).toISOString(),
      end === null ? null : 'fired',
    );
}

function insertObserved(input: {
  activationId: string;
  candidateId: string;
  mint: string;
  tokenBase: string;
  funding: string;
  blockSec: number;
  processedAt: string;
}) {
  const detail = JSON.stringify({
    mint: input.mint,
    mintDecimals: 6,
    tokenDeltaBase: input.tokenBase + 'n',
    fundingDeltaBase: input.funding + 'n',
    fundingMint: USDC,
    fundingDecimals: 6,
  });
  handle.sqlite
    .prepare(
      `insert into observed_leader_events
         (dedupe_key, activation_id, candidate_id, address, signature, slot, transaction_index,
          block_time, kind, skip_reason, detail_json, raw_ref, parser_version, processed_at)
       values (?, ?, ?, ?, ?, 1, 0, ?, 'swap_buy', null, ?, ?, 'leader-parser/1', ?)`,
    )
    .run(
      'dedupe_' + input.activationId + '_' + input.blockSec,
      input.activationId,
      input.candidateId,
      'addr_' + input.candidateId,
      'sig_observed_' + input.blockSec,
      input.blockSec,
      detail,
      'sig_observed_' + input.blockSec,
      input.processedAt,
    );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-sweep-'));
  handle = openDatabase(dir);
  migrate(handle.db, {
    migrationsFolder: resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '..',
      '..',
      '..',
      'packages',
      'db',
      'drizzle',
    ),
  });

  insertCandidate('cand_alpha', 'Alpha');
  insertCandidate('cand_beta', 'Beta');
  insertWatchBuy('cand_alpha', M2, Math.floor(T0 / 1000), '100000000');
  insertWatchBuy('cand_beta', M2, Math.floor((T0 - 30 * 60_000) / 1000), '1000000');

  // A shadow signal for the actual hire: $50 leader input -> $10 cap.
  insertShadow({
    candidateId: 'cand_alpha',
    mint: M2,
    openedAt: new Date(T0).toISOString(),
    entryPrice: '500000',
    notional: '10000000',
    status: 'closed',
    closedAt: new Date(T0 + 2 * HOUR).toISOString(),
    exitReason: 'leader_sell',
    exitPrice: '750000',
    pnl: '5000000',
  });

  // Eight closed shadow trades put Beta on the bench; a fresh buy keeps it promotable.
  for (let i = 0; i < 8; i++) {
    insertShadow({
      candidateId: 'cand_beta',
      mint: M2,
      openedAt: new Date(T0 - (10 + i) * HOUR).toISOString(),
      entryPrice: '500000',
      notional: '5000000',
      status: 'closed',
      closedAt: new Date(T0 - (2 + i) * HOUR).toISOString(),
      exitReason: 'leader_sell',
      exitPrice: '550000',
      pnl: '1000000',
    });
  }

  insertActivation('act_alpha', 'cand_alpha', T0 - HOUR, null);

  // A real paper decision: $25 leader input at the leader's print -> $6.25 copy.
  insertObserved({
    activationId: 'act_alpha',
    candidateId: 'cand_alpha',
    mint: M1,
    tokenBase: '50000000',
    funding: '25000000',
    blockSec: Math.floor(T0 / 1000),
    processedAt: new Date(T0 + 1000).toISOString(),
  });
  handle.sqlite
    .prepare(
      `insert into copied_positions
         (position_id, activation_id, candidate_id, mint, mint_symbol, status, entry_intent_id,
          input_mint, input_usd_micro, copied_token_base, remaining_token_base, leader_token_base,
          realized_pnl_usd_micro, fees_usd_micro, opened_at, closed_at, close_reason)
       values (?, 'act_alpha', 'cand_alpha', ?, 'MINT1', 'open', 'intent_1', ?, '6250000',
               '12500000', '12500000', null, '0', '3125', ?, null, null)`,
    )
    .run('pos_alpha', M1, USDC, new Date(T0).toISOString());
  handle.sqlite
    .prepare(
      `insert into fills
         (fill_id, intent_id, position_id, mode, tx_signature, input_amount_base, output_amount_base,
          price_usd_micro, fee_estimate_usd_micro, balance_evidence_json, commitment, confirmed_at)
       values ('fill_1', 'intent_1', 'pos_alpha', 'paper', null, '6250000', '12500000',
               null, '3125', '{}', 'paper', ?)`,
    )
    .run(new Date(T0).toISOString());
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function options(over: Partial<ParamSweepOptions> = {}): ParamSweepOptions {
  return {
    fromMs: T0 - 2 * HOUR,
    toMs: T0 + 6 * HOUR,
    generatedAtMs: T0 + 6 * HOUR,
    sourceDb: 'test-copy.db',
    grid: {
      values: { STOP_LOSS_BPS: [2000, 3000] },
      hiring: ['net'],
      combinations: [],
    },
    ...over,
  };
}

describe('loadSweepDataset', () => {
  it('maps shadow signals, the real paper decision, hire windows and calibration', () => {
    const dataset = loadSweepDataset(handle, options());
    expect(dataset.coverage.shadowRows).toBe(9);
    expect(dataset.coverage.shadowSignals).toBe(1);
    expect(dataset.coverage.paperPositions).toBe(1);
    expect(dataset.coverage.paperSignals).toBe(1);
    expect(dataset.coverage.paperMissingLeaderEvent).toBe(0);
    expect(dataset.actualWindows).toHaveLength(1);
    expect(dataset.actualWindows[0]!.candidateId).toBe('cand_alpha');

    const paper = dataset.signals.find((signal) => signal.source === 'paper');
    expect(paper).toBeDefined();
    expect(paper!.leaderInputUsdMicro).toBe(25_000_000n);
    expect(paper!.entryPriceUsdMicro).toBe(500_000n);
    expect(paper!.exitKind).toBe('open');
    expect(dataset.paperDecisions[0]!.inputUsdMicro).toBe(6_250_000n);
    expect(dataset.paperDecisions[0]!.signalId).toBe(paper!.id);

    // The paper fill matched the leader print exactly in this fixture.
    expect(dataset.calibration.samples).toBe(1);
    expect(dataset.calibration.entrySlippageBps).toBe(0);
    expect(dataset.calibration.feeBps).toBe(5);
  });
});

describe('buildSweepReport', () => {
  it('reports baseline vs alternatives, hiring alternatives and the paper match', () => {
    const dataset = loadSweepDataset(handle, options());
    const report = buildSweepReport(dataset, options());
    expect(report.runsEvaluated).toBe(4); // baseline + two stop-loss values + one hiring
    expect(report.alternatives).toHaveLength(3);
    expect(report.baseline.full.trades).toBeGreaterThanOrEqual(1);
    expect(report.baselineMatch.entriesCompared).toBe(1);
    expect(report.baselineMatch.entryMatches).toBe(1);
    expect(report.baselineMatch.paperPositions).toBe(1);
    expect(report.hiringAlternatives).toHaveLength(1);
    expect(report.hiringAlternatives[0]!.hires.length).toBe(1);

    const markdown = renderSweepMarkdown(report);
    expect(markdown).toContain('Read-only replay');
    expect(markdown).toContain('Top alternatives');
    expect(markdown).toContain('Baseline replay match');
    expect(markdown).toContain('Nothing here was applied');
    // Bigint-free JSON.
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('handles an empty database without inventing trades', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'zcode-sweep-empty-'));
    const empty = openDatabase(emptyDir);
    migrate(empty.db, {
      migrationsFolder: resolve(
        fileURLToPath(new URL('.', import.meta.url)),
        '..',
        '..',
        '..',
        'packages',
        'db',
        'drizzle',
      ),
    });
    try {
      const dataset = loadSweepDataset(empty, options());
      const report = buildSweepReport(dataset, options());
      expect(dataset.signals).toHaveLength(0);
      expect(report.baseline.full.trades).toBe(0);
      expect(report.baseline.full.netPnlUsdMicro).toBe('0');
      expect(report.baselineMatch.paperPositions).toBe(0);
      expect(report.baselineMatch.note).toContain('not applicable');
      expect(renderSweepMarkdown(report)).toContain('No paper positions');
    } finally {
      empty.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('forward-only shadow evidence', () => {
  it('never hires a wallet whose only closed record is the admission backfill', () => {
    const id = 'cand_backfilled_only';
    insertCandidate(id, 'BackfilledOnly');
    insertWatchBuy(id, M2, Math.floor(T0 / 1000), '100000000');
    // A strong record on paper, but every lot is backfilled: the live gate
    // judges forward closes, so the replay must ignore it too.
    for (let i = 0; i < 8; i++) {
      insertShadow({
        candidateId: id,
        mint: M2,
        openedAt: new Date(T0 - (10 + i) * HOUR).toISOString(),
        entryPrice: '500000',
        notional: '5000000',
        status: 'closed',
        closedAt: new Date(T0 - (2 + i) * HOUR).toISOString(),
        exitReason: 'leader_sell',
        exitPrice: '550000',
        pnl: '10000000',
        backfilled: true,
      });
    }
    try {
      const dataset = loadSweepDataset(handle, options());
      const report = buildSweepReport(dataset, options());
      const hiredHandles = report.hiringAlternatives.flatMap((alt) =>
        alt.hires.map((hire) => hire.alternativeHandle),
      );
      expect(hiredHandles).not.toContain('BackfilledOnly');
    } finally {
      // Keep the shared fixture unchanged for any later suite.
      handle.sqlite.prepare('delete from shadow_trades where candidate_id = ?').run(id);
      handle.sqlite.prepare('delete from watch_events where candidate_id = ?').run(id);
      handle.sqlite.prepare('delete from trader_candidates where candidate_id = ?').run(id);
    }
  });
});
