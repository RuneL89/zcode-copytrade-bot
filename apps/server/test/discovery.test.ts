import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig } from '@zcode-bot/config';
import type { FomoApiAlertsResult, FomoApiLeaderboardResult, FomoApiWindow } from '@zcode-bot/providers';
import {
  DiscoveryService,
  shouldDiscover,
  discoveryDecision,
  type DiscoveryApi,
} from '../src/services/discovery.js';

let dir: string;
let handle: ReturnType<typeof openDatabase>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-discovery-'));
  handle = openDatabase(dir);
  const migrationsFolder = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    '..',
    '..',
    'packages',
    'db',
    'drizzle',
  );
  migrate(handle.db, { migrationsFolder });
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const risk = loadConfig({ SESSION_SECRET: 'd'.repeat(48) }).risk;

const emptyLeaderboard = (rows: FomoApiLeaderboardResult['rows']): FomoApiLeaderboardResult => ({
  rows,
  notModified: false,
  unparsed: 0,
  creditsCost: 250,
  creditsRemaining: 248000,
  etag: `"${Math.random()}"`,
});

const emptyAlerts = (alerts: FomoApiAlertsResult['alerts'] = []): FomoApiAlertsResult => ({
  alerts,
  unparsed: 0,
  creditsCost: 125,
  creditsRemaining: 247875,
});

/** Test API: canned boards/alerts, records every call, never touches the network. */
function stubApi(config: {
  configured?: boolean;
  boards?: Partial<Record<FomoApiWindow, FomoApiLeaderboardResult | Error>>;
  alerts?: FomoApiAlertsResult | Error;
}) {
  const calls: string[] = [];
  const api: DiscoveryApi = {
    configured: config.configured ?? true,
    async leaderboard(window: FomoApiWindow): Promise<FomoApiLeaderboardResult> {
      calls.push(window);
      const result = config.boards?.[window];
      if (!result) return emptyLeaderboard([]);
      if (result instanceof Error) throw result;
      return result;
    },
    async alerts(): Promise<FomoApiAlertsResult> {
      calls.push('alerts');
      if (config.alerts instanceof Error) throw config.alerts;
      return config.alerts ?? emptyAlerts();
    },
  };
  return { api, calls };
}

const service = (api: DiscoveryApi) => new DiscoveryService(handle.db, api, risk);

describe('shouldDiscover — demand + rate limit (AC7)', () => {
  const base = {
    promotableWatchWallets: 0,
    watchListWallets: 0,
    rosterInUse: 5,
    rosterSize: 5,
    benchTarget: 10,
    lastRunAt: null,
    nowMs: Date.parse('2026-11-02T12:00:00Z'),
    minIntervalMs: 1_800_000,
  };

  it('false when the roster and the bench are full', () => {
    expect(shouldDiscover({ ...base, rosterInUse: 3, promotableWatchWallets: 10 })).toBe(false);
    expect(discoveryDecision({ ...base, rosterInUse: 3, promotableWatchWallets: 10 }).reason).toMatch(
      /roster and bench are full/,
    );
  });

  it('true when the bench is below BENCH_TARGET', () => {
    expect(shouldDiscover({ ...base, rosterInUse: 5, promotableWatchWallets: 9 })).toBe(true);
  });

  it('true when a free roster slot has no promotable wallet behind it', () => {
    expect(shouldDiscover({ ...base, rosterInUse: 4, promotableWatchWallets: 0 })).toBe(true);
  });

  it('false while inside the rate-limit window, true again after it', () => {
    const inputs = { ...base, rosterInUse: 5, promotableWatchWallets: 0 };
    expect(shouldDiscover({ ...inputs, lastRunAt: '2026-11-02T11:45:00.000Z' })).toBe(false);
    expect(discoveryDecision({ ...inputs, lastRunAt: '2026-11-02T11:45:00.000Z' }).reason).toMatch(
      /rate limited/,
    );
    expect(shouldDiscover({ ...inputs, lastRunAt: '2026-11-02T11:00:00.000Z' })).toBe(true);
  });
});

