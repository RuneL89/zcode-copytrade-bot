import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, acquireWorkerLock } from '../src/connection.js';
import * as repo from '../src/repo.js';
import { fileURLToPath } from 'node:url';

let dir: string;
let handle: ReturnType<typeof openDatabase>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-bot-db-'));
  handle = openDatabase(dir);
  const migrationsFolder = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'drizzle');
  migrate(handle.db, { migrationsFolder });
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('database', () => {
  it('runs in WAL mode', () => {
    const mode = handle.sqlite.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('kv roundtrip', () => {
    repo.kvSet(handle.db, 'appState', 'RUNNING');
    expect(repo.kvGet(handle.db, 'appState')).toBe('RUNNING');
  });

  it('candidate upsert + addresses are idempotent', () => {
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_a',
      handle: 'alpha',
      weeklyRank: 1,
      displayedWeeklyPnlUsdMicro: '1000000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'manual',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(handle.db, 'cand_a', {
      chain: 'solana',
      address: 'Addr1',
      verification: 'reported',
    });
    repo.upsertCandidateAddress(handle.db, 'cand_a', {
      chain: 'solana',
      address: 'Addr1',
      verification: 'reported',
    });
    expect(repo.listCandidates(handle.db)).toHaveLength(1);
    expect(repo.listCandidateAddresses(handle.db, 'cand_a')).toHaveLength(1);
  });

  it('defers an incomplete admission scan without touching its freshness', () => {
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_defer',
      handle: 'deferred',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'manual',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(handle.db, 'cand_defer', {
      chain: 'solana',
      address: 'AddrDefer',
      verification: 'reported',
    });

    const checkedAt = '2026-11-16T08:55:08.000Z';
    repo.updateCandidateActivity(handle.db, 'cand_defer', {
      swaps24h: 5,
      lastSwapAt: checkedAt,
      lastBuyAt: checkedAt,
      buys24h: 3,
      sells24h: 2,
      status: 'ok',
      checkedAt,
    });

    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    repo.deferCandidateActivity(handle.db, 'cand_defer', until, new Date().toISOString());
    const deferred = repo.getCandidate(handle.db, 'cand_defer')!;
    expect(deferred.activityCheckStatus).toBe('failed');
    expect(deferred.activityCheckedAt).toBe(checkedAt);
    expect(deferred.buys24h).toBe(3);
    expect(repo.kvGet(handle.db, repo.admissionDeferKey('cand_defer'))).toBe(until);
    expect(repo.listAdmissionScanCandidates(handle.db, 100).some((c) => c.candidateId === 'cand_defer')).toBe(
      false,
    );

    // Once the stored window is past, the candidate is eligible again.
    repo.deferCandidateActivity(
      handle.db,
      'cand_defer',
      new Date(Date.now() - 1_000).toISOString(),
      new Date().toISOString(),
    );
    expect(repo.listAdmissionScanCandidates(handle.db, 100).some((c) => c.candidateId === 'cand_defer')).toBe(
      true,
    );

    // A successful reading clears the deferral.
    repo.updateCandidateActivity(handle.db, 'cand_defer', {
      swaps24h: 0,
      lastSwapAt: null,
      lastBuyAt: null,
      buys24h: 0,
      sells24h: 0,
      status: 'ok',
      checkedAt: new Date().toISOString(),
    });
    expect(repo.kvGet(handle.db, repo.admissionDeferKey('cand_defer'))).toBeUndefined();
  });

  it('filters fresh candidates before applying the admission scan limit', () => {
    for (const [candidateId, address] of [
      ['cand_fresh_head_db', 'AddrFreshHead'],
      ['cand_stale_head_db', 'AddrStaleHead'],
    ] as Array<[string, string]>) {
      repo.upsertCandidate(handle.db, {
        candidateId,
        handle: candidateId,
        weeklyRank: null,
        displayedWeeklyPnlUsdMicro: null,
        profileUrl: null,
        avatarUrl: null,
        enabled: true,
        source: 'manual',
        observedAt: new Date().toISOString(),
      });
      repo.upsertCandidateAddress(handle.db, candidateId, {
        chain: 'solana',
        address,
        verification: 'reported',
      });
    }

    const lastBuy = new Date().toISOString();
    repo.updateCandidateActivity(handle.db, 'cand_fresh_head_db', {
      swaps24h: 5,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 5,
      sells24h: 0,
      status: 'ok',
      checkedAt: lastBuy,
    });
    const stale = new Date(Date.now() - 96 * 3_600_000).toISOString();
    repo.updateCandidateActivity(handle.db, 'cand_stale_head_db', {
      swaps24h: 1,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 1,
      sells24h: 0,
      status: 'ok',
      checkedAt: stale,
    });

    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const rows = repo.listAdmissionScanCandidates(handle.db, 1, cutoff);
    expect(rows.map((row) => row.candidateId)).toEqual(['cand_stale_head_db']);
  });

  it('scan import writes pnl24h + stats stamp and preserves Dawn stats', () => {
    const now = new Date().toISOString();
    // Dawn card first: rich stats + its own stamp.
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_scan',
      handle: 'scanface',
      weeklyRank: 3,
      displayedWeeklyPnlUsdMicro: '50000000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'dawn',
      observedAt: now,
      winRatePct: 61.5,
      pnl24hUsd: null,
      statsCheckedAt: '2026-10-29T00:00:00.000Z',
    });
    // Board import: only the scan's displayed 24h PnL + fresh stamp.
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_scan',
      handle: 'scanface',
      weeklyRank: 1,
      displayedWeeklyPnlUsdMicro: '262897540000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'fomo-web-manual',
      observedAt: now,
      pnl24hUsd: 262897.54,
      statsCheckedAt: now,
    });
    const c = repo.listCandidates(handle.db).find((x) => x.candidateId === 'cand_scan')!;
    expect(c.pnl24hUsd).toBeCloseTo(262897.54, 2);
    expect(c.statsCheckedAt).toBe(now);
    // undefined stats must survive the scan import untouched.
    expect(c.winRatePct).toBeCloseTo(61.5, 2);
  });

  it('observed events dedupe by unique key', () => {
    const a = repo.insertObservedEvent(handle.db, {
      dedupeKey: 'solana:L:sig1:0',
      activationId: 'act1',
      candidateId: 'cand_a',
      address: 'L',
      signature: 'sig1',
      slot: 1,
      transactionIndex: 0,
      blockTime: 100,
      kind: 'swap_buy',
      skipReason: null,
      detailJson: null,
      rawRef: null,
      parserVersion: 'v',
      processedAt: new Date().toISOString(),
    });
    const b = repo.insertObservedEvent(handle.db, {
      dedupeKey: 'solana:L:sig1:0',
      activationId: 'act1',
      candidateId: 'cand_a',
      address: 'L',
      signature: 'sig1',
      slot: 1,
      transactionIndex: 0,
      blockTime: 100,
      kind: 'swap_buy',
      skipReason: null,
      detailJson: null,
      rawRef: null,
      parserVersion: 'v',
      processedAt: new Date().toISOString(),
    });
    expect(a).toBe(true);
    expect(b).toBe(false); // duplicate rejected
  });

  it('audit and streak event insertion', () => {
    repo.audit(handle.db, 'test', 'something happened', { x: 1 });
    const events = repo.listAudit(handle.db, 10);
    expect(events[0]!.message).toBe('something happened');
    repo.insertStreakEvent(handle.db, {
      activationId: 'act1',
      unitType: 'position_closed',
      unitRef: 'pos1',
      result: 'loss',
      pnlUsdMicro: '-100000',
      streakAfter: 1,
      createdAt: new Date().toISOString(),
    });
    expect(repo.listStreakEvents(handle.db, 'act1')).toHaveLength(1);
  });

  it('single-worker lock: second acquisition fails', () => {
    const lock = acquireWorkerLock(dir);
    try {
      expect(() => acquireWorkerLock(dir)).toThrow(/worker lock/);
    } finally {
      lock.release();
    }
    // released lock can be re-acquired
    const lock2 = acquireWorkerLock(dir);
    lock2.release();
  });

  it('daily counters aggregate from integer lots', () => {
    repo.insertPnlLot(handle.db, {
      positionId: 'p1',
      closedBase: '100',
      proceedsUsdMicro: '5000000',
      costBasisUsdMicro: '4000000',
      feesUsdMicro: '10000',
      pnlUsdMicro: '990000',
      unitType: 'position_closed',
      closedAt: new Date().toISOString(),
    });
    expect(repo.realizedPnlSince(handle.db, new Date(Date.now() - 60_000).toISOString())).toBe(990000n);
  });
});

