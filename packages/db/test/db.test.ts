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
