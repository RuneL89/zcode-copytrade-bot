import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type RiskConfig } from '@zcode-bot/config';
import { StateBuilder } from '../src/services/builder.js';
import { ControlService } from '../src/services/control.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';
import { DiscoveryService } from '../src/services/discovery.js';
import type { CopyEngine } from '../src/services/engine.js';

/**
 * Plan 07's pipeline payload: five stages, their 24h transitions and the roster
 * seats — every count DB-derived server-side because the dashboard renders the
 * numbers verbatim and never derives its own (AC2/AC3/AC4/AC14).
 */

let dir: string;
let handle: DbHandle;
let risk: RiskConfig;
let counter = 0;

const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function builder(over: Partial<RiskConfig> = {}): StateBuilder {
  const merged = { ...risk, ...over };
  const control = new ControlService(handle.db);
  const engine = { headroomUsdMicro: () => 1_000_000_000n } as unknown as CopyEngine;
  const lifecycle = new TraderLifecycle(handle.db, merged, engine, null as never);
  return new StateBuilder(
    handle.db,
    { mode: 'paper', risk: merged } as never,
    control,
    null,
    lifecycle,
    1_000_000n,
  );
}

function seedCandidate(name: string, over: { enabled?: boolean; activity?: boolean } = {}): string {
  const candidateId = `cand_pipe_${counter++}_${name}`;
  repo.upsertCandidate(handle.db, {
    candidateId,
    handle: name,
    weeklyRank: null,
    displayedWeeklyPnlUsdMicro: null,
    profileUrl: null,
    avatarUrl: null,
    enabled: over.enabled ?? true,
    source: 'test',
    observedAt: iso(0),
  });
  repo.upsertCandidateAddress(handle.db, candidateId, {
    chain: 'solana',
    address: `Wallet${name}`,
    verification: 'reported',
  });
  if (over.activity) {
    repo.updateCandidateActivity(handle.db, candidateId, {
      swaps24h: 3,
      lastSwapAt: iso(HOUR),
      lastBuyAt: iso(HOUR),
      buys24h: 2,
      sells24h: 1,
      status: 'ok',
      checkedAt: iso(60_000),
    });
  }
  return candidateId;
}

function seedActivation(candidateId: string, source: string, startedAt = iso(0)): string {
  const activationId = `act_pipe_${counter++}`;
  repo.createActivation(handle.db, {
    activationId,
    candidateId,
    state: 'ACTIVE',
    startedAt,
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source,
  });
  return activationId;
}