/** 0005: watch-list storage + the D3 `user_id` identity. */
describe('foundation schema (plan 02)', () => {
  const columnsOf = (table: string): string[] =>
    (handle.sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
  const indexNamesOn = (table: string): string[] =>
    (
      handle.sqlite
        .prepare(`select name from sqlite_master where type = 'index' and tbl_name = ?`)
        .all(table) as Array<{ name: string }>
    ).map((i) => i.name);

  it('creates the four tables with the exact columns and indexes', () => {
    expect(columnsOf('watch_wallets')).toEqual([
      'candidate_id',
      'user_id',
      'address',
      'status',
      'admitted_at',
      'updated_at',
      'reason',
      'last_funded_buy_at',
      'last_funded_sell_at',
    ]);
    expect(indexNamesOn('watch_wallets')).toContain('idx_watch_status');

    expect(columnsOf('watch_events')).toEqual([
      'id',
      'candidate_id',
      'address',
      'signature',
      'side',
      'mint',
      'token_amount_base',
      'decimals',
      'usd_micro',
      'block_time',
      'observed_at',
      'source',
    ]);
    expect(indexNamesOn('watch_events')).toEqual(
      expect.arrayContaining(['uniq_watch_event', 'idx_watch_event_side']),
    );

    expect(columnsOf('shadow_trades')).toEqual([
      'id',
      'candidate_id',
      'mint',
      'opened_at',
      'entry_price_usd_micro',
      'notional_usd_micro',
      'status',
      'closed_at',
      'exit_reason',
      'exit_price_usd_micro',
      'pnl_usd_micro',
      'backfilled',
    ]);
    expect(indexNamesOn('shadow_trades')).toContain('idx_shadow_status');

    expect(columnsOf('watch_cursors')).toEqual([
      'address',
      'candidate_id',
      'last_signature',
      'last_slot',
      'last_transaction_index',
      'updated_at',
    ]);
  });

  it('adds trader_candidates.user_id with a unique index; old NULL rows still load', () => {
    expect(columnsOf('trader_candidates')).toContain('user_id');
    expect(indexNamesOn('trader_candidates')).toContain('uniq_candidate_user_id');
    // Rows written before the outlet carried a userId keep NULL and are unique-safe.
    const legacy = repo.listCandidates(handle.db).filter((c) => c.userId === null);
    expect(legacy.length).toBeGreaterThanOrEqual(2);
  });

  it('keys candidates by user id and finds them by wallet', () => {
    const first = repo.upsertCandidateByUser(handle.db, {
      candidateId: 'cand_u1',
      userId: 'u1',
      handle: 'first_handle',
      source: 'fomoapi',
      observedAt: '2026-11-01T10:00:00.000Z',
      address: 'WalletU1',
    });
    expect(first).toBe('cand_u1');
    // The same user id under a new handle keeps its original candidate row.
    const renamed = repo.upsertCandidateByUser(handle.db, {
      candidateId: 'cand_renamed',
      userId: 'u1',
      handle: 'renamed_handle',
      source: 'fomoapi',
      observedAt: '2026-11-01T11:00:00.000Z',
    });
    expect(renamed).toBe('cand_u1');
    expect(repo.findCandidateByUserId(handle.db, 'u1')?.handle).toBe('renamed_handle');
    expect(repo.findCandidateByWallet(handle.db, 'WalletU1')?.candidateId).toBe('cand_u1');
    expect(repo.findCandidateByWallet(handle.db, 'WalletNowhere')).toBeUndefined();
  });

  it('watch events are idempotent and the funded stamps follow block time, not ingestion time', () => {
    const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    repo.upsertWatchWallet(handle.db, {
      candidateId: 'cand_u1',
      userId: 'u1',
      address: 'WalletU1',
      status: 'watching',
      reason: 'admission',
    });
    const buy = {
      candidateId: 'cand_u1',
      address: 'WalletU1',
      signature: 'sigBuyA',
      side: 'buy',
      mint: 'MINTAAA',
      tokenAmountBase: '1000',
      decimals: 6,
      usdMicro: '5000000',
      // The leader bought on chain at 10:00; we ingested it the next day.
      blockTime: sec('2026-11-01T10:00:00.000Z'),
      observedAt: '2026-11-02T09:00:00.000Z',
      source: 'watch-poll',
    };
    expect(repo.insertWatchEvent(handle.db, buy)).toBe(true);
    expect(repo.insertWatchEvent(handle.db, buy)).toBe(false); // same (candidate, sig, side)
    expect(repo.listWatchEvents(handle.db, 'cand_u1')).toHaveLength(1);
    expect(repo.lastFundedBuyAt(handle.db, 'cand_u1')).toBe('2026-11-01T10:00:00.000Z');
    expect(repo.getWatchWallet(handle.db, 'cand_u1')?.lastFundedBuyAt).toBe('2026-11-01T10:00:00.000Z');
    expect(repo.lastFundedSellAt(handle.db, 'cand_u1')).toBeNull();
    expect(repo.lastFundedBuyAt(handle.db, 'cand_never_seen')).toBeNull();

    // A late-scanned OLDER buy inserts, but the stamp stays on the newest.
    expect(
      repo.insertWatchEvent(handle.db, {
        ...buy,
        signature: 'sigBuyOld',
        blockTime: sec('2026-11-01T09:00:00.000Z'),
        observedAt: '2026-11-02T10:00:00.000Z',
      }),
    ).toBe(true);
    expect(repo.getWatchWallet(handle.db, 'cand_u1')?.lastFundedBuyAt).toBe('2026-11-01T10:00:00.000Z');

    // A newer on-chain buy advances the stamp even though it is observed last.
    expect(
      repo.insertWatchEvent(handle.db, {
        ...buy,
        signature: 'sigBuyNew',
        blockTime: sec('2026-11-01T11:00:00.000Z'),
        observedAt: '2026-11-02T11:00:00.000Z',
      }),
    ).toBe(true);
    expect(repo.lastFundedBuyAt(handle.db, 'cand_u1')).toBe('2026-11-01T11:00:00.000Z');
    expect(repo.getWatchWallet(handle.db, 'cand_u1')?.lastFundedBuyAt).toBe('2026-11-01T11:00:00.000Z');

    expect(
      repo.insertWatchEvent(handle.db, {
        ...buy,
        signature: 'sigSellA',
        side: 'sell',
        blockTime: sec('2026-11-01T11:30:00.000Z'),
        observedAt: '2026-11-02T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(repo.lastFundedSellAt(handle.db, 'cand_u1')).toBe('2026-11-01T11:30:00.000Z');
    expect(repo.getWatchWallet(handle.db, 'cand_u1')?.lastFundedSellAt).toBe('2026-11-01T11:30:00.000Z');

    // No usable block time: the event is stored, but the recency stamp fails
    // closed instead of reading the ingestion time as the leader's buy time.
    expect(
      repo.insertWatchEvent(handle.db, {
        ...buy,
        signature: 'sigBuyNoBlock',
        blockTime: 0,
        observedAt: '2026-11-03T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(repo.lastFundedBuyAt(handle.db, 'cand_u1')).toBe('2026-11-01T11:00:00.000Z');
    expect(repo.getWatchWallet(handle.db, 'cand_u1')?.lastFundedBuyAt).toBe('2026-11-01T11:00:00.000Z');
  });

  it('watch status transitions stay queryable', () => {
    repo.setWatchStatus(handle.db, 'cand_u1', 'cooling', 'fired');
    expect(repo.getWatchWallet(handle.db, 'cand_u1')?.status).toBe('cooling');
    expect(repo.listWatchWallets(handle.db, 'watching')).toHaveLength(0);
    expect(repo.listWatchWallets(handle.db).map((w) => w.candidateId)).toEqual(['cand_u1']);
    repo.setWatchStatus(handle.db, 'cand_u1', 'watching', 're-admitted');
    expect(repo.listWatchWallets(handle.db, 'watching')).toHaveLength(1);
  });

  it('shadow trades open, close, and aggregate in bigint micro-USD', () => {
    const entry = (mint: string) =>
      repo.openShadowTrade(handle.db, {
        candidateId: 'cand_u1',
        mint,
        openedAt: '2026-11-01T10:00:00.000Z',
        entryPriceUsdMicro: '2000000',
        notionalUsdMicro: '5000000',
      });
    const win = entry('MINTWIN');
    const loss = entry('MINTLOSS');
    entry('MINTSTILLOPEN');
    expect(repo.listOpenShadowTrades(handle.db, 'cand_u1')).toHaveLength(3);

    repo.closeShadowTrade(handle.db, win, {
      closedAt: '2026-11-01T12:00:00.000Z',
      exitReason: 'leader_sell',
      exitPriceUsdMicro: '2500000',
      pnlUsdMicro: '1250000',
    });
    repo.closeShadowTrade(handle.db, loss, {
      closedAt: '2026-11-01T13:00:00.000Z',
      exitReason: 'ceiling',
      exitPriceUsdMicro: '1500000',
      pnlUsdMicro: '-1250000',
    });

    const agg = repo.shadowAggregates(handle.db, 'cand_u1');
    expect(agg.closedCount).toBe(2);
    expect(agg.netPnlUsdMicro).toBe(0n);
    expect(agg.lastClosedAt).toBe('2026-11-01T13:00:00.000Z');
    expect(repo.listOpenShadowTrades(handle.db, 'cand_u1')).toHaveLength(1);
    expect(repo.shadowAggregates(handle.db, 'cand_no_shadow').closedCount).toBe(0);

    // The admission backfill is ledger evidence but not forward proof: the
    // default aggregate excludes it, the explicit view includes it.
    const backfilled = repo.openShadowTrade(handle.db, {
      candidateId: 'cand_u1',
      mint: 'MINTBACKFILL',
      openedAt: '2026-11-01T08:00:00.000Z',
      entryPriceUsdMicro: '1000000',
      notionalUsdMicro: '5000000',
      backfilled: true,
    });
    repo.closeShadowTrade(handle.db, backfilled, {
      closedAt: '2026-11-01T14:00:00.000Z',
      exitReason: 'leader_sell',
      exitPriceUsdMicro: '3000000',
      pnlUsdMicro: '9000000',
    });
    expect(repo.shadowAggregates(handle.db, 'cand_u1').closedCount).toBe(2);
    expect(repo.shadowAggregates(handle.db, 'cand_u1').netPnlUsdMicro).toBe(0n);
    const all = repo.shadowAggregates(handle.db, 'cand_u1', { includeBackfilled: true });
    expect(all.closedCount).toBe(3);
    expect(all.netPnlUsdMicro).toBe(9000000n);
    expect(all.lastClosedAt).toBe('2026-11-01T14:00:00.000Z');
  });

  it('watch cursor round-trips', () => {
    expect(repo.getWatchCursor(handle.db, 'WalletU1')).toBeUndefined();
    repo.setWatchCursor(handle.db, {
      address: 'WalletU1',
      candidateId: 'cand_u1',
      lastSignature: 'sigSellA',
      lastSlot: 42,
      lastTransactionIndex: 1,
    });
    expect(repo.getWatchCursor(handle.db, 'WalletU1')?.lastSlot).toBe(42);
    repo.setWatchCursor(handle.db, {
      address: 'WalletU1',
      candidateId: 'cand_u1',
      lastSignature: 'sigNewer',
      lastSlot: 43,
      lastTransactionIndex: 0,
    });
    const cursor = repo.getWatchCursor(handle.db, 'WalletU1');
    expect(cursor?.lastSignature).toBe('sigNewer');
    expect(cursor?.lastSlot).toBe(43);
  });

  it('lastFiredAt is the newest firing, or null when never fired', () => {
    expect(repo.lastFiredAt(handle.db, 'cand_u1')).toBeNull();
    const firing = (firedAt: string) =>
      repo.insertFiringEvent(handle.db, {
        activationId: 'act_fire',
        candidateId: 'cand_u1',
        reason: 'idle',
        lossStreak: 0,
        positionPolicy: 'keep_positions',
        firedAt,
        closeCompletedAt: null,
        handoffStatus: 'none',
      });
    firing('2026-11-01T08:00:00.000Z');
    firing('2026-11-01T18:00:00.000Z');
    expect(repo.lastFiredAt(handle.db, 'cand_u1')).toBe('2026-11-01T18:00:00.000Z');
    expect(repo.lastFiredAt(handle.db, 'cand_never_fired')).toBeNull();
  });

  it('hasHireSince finds a strictly later hire of another trader', () => {
    const startedAt = '2099-01-01T00:00:01.000Z';
    repo.createActivation(handle.db, {
      activationId: 'act_hire_since',
      candidateId: 'cand_hire_since',
      state: 'FIRED',
      startedAt,
      endedAt: '2099-01-01T01:00:00.000Z',
      endReason: 'fired',
      lossStreak: 0,
      firedReason: 'idle',
      source: 'test',
    });
    expect(repo.hasHireSince(handle.db, '2099-01-01T00:00:00.000Z', 'cand_fired_since')).toBe(true);
    // Strictly after: a hire at the firing instant does not count.
    expect(repo.hasHireSince(handle.db, startedAt, 'cand_fired_since')).toBe(false);
    // The fired trader's own activation does not lift his own block.
    expect(repo.hasHireSince(handle.db, '2099-01-01T00:00:00.000Z', 'cand_hire_since')).toBe(false);
  });

  it("the hand-off replacement hire does not lift the fired trader's block", () => {
    const firedAt = '2100-01-01T00:00:00.000Z';
    repo.createActivation(handle.db, {
      activationId: 'act_repl_fired',
      candidateId: 'cand_repl_fired',
      state: 'FIRED',
      startedAt: '2100-01-01T00:00:00.000Z',
      endedAt: '2100-01-01T00:00:00.000Z',
      endReason: 'fired',
      lossStreak: 0,
      firedReason: 'stall',
      source: 'test',
    });
    repo.insertFiringEvent(handle.db, {
      activationId: 'act_repl_fired',
      candidateId: 'cand_repl_fired',
      reason: 'stall',
      lossStreak: 0,
      positionPolicy: 'keep_positions',
      firedAt,
      closeCompletedAt: null,
      handoffStatus: 'none',
    });
    // The hand-off hire made by this firing.
    repo.createActivation(handle.db, {
      activationId: 'act_repl_replacement',
      candidateId: 'cand_repl_replacement',
      state: 'FIRED',
      startedAt: '2100-01-01T00:00:00.100Z',
      endedAt: '2100-01-01T00:00:00.100Z',
      endReason: 'fired',
      lossStreak: 0,
      firedReason: null,
      source: 'watch_promotion',
      replacesActivationId: 'act_repl_fired',
    });
    expect(repo.hasHireSince(handle.db, firedAt, 'cand_repl_fired')).toBe(false);

    // A later, independent hire DOES lift it.
    repo.createActivation(handle.db, {
      activationId: 'act_repl_independent',
      candidateId: 'cand_repl_independent',
      state: 'FIRED',
      startedAt: '2100-01-01T00:00:01.000Z',
      endedAt: '2100-01-01T00:00:01.000Z',
      endReason: 'fired',
      lossStreak: 0,
      firedReason: null,
      source: 'watch_promotion',
    });
    expect(repo.hasHireSince(handle.db, firedAt, 'cand_repl_fired')).toBe(true);
  });

  it('roster helpers list every active chair, not one', () => {
    expect(repo.activeActivationCount(handle.db)).toBe(0);
    const activation = (activationId: string, candidateId: string, startedAt: string) =>
      repo.createActivation(handle.db, {
        activationId,
        candidateId,
        state: 'ACTIVE',
        startedAt,
        endedAt: null,
        endReason: null,
        lossStreak: 0,
        firedReason: null,
        source: 'test',
      });
    activation('act_chair_1', 'cand_u1', '2026-11-01T09:00:00.000Z');
    activation('act_chair_2', 'cand_u2', '2026-11-01T09:30:00.000Z');
    expect(repo.activeActivationCount(handle.db)).toBe(2);
    expect(repo.listActiveActivations(handle.db).map((a) => a.activationId)).toEqual([
      'act_chair_1',
      'act_chair_2',
    ]);
    repo.updateActivation(handle.db, 'act_chair_2', {
      state: 'FIRED',
      endedAt: '2026-11-01T10:00:00.000Z',
      endReason: 'fired',
    });
    expect(repo.activeActivationCount(handle.db)).toBe(1);
    expect(repo.listActiveActivations(handle.db).map((a) => a.activationId)).toEqual(['act_chair_1']);
  });
});
