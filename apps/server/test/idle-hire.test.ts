import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig } from '@zcode-bot/config';
import { HeliusProvider } from '@zcode-bot/providers';
import { SnapshotService } from '../src/services/research.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;
let snapshots: SnapshotService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-hire-guards-'));
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
  config = loadConfig({ SESSION_SECRET: 'x'.repeat(40) });
  snapshots = new SnapshotService(handle.db, dir, config.risk);
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedScanCandidate() {
  const observedAt = new Date().toISOString();
  repo.upsertCandidate(handle.db, {
    candidateId: 'cand_boardking',
    handle: 'boardking',
    weeklyRank: 1,
    displayedWeeklyPnlUsdMicro: '262897540000',
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt,
    pnl24hUsd: 262897.54,
    statsCheckedAt: observedAt,
    swaps24h: 19,
    lastSwapAt: new Date(Date.now() - 3600_000).toISOString(),
    activityCheckedAt: observedAt,
  });
  repo.upsertCandidateAddress(handle.db, 'cand_boardking', {
    chain: 'solana',
    address: 'BoardKing1111111111111111111111111111111',
    verification: 'verified',
  });
  repo.recordLeaderboardObservation(handle.db, {
    handle: 'boardking',
    weeklyRank: 1,
    displayedPnlUsdMicro: '262897540000',
    source: 'test',
    observedAt,
  });
  return observedAt;
}

describe('snapshot exposes the latest scan', () => {
  it('carries latestScan handles so the researcher can rank board-first', () => {
    seedScanCandidate();
    const snap = snapshots.build();
    expect(snap.latestScan).not.toBeNull();
    expect(snap.latestScan!.handles).toEqual(['boardking']);
    expect(snap.latestScan!.observedAt).toBe(snap.candidates[0]!.observedAt);
  });

  it('latestScan is null before any scan exists', () => {
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_x',
      handle: 'x',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    const snap = snapshots.build();
    expect(snap.latestScan).toBeNull();
  });
});

describe('idle hire guards', () => {
  it('hires from a validated ordering when idle', async () => {
    seedScanCandidate();
    const snap = snapshots.build();
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_' + crypto.randomUUID(),
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_boardking');
    expect(snap).toBeTruthy();
  });

  it('refuses to hire while a fire is stuck in reconciliation', async () => {
    seedScanCandidate();
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.latestValidRecommendation = {
      payload: {
        recommendationId: 'rec_' + crypto.randomUUID(),
        orderedCandidates: [{ candidateId: 'cand_boardking', rank: 1 }],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    repo.createActivation(handle.db, {
      activationId: 'act_' + crypto.randomUUID(),
      candidateId: 'cand_pointfarmcap',
      state: 'REQUIRES_RECONCILIATION',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: 'rank: left the board',
      source: 'zcode_shortlist',
    });

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('IDLE');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_pointfarmcap');
  });
});

function seedScanTrader(candidateId: string, handleName: string, weeklyRank: number, observedAt: string) {
  repo.upsertCandidate(handle.db, {
    candidateId,
    handle: handleName,
    weeklyRank,
    displayedWeeklyPnlUsdMicro: '1000000000',
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'test',
    observedAt,
    pnl24hUsd: 1000,
    statsCheckedAt: observedAt,
    swaps24h: 19,
    lastSwapAt: new Date(Date.now() - 3600_000).toISOString(),
    activityCheckedAt: observedAt,
  });
  repo.upsertCandidateAddress(handle.db, candidateId, {
    chain: 'solana',
    address: handleName + 'Addr1111111111111111111111111111111',
    verification: 'verified',
  });
  repo.recordLeaderboardObservation(handle.db, {
    handle: handleName,
    weeklyRank,
    displayedPnlUsdMicro: '1000000000',
    source: 'test',
    observedAt,
  });
}

function insertFiredActivation(candidateId: string, endedAt = new Date().toISOString()) {
  repo.createActivation(handle.db, {
    activationId: 'act_' + crypto.randomUUID(),
    candidateId,
    state: 'FIRED',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt,
    endReason: 'fired',
    lossStreak: 0,
    firedReason: 'idle: no open positions for 12h',
    source: 'zcode_shortlist',
  });
}

function ordering(entries: Array<{ candidateId: string; rank: number }>) {
  return {
    payload: {
      recommendationId: 'rec_' + crypto.randomUUID(),
      orderedCandidates: entries,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
}

describe('just-fired exclusion', () => {
  it('the just-fired trader is not the immediate rehire, even when the fresh ordering ranks him first', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    insertFiredActivation('cand_jim');

    // The snapshot flags exactly the banned candidate.
    const snap = snapshots.build();
    expect(snap.candidates.find((c) => c.candidateId === 'cand_jim')!.justFired).toBe(true);
    expect(snap.candidates.find((c) => c.candidateId === 'cand_boardking')!.justFired).toBe(false);

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.latestValidRecommendation = ordering([{ candidateId: 'cand_jim', rank: 1 }]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('NO_CANDIDATE');
    expect(repo.activeActivation(handle.db)).toBeUndefined();

    const rejections = repo.listCandidateRejections(handle.db, 20);
    expect(rejections.some((r) => r.candidateId === 'cand_jim' && r.reason === 'JUST_FIRED')).toBe(true);
    expect(repo.listControlEvents(handle.db, 20).some((e) => e.type === 'research_request')).toBe(true);
  });

  it('skips the just-fired trader for the next candidate; the ban lifts once someone else holds the seat', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    seedScanTrader('cand_bob', 'bob', 3, observedAt);
    insertFiredActivation('cand_jim');

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_jim', rank: 1 },
      { candidateId: 'cand_bob', rank: 2 },
    ]);

    // Jim is rank 1 but just fired -> bob (rank 2) takes the seat.
    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_bob');
    const bob = repo.activeActivation(handle.db)!;

    // Jim's ban is lifted (bob holds the seat). Fire bob: the walk must skip
    // bob and may hire jim again.
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_bob', rank: 1 },
      { candidateId: 'cand_jim', rank: 2 },
    ]);
    await lifecycle.fire(bob.activationId, 'test: two losing units');
    expect(repo.getActivation(handle.db, bob.activationId)!.state).toBe('FIRED');
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_jim');

    // The seat was filled immediately by a different trader (jim took over in
    // the same handoff), so bob is an ordinary candidate again — nobody is
    // excluded right now. A persisting ban only exists when the handoff pauses.
    const snap2 = snapshots.build();
    expect(snap2.candidates.find((c) => c.candidateId === 'cand_jim')!.justFired).toBe(false);
    expect(snap2.candidates.find((c) => c.candidateId === 'cand_bob')!.justFired).toBe(false);
  });

  it('manual activation overrides the exclusion', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    insertFiredActivation('cand_jim');

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([{ candidateId: 'cand_jim', rank: 1 }]);
    expect((await lifecycle.coldStartHire()).status).toBe('NO_CANDIDATE');

    const manual = await lifecycle.activate('cand_jim', 'manual', true);
    expect(manual.ok).toBe(true);
    expect(repo.activeActivation(handle.db)?.candidateId).toBe('cand_jim');
  });
});