function seedSignal(
  activationId: string,
  candidateId: string,
  kind: 'swap_buy' | 'swap_sell' | 'skipped',
  processedAt = iso(60_000),
): void {
  repo.insertObservedEvent(handle.db, {
    dedupeKey: `dedupe_${counter++}`,
    activationId,
    candidateId,
    address: 'WalletX',
    signature: `sig_${counter++}`,
    slot: counter,
    kind,
    parserVersion: 'test',
    processedAt,
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-pipeline-'));
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
  risk = loadConfig({ SESSION_SECRET: 'p'.repeat(48) }).risk;
});

beforeEach(() => {
  handle.sqlite.exec(
    [
      'DELETE FROM candidate_addresses',
      'DELETE FROM watch_events',
      'DELETE FROM shadow_trades',
      'DELETE FROM watch_wallets',
      'DELETE FROM observed_leader_events',
      'DELETE FROM firing_events',
      'DELETE FROM loss_streak_events',
      'DELETE FROM realized_pnl_lots',
      'DELETE FROM fills',
      'DELETE FROM execution_attempts',
      'DELETE FROM order_intents',
      'DELETE FROM copied_positions',
      'DELETE FROM trader_activations',
      'DELETE FROM trader_candidates',
    ].join('; '),
  );
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('pipeline stages are DB-derived (AC2)', () => {
  it('counts the pool from candidates and their wallet rows, never a guess', () => {
    const buyer = seedCandidate('pool_buyer', { activity: true });
    seedCandidate('pool_quiet');
    seedCandidate('pool_off', { enabled: false });

    const b = builder();
    const lastRun = iso(2 * HOUR);
    b.setDiscoveryStatus(() => ({
      lastRunAt: lastRun,
      creditsRemaining: 12_345,
      sources: ['24h', '7d', '30d', 'alerts'],
    }));
    const p = b.build().pipeline;

    // pool.total / withWallet count ENABLED candidates only; the funded-buy
    // screen counts a fresh ok reading with ≥1 buy in the 24h lookback.
    expect(p.pool).toEqual({ total: 2, withWallet: 2, fundedBuyers24h: 1 });
    expect(buyer).toBeTruthy();
    // Discovery facts pass through from the service's own record.
    expect(p.discovery.lastSyncAt).toBe(lastRun);
    expect(p.discovery.creditsRemaining).toBe(12_345);
    expect(p.discovery.sources).toEqual(['24h', '7d', '30d', 'alerts']);
    // Three handles were created inside the window (the disabled one too).
    expect(p.discovery.newHandles24h).toBe(3);
    expect(p.asOf).toBeTruthy();
  });

  it('reads watch statuses, 24h admissions and the cooling return lane', () => {
    const w1 = seedCandidate('watching_new');
    repo.upsertWatchWallet(handle.db, {
      candidateId: w1,
      address: 'WalletA',
      status: 'watching',
    });
    const w2 = seedCandidate('watching_old');
    repo.upsertWatchWallet(handle.db, {
      candidateId: w2,
      address: 'WalletB',
      status: 'watching',
      admittedAt: iso(30 * HOUR),
    });
    const w3 = seedCandidate('promoted_new');
    repo.upsertWatchWallet(handle.db, {
      candidateId: w3,
      address: 'WalletC',
      status: 'promoted',
    });
    const w4 = seedCandidate('cooling_new');
    repo.upsertWatchWallet(handle.db, {
      candidateId: w4,
      address: 'WalletD',
      status: 'watching',
      admittedAt: iso(30 * HOUR),
    });
    repo.setWatchStatus(handle.db, w4, 'cooling', 'fired — observed for re-entry');

    const p = builder().build().pipeline;
    expect(p.watch).toEqual({
      watching: 2,
      cooling: 1,
      promotable: 1,
      benchTarget: risk.BENCH_TARGET,
    });
    const edge = (from: string, to: string) => p.edges.find((e) => e.from === from && e.to === to)?.count24h;
    expect(edge('pool', 'watch')).toBe(2); // w1 + w3 admitted inside the window
    expect(edge('exits', 'watch')).toBe(1); // w4 re-entered as cooling just now
  });

  it('counts exits and replacements from their own rows', () => {
    const fired = seedCandidate('fired_now');
    const act = seedActivation(fired, 'manual');
    const firedAt = iso(HOUR);
    repo.insertFiringEvent(handle.db, {
      activationId: act,
      candidateId: fired,
      reason: 'loss streak',
      lossStreak: 2,
      positionPolicy: 'close_all_before_switch',
      handoffStatus: 'none',
      firedAt,
    });
    const replacement = seedCandidate('replacement_now');
    // The fire refills its chair within one watch tick; two minutes later is
    // squarely inside the attribution window.
    seedActivation(replacement, 'watch_promotion', iso(HOUR - 2 * 60_000));
    const oldHire = seedCandidate('replacement_old');
    seedActivation(oldHire, 'watch_promotion', iso(40 * HOUR));

    const p = builder().build().pipeline;
    expect(p.exits.fired24h).toBe(1);
    expect(p.exits.replacements24h).toBe(1);
    // The fired lane names the cause and the hire that took the freed chair.
    expect(p.exits.recent).toEqual([
      {
        candidateId: fired,
        handle: 'fired_now',
        reason: 'loss streak',
        firedAt,
        replacedBy: 'replacement_now',
      },
    ]);
    const edge = (from: string, to: string) => p.edges.find((e) => e.from === from && e.to === to)?.count24h;
    expect(edge('watch', 'roster')).toBe(1);
    expect(edge('roster', 'exits')).toBe(1);
  });

  it('does not attribute a hire made long after the firing to that chair', () => {
    // A firing from this morning, and the only promotion hire happened hours
    // later: it filled some chair, but not this one. The lane must say so.
    const fired = seedCandidate('fired_unpaired');
    const act = seedActivation(fired, 'manual');
    repo.insertFiringEvent(handle.db, {
      activationId: act,
      candidateId: fired,
      reason: 'stale last buy',
      lossStreak: 0,
      positionPolicy: 'close_all_before_switch',
      handoffStatus: 'none',
      firedAt: iso(5 * HOUR),
    });
    const later = seedCandidate('hire_much_later');
    seedActivation(later, 'watch_promotion', iso(3 * HOUR));

    const lane = builder().build().pipeline.exits.recent;
    expect(lane[0]?.handle).toBe('fired_unpaired');
    expect(lane[0]?.replacedBy).toBeNull();
  });
});

describe('roster seats carry the last observed signal (AC4)', () => {
  it('maps BUYING / SELLING / IDLE / RECONCILING from the rows themselves', () => {
    const buying = seedCandidate('seat_buying');
    const aBuy = seedActivation(buying, 'watch_promotion');
    const buyAt = iso(60_000);
    seedSignal(aBuy, buying, 'swap_buy', buyAt);

    const selling = seedCandidate('seat_selling');
    const aSell = seedActivation(selling, 'watch_promotion');
    seedSignal(aSell, selling, 'swap_sell', iso(30_000));

    const idle = seedCandidate('seat_idle');
    seedActivation(idle, 'watch_promotion');

    // A seat that holds a position pauses the idle clock; a flat seat counts.
    repo.insertPosition(handle.db, {
      positionId: 'pos_pipe_holding',
      activationId: aBuy,
      candidateId: buying,
      mint: 'PipeMint1111111111111111111111111111111111111',
      mintSymbol: 'PIPE',
      status: 'open',
      entryIntentId: null,
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      inputUsdMicro: '1000000',
      copiedTokenBase: '1000',
      remainingTokenBase: '1000',
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: '1000',
      openedAt: iso(0),
      closedAt: null,
      closeReason: null,
    });

    const reconciling = seedCandidate('seat_recon');
    const aRecon = seedActivation(reconciling, 'watch_promotion');
    repo.updateActivation(handle.db, aRecon, { state: 'REQUIRES_RECONCILIATION' });

    const s = builder().build();
    const seat = (handleName: string) => s.pipeline.roster.find((r) => r.handle === handleName);
    expect(seat('seat_buying')?.status).toBe('BUYING');
    expect(seat('seat_buying')?.lastSignalAt).toBe(buyAt);
    expect(seat('seat_selling')?.status).toBe('SELLING');
    expect(seat('seat_idle')?.status).toBe('IDLE');
    expect(seat('seat_idle')?.lastSignalAt).toBeNull();
    expect(seat('seat_recon')?.status).toBe('RECONCILING');
    // The idle clock only runs while a seat is flat.
    expect(seat('seat_buying')?.openPositions).toBe(1);
    expect(seat('seat_buying')?.idleFireHoursLeft).toBeNull();
    expect(seat('seat_idle')?.idleFireHoursLeft).not.toBeNull();
    expect(seat('seat_idle')?.idleFireHoursLeft ?? 0).toBeGreaterThan(risk.IDLE_FIRE_HOURS - 0.2);
    // The grid renders five chairs: the seat count comes from the payload.
    expect(s.counters.rosterSize).toBe(risk.ROSTER_SIZE);
  });
});

describe('discovery status reads only its own run record (AC3)', () => {
  it('returns the stored facts and refuses to guess from a broken record', () => {
    const service = new DiscoveryService(
      handle.db,
      {
        configured: false,
        leaderboard: async () => ({}) as never,
        alerts: async () => ({}) as never,
      },
      risk,
    );
    expect(service.status()).toEqual({ lastRunAt: null, creditsRemaining: null, sources: [] });

    const stored = iso(HOUR);
    repo.kvSet(handle.db, 'discovery.last_run_at', stored);
    repo.kvSet(handle.db, 'discovery.credits_remaining', '777');
    repo.kvSet(handle.db, 'discovery.last_sources', JSON.stringify(['24h', 'alerts']));
    expect(service.status()).toEqual({
      lastRunAt: stored,
      creditsRemaining: 777,
      sources: ['24h', 'alerts'],
    });

    repo.kvSet(handle.db, 'discovery.last_sources', '{not json');
    expect(service.status().sources).toEqual([]);
  });
});

/**
 * A position aggregates every copy of one coin by one leader, so an operator
 * looking at a $67.69 row is really looking at seven buys. The payload carries
 * those buys individually (open ones only, FIFO), each with its own PnL.
 */
describe('position entries list the individual copy buys', () => {
  const MINT = 'EntryMint1111111111111111111111111111111111';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  function seedAggregated(remainingTokenBase: string): { positionId: string } {
    const buyer = seedCandidate('entries_buyer');
    const act = seedActivation(buyer, 'watch_promotion');
    const positionId = 'pos_entries_one';
    repo.insertPosition(handle.db, {
      positionId,
      activationId: act,
      candidateId: buyer,
      mint: MINT,
      mintSymbol: 'ENT',
      status: 'open',
      entryIntentId: null,
      inputMint: USDC,
      inputUsdMicro: '20000000',
      copiedTokenBase: '2000',
      remainingTokenBase,
      leaderTokenBase: null,
      realizedPnlUsdMicro: '0',
      feesUsdMicro: '0',
      openedAt: iso(2 * HOUR),
      closedAt: null,
      closeReason: null,
    });
    for (const [n, at] of [
      [0, iso(1 * HOUR)],
      [1, iso(30 * 60_000)],
    ] as Array<[number, string]>) {
      const intentId = `intent_entries_${n}`;
      repo.insertIntent(handle.db, {
        intentId,
        kind: 'entry',
        mode: 'paper',
        activationId: act,
        candidateId: buyer,
        positionId,
        mint: MINT,
        inputMint: USDC,
        inputAmountBase: '10000000',
        inputUsdMicro: '10000000',
        state: 'confirmed',
        idempotencyKey: `entries-${n}`,
        txSignature: `entries-sig-${n}`,
        createdAt: at,
        updatedAt: at,
      });
      repo.insertFill(handle.db, {
        fillId: `fill_entries_${n}`,
        intentId,
        positionId,
        mode: 'paper',
        txSignature: `entries-sig-${n}`,
        inputAmountBase: '10000000',
        outputAmountBase: '1000',
        feeEstimateUsdMicro: '0',
        commitment: 'confirmed',
        confirmedAt: at,
      });
    }
    return { positionId };
  }

  it('splits one position into its open buys, each with its own PnL', () => {
    const { positionId } = seedAggregated('2000');
    const b = builder();
    b.setMark(positionId, 24_000_000n, Date.now()); // the $20 book marks at $24
    const p = b.build().positions.find((x) => x.positionId === positionId)!;
    expect(p.entries).toHaveLength(2);
    for (const e of p.entries) {
      expect(e.usdMicro).toBe('10000000'); // $10 per buy
      expect(e.unrealizedPnlUsdMicro).toBe('2000000'); // +$2.00 each
    }
    // Nothing sold: the buys sum exactly to the position's unrealized P/L.
    const sum = p.entries.reduce((acc, e) => acc + BigInt(e.unrealizedPnlUsdMicro ?? '0'), 0n);
    expect(sum.toString()).toBe(p.unrealizedPnlUsdMicro);
  });

  it('consumes sold base FIFO, so a sold buy drops out of the list', () => {
    const { positionId } = seedAggregated('1000'); // half sold: the first buy is gone
    const b = builder();
    b.setMark(positionId, 24_000_000n, Date.now());
    const p = b.build().positions.find((x) => x.positionId === positionId)!;
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]!.usdMicro).toBe('10000000');
    expect(p.entries[0]!.unrealizedPnlUsdMicro).toBe('14000000'); // the surviving buy, re-marked
  });
});