describe('DiscoveryService.syncDiscovery', () => {
  it('makes zero network calls and audits the skip without a key (AC6)', async () => {
    const { api, calls } = stubApi({ configured: false });
    const result = await service(api).syncDiscovery(true);
    expect(calls).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/FOMOAPI_KEY/);
    expect(repo.listAudit(handle.db, 5).some((a) => /FOMOAPI_KEY not configured/.test(a.message))).toBe(true);
  });

  it('skips when demand says no, and still makes no call', async () => {
    // Fill the bench: roster is empty but 10 promotable wallets are waiting.
    for (let i = 0; i < risk.BENCH_TARGET; i++) {
      repo.upsertWatchWallet(handle.db, {
        candidateId: `cand_bench_${i}`,
        address: `BenchWallet${i}`,
        status: 'promoted',
      });
    }
    const { api, calls } = stubApi({});
    const result = await service(api).syncDiscovery(false);
    expect(calls).toEqual([]);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/bench/);
    for (let i = 0; i < risk.BENCH_TARGET; i++) repo.setWatchStatus(handle.db, `cand_bench_${i}`, 'archived');
  });

  it('unions the three boards by userId and upserts candidates (AC4)', async () => {
    const { api, calls } = stubApi({
      boards: {
        '24h': emptyLeaderboard([
          { userId: 'uA', handle: 'alpha', pnlUsd: 100, wallet: 'WalletA' },
          { userId: 'uB', handle: 'beta', pnlUsd: 50, wallet: 'WalletB' },
        ]),
        '7d': emptyLeaderboard([
          { userId: 'uA', handle: 'alpha', pnlUsd: 900, wallet: 'WalletA' },
          { userId: 'uC', handle: 'gamma', pnlUsd: 700, wallet: null },
        ]),
        '30d': emptyLeaderboard([{ userId: 'uD', handle: 'delta', pnlUsd: 5000, wallet: 'WalletD' }]),
      },
      alerts: emptyAlerts([{ userId: 'uE', handle: 'epsilon', token: 'MEOW', usdValue: 1200, ts: null }]),
    });

    const result = await service(api).syncDiscovery(true);

    expect(calls).toEqual(['24h', '7d', '30d', 'alerts']);
    expect(result.traders).toBe(4); // uA appears on two boards once; alerts count separately
    expect(result.tradersNew).toBe(4);
    expect(result.tradersUpdated).toBe(0);
    expect(result.alertsAdded).toBe(1);

    const alpha = repo.findCandidateByUserId(handle.db, 'uA');
    expect(alpha?.handle).toBe('alpha');
    // The 24h board is read first, so its window PnL is the stored reading.
    expect(alpha?.displayedWeeklyPnlUsdMicro).toBe('100000000');
    expect(repo.findCandidateByWallet(handle.db, 'WalletA')?.candidateId).toBe(alpha?.candidateId);
    expect(repo.findCandidateByWallet(handle.db, 'WalletB')?.handle).toBe('beta');

    // Alerts traders join the pool without a wallet — not scannable yet.
    const epsilon = repo.findCandidateByUserId(handle.db, 'uE');
    expect(epsilon?.handle).toBe('epsilon');
    expect(repo.listCandidateAddresses(handle.db, epsilon!.candidateId)).toHaveLength(0);
  });

  it('collapses one wallet under two handles into a single identity (AC4)', async () => {
    // A legacy handle-only row owns the wallet (no user id yet).
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_okura',
      handle: 'okura',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'fomo-web-manual',
      observedAt: '2026-10-30T00:00:00.000Z',
    });
    repo.upsertCandidateAddress(handle.db, 'cand_okura', {
      chain: 'solana',
      address: 'SharedWallet1',
      verification: 'reported',
    });

    const { api } = stubApi({
      boards: {
        '24h': emptyLeaderboard([
          { userId: 'uOkura1', handle: 'okura', pnlUsd: 10, wallet: 'SharedWallet1' },
          { userId: 'uOkura2', handle: 'okuracrypto', pnlUsd: 20, wallet: 'SharedWallet1' },
        ]),
      },
    });
    const result = await service(api).syncDiscovery(true);

    // First row adopts the legacy row; the second is a label alias, not a second candidate.
    expect(result.traders).toBe(2);
    expect(result.merged).toBe(1);
    const owners = repo
      .listCandidates(handle.db)
      .filter((c) =>
        repo.listCandidateAddresses(handle.db, c.candidateId).some((a) => a.address === 'SharedWallet1'),
      );
    expect(owners).toHaveLength(1);
    expect(owners[0]!.candidateId).toBe('cand_okura');
    expect(owners[0]!.userId).toBe('uOkura1');
    expect(repo.findCandidateByUserId(handle.db, 'uOkura2')).toBeUndefined();
  });

  it('keeps the successful windows when another window fails (AC5)', async () => {
    const { api } = stubApi({
      boards: {
        '24h': new Error('timeout'),
        '7d': emptyLeaderboard([{ userId: 'uSurvivor', handle: 'survivor', pnlUsd: 5, wallet: 'WalletS' }]),
      },
    });
    const result = await service(api).syncDiscovery(true);
    expect(result.windows.find((w) => w.window === '24h')).toMatchObject({ ok: false, error: 'timeout' });
    expect(result.windows.find((w) => w.window === '7d')).toMatchObject({ ok: true, rows: 1 });
    expect(repo.findCandidateByUserId(handle.db, 'uSurvivor')?.handle).toBe('survivor');
  });

  it('does not fail the run when alerts fail (AC5)', async () => {
    const { api } = stubApi({
      boards: {
        '24h': emptyLeaderboard([{ userId: 'uAlertOk', handle: 'alert_ok', pnlUsd: 1, wallet: null }]),
      },
      alerts: new Error('402 credits exhausted'),
    });
    const result = await service(api).syncDiscovery(true);
    expect(result.alertsError).toMatch(/credits exhausted/);
    expect(result.skipped).toBe(false);
    expect(repo.findCandidateByUserId(handle.db, 'uAlertOk')).toBeTruthy();
  });

  it('honours ETag 304 answers without touching the pool (AC3)', async () => {
    const before = repo.findCandidateByUserId(handle.db, 'uSurvivor')?.displayedWeeklyPnlUsdMicro ?? null;
    const { api } = stubApi({
      boards: {
        '7d': {
          rows: [],
          notModified: true,
          unparsed: 0,
          creditsCost: 0,
          creditsRemaining: 240000,
          etag: '"w1"',
        },
      },
    });
    const result = await service(api).syncDiscovery(true);
    expect(result.windows.find((w) => w.window === '7d')).toMatchObject({ ok: true, notModified: true });
    // 250 + 0 (304) + 250 for the two untouched boards, 125 for alerts.
    expect(result.creditsSpent).toBe(625);
    expect(repo.findCandidateByUserId(handle.db, 'uSurvivor')?.displayedWeeklyPnlUsdMicro).toBe(before);
  });

  it('stamps the run and rate-limits the next non-forced call', async () => {
    const { api, calls } = stubApi({ boards: { '24h': emptyLeaderboard([]) } });
    const svc = service(api);
    expect(repo.kvGet(handle.db, 'discovery.last_run_at')).toBeTruthy();
    const second = await svc.syncDiscovery(false);
    expect(second.skipped).toBe(true);
    expect(second.reason).toMatch(/rate limited/);
    expect(calls).toEqual([]); // the gate refused before any network work
    const forced = await svc.syncDiscovery(true);
    expect(forced.skipped).toBe(false);
    expect(calls).toContain('alerts');
  });
});