describe('actively-trading tier', () => {
  // Partial fake in the withdraw.test.ts pattern: stub only what the lifecycle
  // calls. The null provider used elsewhere fails open, which is exactly the
  // pre-change behavior these tests must not disturb.
  function fakeHelius(
    lastBuyFor: (address: string) => { ok: boolean; lastBuyAt: string | null },
  ): HeliusProvider {
    return {
      configured: true,
      walletActivity24h: async () => ({ swaps24h: 19, lastSwapAgeHours: 1 }),
      lastBuyWithinWindow: async (address: string) => lastBuyFor(address),
    } as unknown as HeliusProvider;
  }

  function markActivelyTrading(candidateId: string, ageHours: number | null) {
    repo.updateCandidateActivity(handle.db, candidateId, {
      swaps24h: 19,
      lastSwapAt: new Date(Date.now() - 3600_000).toISOString(),
      lastBuyAt: ageHours === null ? null : new Date(Date.now() - ageHours * 3600_000).toISOString(),
      buys24h: ageHours === null ? 0 : 3,
      sells24h: 1,
      status: 'ok',
      checkedAt: new Date().toISOString(),
    });
  }

  function expectRejection(candidateId: string, reason: string) {
    expect(
      repo
        .listCandidateRejections(handle.db, 20)
        .some((r) => r.candidateId === candidateId && r.reason === reason),
    ).toBe(true);
  }

  it('hires the actively-trading candidate over a higher-ranked idle one', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_idle', 'idleone', 2, observedAt);
    seedScanTrader('cand_busy', 'busyone', 3, observedAt);
    markActivelyTrading('cand_busy', 1); // bought 1h ago -> active tier
    // cand_idle has no last_buy_at -> merit tier, though ranked first.

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.setHelius(fakeHelius(() => ({ ok: true, lastBuyAt: new Date().toISOString() })));
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_idle', rank: 1 },
      { candidateId: 'cand_busy', rank: 2 },
    ]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_busy');
  });

  it('merit pass hires a candidate whose live wallet shows a fresh buy', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    seedScanTrader('cand_bob', 'bob', 3, observedAt);
    // Nobody marked active in the snapshot: the second pass is the whole
    // ordering, and its live check finds fresh buys -> merit order decides.
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.setHelius(fakeHelius(() => ({ ok: true, lastBuyAt: new Date().toISOString() })));
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_jim', rank: 1 },
      { candidateId: 'cand_bob', rank: 2 },
    ]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_jim');
  });

  it('merit pass skips wallets whose measured reading has no entry', async () => {
    // The 2026-10-31 kv4rl path: a quiet wallet hired from the merit pass
    // because only the active tier was verified. Now every pass verifies, and
    // the verdict comes from the stored copyable-trade reading.
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    seedScanTrader('cand_bob', 'bob', 3, observedAt);
    markActivelyTrading('cand_jim', null); // measured: no coin entry
    markActivelyTrading('cand_bob', null);
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_jim', rank: 1 },
      { candidateId: 'cand_bob', rank: 2 },
    ]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('NO_CANDIDATE');
    expectRejection('cand_jim', 'NOT_ACTIVELY_TRADING');
    expectRejection('cand_bob', 'NOT_ACTIVELY_TRADING');
  });

  it('demotes a snapshot-active candidate whose measured reading has no entry', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    seedScanTrader('cand_bob', 'bob', 3, observedAt);
    markActivelyTrading('cand_jim', 1); // snapshot says active...
    markActivelyTrading('cand_bob', 1);
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    snapshots.build();
    // ...but the stored reading is refreshed before the hire and shows no entry
    // for jim. The snapshot keeps its stale flag; the hire gate must not trust it.
    markActivelyTrading('cand_jim', null);
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_jim', rank: 1 },
      { candidateId: 'cand_bob', rank: 2 },
    ]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_bob');
    expectRejection('cand_jim', 'NOT_ACTIVELY_TRADING');
  });

  it('uses the cached direction evidence when the live check errors', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    markActivelyTrading('cand_jim', 1); // cached: bought 1h ago, check was ok
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.setHelius(
      fakeHelius(() => {
        throw new Error('helius down');
      }),
    );
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([{ candidateId: 'cand_jim', rank: 1 }]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_jim');
  });

  it('rejects a stale cached wallet when the live check errors (fail closed on data)', async () => {
    // The 2026-10-31 regression: a wallet 15h past its last buy was hired
    // because the live walk errored and unknown failed open. Now the last
    // SUCCESSFUL check decides.
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_old', 'oldone', 2, observedAt);
    markActivelyTrading('cand_old', 15); // cached: last buy 15h ago, outside the 4h window
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.setHelius(
      fakeHelius(() => {
        throw new Error('helius down');
      }),
    );
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([{ candidateId: 'cand_old', rank: 1 }]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('NO_CANDIDATE');
    expectRejection('cand_old', 'NOT_ACTIVELY_TRADING');
  });

  it('fails open only when the live check errors AND nothing is cached', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    // No activity row at all: status null -> unknown.
    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.setHelius(
      fakeHelius(() => {
        throw new Error('helius down');
      }),
    );
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([{ candidateId: 'cand_jim', rank: 1 }]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_jim');
  });

  it('respects the just-fired ban inside the active tier', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_jim', 'jim', 2, observedAt);
    seedScanTrader('cand_bob', 'bob', 3, observedAt);
    markActivelyTrading('cand_jim', 1);
    insertFiredActivation('cand_jim');

    const lifecycle = new TraderLifecycle(handle.db, config.risk, null, snapshots);
    lifecycle.setHelius(fakeHelius(() => ({ ok: true, lastBuyAt: new Date().toISOString() })));
    snapshots.build();
    lifecycle.latestValidRecommendation = ordering([
      { candidateId: 'cand_jim', rank: 1 },
      { candidateId: 'cand_bob', rank: 2 },
    ]);

    const hired = await lifecycle.coldStartHire();
    expect(hired.status).toBe('ACTIVATED');
    expect(hired.candidateId).toBe('cand_bob');
    expectRejection('cand_jim', 'JUST_FIRED');
  });

  it('snapshot computes three-state activelyTrading from status + last_buy_at', async () => {
    const observedAt = seedScanCandidate();
    seedScanTrader('cand_fresh', 'freshone', 2, observedAt);
    seedScanTrader('cand_stale', 'staleone', 3, observedAt);
    markActivelyTrading('cand_fresh', 1); // 1h ago -> inside the 4h window
    markActivelyTrading('cand_stale', 9); // 9h ago -> outside

    const snap = snapshots.build();
    const byId = new Map(snap.candidates.map((c) => [c.candidateId, c]));
    expect(byId.get('cand_fresh')!.publicStats.activelyTrading).toBe(true);
    expect(byId.get('cand_fresh')!.publicStats.activityCheckStatus).toBe('ok');
    expect(byId.get('cand_fresh')!.publicStats.lastBuyAt).not.toBeNull();
    expect(byId.get('cand_stale')!.publicStats.activelyTrading).toBe(false);
    // Never checked: unknown, not false.
    expect(byId.get('cand_boardking')!.publicStats.activelyTrading).toBeNull();
    expect(byId.get('cand_boardking')!.publicStats.lastBuyAt).toBeNull();

    // A failed check also degrades to unknown and preserves the old columns.
    repo.markCandidateActivityFailed(handle.db, 'cand_stale', new Date().toISOString());
    const snap2 = snapshots.build();
    const stale2 = snap2.candidates.find((c) => c.candidateId === 'cand_stale')!;
    expect(stale2.publicStats.activityCheckStatus).toBe('failed');
    expect(stale2.publicStats.activelyTrading).toBeNull();
    expect(stale2.publicStats.lastBuyAt).not.toBeNull(); // preserved
  });
});
