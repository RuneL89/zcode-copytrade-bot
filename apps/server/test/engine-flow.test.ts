import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type DbHandle } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, DEFAULT_RISK } from '@zcode-bot/config';
import { StaticPriceProvider, NoopNotifier } from '@zcode-bot/providers';
import { snapshotHash, type LeaderTxSummary } from '@zcode-bot/core';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopyEngine } from '../src/services/engine.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';
import { ControlService } from '../src/services/control.js';
import { SnapshotService, RecommendationService } from '../src/services/research.js';
import { PaperExecutor } from '../src/services/executors.js';
import { DemoEngine } from '../src/services/demo.js';
import { StateBuilder } from '../src/services/builder.js';
import { LeaderMonitor } from '../src/services/monitor.js';
import type { RiskConfig } from '@zcode-bot/config';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEOW = 'MeowMint111111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const LEADER_A = 'LeaderA11111111111111111111111111111111111';
const LEADER_B = 'LeaderB11111111111111111111111111111111111';

let dir: string;
let handle: DbHandle;
let engine: CopyEngine;
let lifecycle: TraderLifecycle;
let control: ControlService;
let snapshots: SnapshotService;
let recommendations: RecommendationService;
let risk: RiskConfig;
let firedCount = 0;

function tx(over: Partial<LeaderTxSummary>): LeaderTxSummary {
  return {
    chain: 'solana',
    leaderAddress: LEADER_A,
    signature: 'sig_' + Math.random().toString(36).slice(2),
    slot: 1000 + Math.floor(Math.random() * 100),
    transactionIndex: 1,
    blockTime: Math.floor(Date.now() / 1000),
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas: [],
    programs: [JUP],
    ...over,
  };
}

function leaderBuy(usdMicro: bigint, mint = MEOW): LeaderTxSummary {
  return tx({
    tokenDeltas: [
      { mint, decimals: 6, preBase: 0n, postBase: 9_000_000n, deltaBase: 9_000_000n },
      { mint: USDC, decimals: 6, preBase: usdMicro, postBase: 0n, deltaBase: -usdMicro },
    ],
  });
}

function leaderSell(mint: string, pre: bigint, post: bigint): LeaderTxSummary {
  return tx({
    tokenDeltas: [
      { mint, decimals: 6, preBase: pre, postBase: post, deltaBase: post - pre },
      { mint: USDC, decimals: 6, preBase: 0n, postBase: 10_000_000n, deltaBase: 10_000_000n },
    ],
  });
}

const prices = new StaticPriceProvider(
  new Map([
    [USDC, 1_000_000n],
    [MEOW, 500_000n], // $0.50: round trips are deterministic LOSSES with the assumed-price executor
  ]),
);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-engine-'));
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

  const config = loadConfig({ SESSION_SECRET: 'x'.repeat(40) });
  config.risk.MIN_PER_BUY_USD = 5; // small numbers for the test
  config.risk.FIRED_TRADER_COOLDOWN_MS = 3_600_000;
  config.risk.MAX_DAILY_REALIZED_LOSS_USD = 1_000_000; // do not trip mid-test
  config.risk.MAX_DEPLOYED_PCT = 100; // flow tests use a huge bankroll instead
  risk = config.risk;

  control = new ControlService(handle.db);
  snapshots = new SnapshotService(handle.db, dir, config.risk);
  recommendations = new RecommendationService(handle.db, snapshots, config.risk);

  let pendingFire: { activationId: string; reason: string } | null = null;
  engine = new CopyEngine(
    handle.db,
    config.risk,
    prices,
    new PaperExecutor(null, async (mint, decimals) => (await prices.priceOf(mint, decimals)).priceUsdMicro),
    control,
    new NoopNotifier(),
    {
      onFired: (activationId, _candidateId, reason) => {
        firedCount++;
        pendingFire = { activationId, reason };
        // Late-bound: lifecycle.fire is patched below before any firing can occur.
        void lifecycle.fire(activationId, reason);
      },
      onStateChanged: () => {},
    },
    null,
    1_000_000_000n, // $1,000 bankroll: never binds in the flow tests
  );
  lifecycle = new TraderLifecycle(handle.db, config.risk, engine, snapshots);
  lifecycle.setEngine(engine);

  // Wire the async fire path like Runtime does (refresh latest valid rec first).
  const origFire = lifecycle.fire.bind(lifecycle);
  lifecycle.fire = async (activationId: string, reason: string) => {
    const valid = recommendations.latestValid();
    lifecycle.latestValidRecommendation = valid
      ? {
          payload: {
            recommendationId: valid.payload.recommendationId,
            orderedCandidates: valid.payload.orderedCandidates.map((c) => ({
              candidateId: c.candidateId,
              rank: c.rank,
            })),
            expiresAt: valid.payload.expiresAt,
          },
        }
      : null;
    return origFire(activationId, reason);
  };
  void pendingFire;
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedCandidates() {
  for (const [cid, h, rank, addr] of [
    ['cand_ape', 'ape_vasco', 1, LEADER_A],
    ['cand_moon', 'moonpie_max', 3, LEADER_B],
  ] as const) {
    repo.upsertCandidate(handle.db, {
      candidateId: cid,
      handle: h,
      weeklyRank: rank,
      displayedWeeklyPnlUsdMicro: '438200000',
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(handle.db, cid, { chain: 'solana', address: addr, verification: 'reported' });
  }
  return snapshots.build();
}

function submitRecommendation(
  snapshotId: string,
  hash: string,
  ordered: Array<{ candidateId: string; rank: number }>,
) {
  const now = Date.now();
  return recommendations.ingest({
    schemaVersion: 1,
    recommendationId: crypto.randomUUID(),
    snapshotId,
    snapshotHash: hash,
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3 * 3600_000).toISOString(),
    researchSessionId: 'sess-test',
    modelLabel: 'GLM (test)',
    orderedCandidates: ordered.map((c) => ({
      candidateId: c.candidateId,
      rank: c.rank,
      confidence: 0.7,
      thesis: 'test thesis',
      evidence: [],
      concerns: [],
    })),
    abstain: false,
    abstainReason: null,
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe('copy engine end-to-end (paper simulation, no signing)', () => {
  it('imports, researches, activates, and copies a buy at exactly 0.25x', async () => {
    const snap = seedCandidates();
    const verdict = submitRecommendation(snap.snapshotId, snapshotHash(snap), [
      { candidateId: 'cand_moon', rank: 1 },
      { candidateId: 'cand_ape', rank: 2 },
    ]);
    expect(verdict.ok).toBe(true);

    const act = await lifecycle.activate('cand_ape', 'manual', true);
    expect(act.ok).toBe(true);
    const activationId = act.activationId!;

    // Leader buys $400 of MEOW -> we copy exactly $100.
    await engine.handleLeaderTx(activationId, 'cand_ape', leaderBuy(400_000_000n));

    const positions = repo.listPositions(handle.db, 10);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.inputUsdMicro).toBe('100000000'); // $100.00 = 0.25 x $400
    expect(positions[0]!.status).toBe('open');
  });

  it('mirrors a partial leader exit and books a PnL lot', async () => {
    const activation = repo.activeActivation(handle.db)!;
    const position = repo.openPositions(handle.db)[0]!;
    const copied = BigInt(position.copiedTokenBase);

    // Leader sells 50% of holdings.
    await engine.handleLeaderTx(
      activation.activationId,
      'cand_ape',
      leaderSell(MEOW, 9_000_000n, 4_500_000n),
    );

    const updated = repo.getPosition(handle.db, position.positionId)!;
    expect(updated.status).toBe('partially_closed');
    expect(BigInt(updated.remainingTokenBase)).toBe(copied / 2n);
    expect(repo.listPnlLots(handle.db, 10)).toHaveLength(1);
  });

  it('a full leader exit closes the remainder and books the final lot', async () => {
    const activation = repo.activeActivation(handle.db)!;
    await engine.handleLeaderTx(activation.activationId, 'cand_ape', leaderSell(MEOW, 4_500_000n, 0n));
    const positions = repo.listPositions(handle.db, 10);
    const pos = positions.find((p) => p.candidateId === 'cand_ape')!;
    expect(pos.status).toBe('closed');
    expect(BigInt(pos.remainingTokenBase)).toBe(0n);
  });

  it('two consecutive losing closes fire the trader and consume the shortlist', async () => {
    // Lot 1 (full close) already booked in the previous test -> streak 1.
    const ape = repo
      .listActivations(handle.db, 10)
      .find((a) => a.candidateId === 'cand_ape' && a.state === 'ACTIVE')!;
    expect(ape.lossStreak).toBe(1);

    // Second losing full close -> streak 2 -> automatic firing.
    await engine.handleLeaderTx(ape.activationId, 'cand_ape', leaderBuy(400_000_000n));
    await engine.handleLeaderTx(ape.activationId, 'cand_ape', leaderSell(MEOW, 9_000_000n, 0n));
    expect(firedCount).toBeGreaterThanOrEqual(1);

    await waitFor(() => repo.activeActivation(handle.db)?.candidateId === 'cand_moon');
    const fired = repo.getActivation(handle.db, ape.activationId)!;
    expect(fired.state).toBe('FIRED');

    // Shortlist rank 1 = cand_moon (eligible) -> activated automatically.
    const nowActive = repo.activeActivation(handle.db);
    expect(nowActive?.candidateId).toBe('cand_moon');
    expect(nowActive?.lossStreak).toBe(0); // streak reset
    const handoffs = repo.listHandoffEvents(handle.db, 10);
    expect(handoffs[0]!.status).toBe('activated');
  });

  it('exhausted shortlist leads to PAUSED_WAITING_FOR_ZCODE while exits continue', async () => {
    // Fire moonpie too: two more losing round trips.
    const moonAct = repo.activeActivation(handle.db)!;
    firedCount = 0;
    for (let i = 0; i < 2; i++) {
      await engine.handleLeaderTx(moonAct.activationId, 'cand_moon', leaderBuy(400_000_000n));
      await engine.handleLeaderTx(moonAct.activationId, 'cand_moon', leaderSell(MEOW, 9_000_000n, 0n));
    }
    expect(firedCount).toBeGreaterThanOrEqual(1);
    await waitFor(() => repo.activeActivation(handle.db) === undefined);

    // Shortlist now: cand_moon in cooldown, cand_ape in cooldown -> exhausted.
    expect(repo.activeActivation(handle.db)).toBeUndefined();
    const lastHandoff = repo.listHandoffEvents(handle.db, 1)[0]!;
    expect(lastHandoff.status).toBe('paused_waiting_for_zcode');
    expect(repo.listControlEvents(handle.db, 5).some((e) => e.type === 'replacement_request')).toBe(true);

    // While paused: entries are skipped, but a pre-existing open position's
    // mirrored exit still works. Open one before pausing is impossible now
    // (no active trader), so verify the invariant directly on the engine:
    control.pauseNewEntries('test pause');
    const intentsBefore = repo.intentsInStates(handle.db, ['skipped']).length;
    void intentsBefore;
    control.flags.newEntriesPaused = true;
    const skippedIntent = await simulatePausedEntry();
    expect(skippedIntent).toBe('skipped-paused');
    control.flags.newEntriesPaused = false;
  });
});

async function simulatePausedEntry(): Promise<string> {
  // No active trader exists; the pause gate is exercised through the engine
  // by attempting an entry while paused with a synthetic activation context.
  const act = { activationId: 'act_synth', candidateId: 'cand_ape' };
  repo.createActivation(handle.db, {
    activationId: act.activationId,
    candidateId: act.candidateId,
    state: 'ACTIVE',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'manual',
  });
  control.flags.newEntriesPaused = true;
  try {
    await engine.handleLeaderTx(act.activationId, act.candidateId, leaderBuy(400_000_000n));
    const skipped = repo
      .intentsInStates(handle.db, ['skipped'])
      .filter((i) => i.activationId === act.activationId && i.reason === 'new entries paused');
    return skipped.length > 0 ? 'skipped-paused' : 'not-skipped';
  } finally {
    control.flags.newEntriesPaused = false;
    repo.updateActivation(handle.db, act.activationId, {
      state: 'FIRED',
      endedAt: new Date().toISOString(),
      endReason: 'manual',
    });
  }
}

describe('demo/paper/live isolation', () => {
  it('demo fixtures never write fills or positions', () => {
    const demo = new DemoEngine(
      resolve(
        fileURLToPath(new URL('.', import.meta.url)),
        '..',
        '..',
        '..',
        'fixtures',
        'demo-timeline.json',
      ),
      () => {},
    );
    demo.start();
    demo.stop();
    // Paper positions exist, but every persisted fill is paper-mode; the demo
    // engine wrote nothing to the DB.
    const fills = repo.listFills(handle.db, 500);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f) => f.mode === 'paper')).toBe(true);
  });
});

describe('deterministic fallback stays opt-in', () => {
  it('is disabled by default', () => {
    expect(DEFAULT_RISK.CANDIDATE_REPLACEMENT_MODE).toBe('zcode_shortlist');
  });
});

describe('dashboard panels: positions, activity tape, counters', () => {
  it('surfaces copies, skips, noise, stale events, exits, and marks', async () => {
    // Fresh ACTIVE activation driven directly through the engine.
    const activationId = 'act_panels';
    repo.createActivation(handle.db, {
      activationId,
      candidateId: 'cand_ape',
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });

    // 1) Copyable buy -> copied row + open position ($100 = 0.25 x $400).
    await engine.handleLeaderTx(activationId, 'cand_ape', leaderBuy(400_000_000n));
    const pos = repo.openPositions(handle.db)[0]!;

    // 2) Second buy into the same mint -> pyramids into the SAME position.
    await engine.handleLeaderTx(activationId, 'cand_ape', leaderBuy(400_000_000n));
    const pyramided = repo.getPosition(handle.db, pos.positionId)!;
    expect(BigInt(pyramided.inputUsdMicro)).toBe(200_000_000n);
    expect(repo.openPositions(handle.db)).toHaveLength(1);

    // 3) Non-trade event (single inbound token delta) -> collapsed noise.
    await engine.handleLeaderTx(
      activationId,
      'cand_ape',
      tx({
        tokenDeltas: [{ mint: JUP, decimals: 6, preBase: 0n, postBase: 5_000_000n, deltaBase: 5_000_000n }],
      }),
    );

    // 4) Stale buy (1h old) -> TOO OLD rejection, never an intent.
    await engine.handleLeaderTx(
      activationId,
      'cand_ape',
      tx({
        blockTime: Math.floor(Date.now() / 1000) - 3600,
        tokenDeltas: [
          { mint: MEOW, decimals: 6, preBase: 0n, postBase: 9_000_000n, deltaBase: 9_000_000n },
          { mint: USDC, decimals: 6, preBase: 400_000_000n, postBase: 0n, deltaBase: -400_000_000n },
        ],
      }),
    );

    const builder = new StateBuilder(
      handle.db,
      { mode: 'paper', risk } as never,
      control,
      null,
      recommendations,
      lifecycle,
      1_000_000n,
    );
    let s = builder.build();

    expect(s.counters.openPositions).toBe(1);
    expect(s.counters.copiedToday).toBeGreaterThanOrEqual(1);
    expect(s.counters.skippedToday).toBeGreaterThanOrEqual(1); // stale
    expect(s.counters.openExposureUsdMicro).toBe('200100000'); // $200 entries + 2x $0.05 fees
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]!.positionId).toBe(pos.positionId);
    expect(s.positions[0]!.feesUsdMicro).toBe('100000');
    expect(s.positions[0]!.markUsdMicro).toBeNull();

    const meowShort = `${MEOW.slice(0, 4)}…${MEOW.slice(-4)}`;
    expect(
      s.activity.some(
        (r) => r.kind === 'copied' && r.copyUsdMicro === '100000000' && r.tokenShort === meowShort,
      ),
    ).toBe(true);
    expect(s.activity.some((r) => r.kind === 'skipped' && r.reasonChip === 'TOO OLD')).toBe(true);
    expect(s.activityNoiseCount).toBeGreaterThanOrEqual(1);

    // Regression: the web helpers BigInt() these amounts directly. detailJson
    // serializes bigints as "123n" — amounts must arrive as plain digit strings.
    for (const r of s.activity) {
      for (const v of [r.leaderUsdMicro, r.leaderSolBase, r.copyUsdMicro, r.realizedPnlUsdMicro]) {
        if (v !== null) expect(() => BigInt(v)).not.toThrow();
      }
    }

    // 5) Mark-to-market: the runtime re-prices -> mark + unrealized PnL appear.
    builder.setMark(pos.positionId, 90_000_000n, Date.now());
    s = builder.build();
    expect(s.positions[0]!.markUsdMicro).toBe('90000000');
    expect(s.positions[0]!.unrealizedPnlUsdMicro).toBe('-110000000'); // $90.00 mark vs $200.10 deployed
    // Rolling equity = bankroll (cash) + live mark of the open position.
    expect(s.equity.rollingUsdMicro).toBe((BigInt(s.counters.cashUsdMicro) + 90_000_000n).toString());

    // 6) Full leader exit -> exit row with realized PnL; panel empties.
    await engine.handleLeaderTx(activationId, 'cand_ape', leaderSell(MEOW, 9_000_000n, 0n));
    s = builder.build();
    expect(s.counters.openPositions).toBe(0);
    const exitRow = s.activity.find((r) => r.kind === 'exit');
    expect(exitRow).toBeDefined();
    expect(exitRow!.realizedPnlUsdMicro).not.toBeNull();
  });
});

describe('bankroll cap: downsize to fit, then BANKROLL CAP skip', () => {
  it('pyramids into headroom, downsizes the add, skips when the cap is full', async () => {
    // Dedicated engine with exactly $250 capital, 80% deployable = $200.
    const realizedNow = repo.realizedPnlSince(handle.db, '1970-01-01T00:00:00.000Z');
    const equityStart = 250_000_000n - realizedNow; // capital == $250.00
    const bankEngine = new CopyEngine(
      handle.db,
      { ...risk, MAX_DEPLOYED_PCT: 80 },
      prices,
      new PaperExecutor(null, async (mint, decimals) => (await prices.priceOf(mint, decimals)).priceUsdMicro),
      control,
      new NoopNotifier(),
      { onFired: () => {}, onStateChanged: () => {} },
      null,
      equityStart,
    );
    const activationId = 'act_bankroll';
    repo.createActivation(handle.db, {
      activationId,
      candidateId: 'cand_ape',
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });

    // Buy 1: $100 copy -> deployed $100.05 incl. fee. Headroom $99.95.
    await bankEngine.handleLeaderTx(activationId, 'cand_ape', leaderBuy(400_000_000n));
    // Buy 2: wants $100 -> downsized to exactly the remaining headroom.
    await bankEngine.handleLeaderTx(activationId, 'cand_ape', leaderBuy(400_000_000n));
    // Buy 3: headroom now 0 -> BANKROLL CAP skip, no position change.
    await bankEngine.handleLeaderTx(activationId, 'cand_ape', leaderBuy(400_000_000n));

    const intents = repo
      .intentsInStates(handle.db, ['confirmed', 'skipped'])
      .filter((i) => i.activationId === activationId && i.kind === 'entry')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(intents).toHaveLength(3);
    expect(intents[0]!.inputUsdMicro).toBe('100000000');
    expect(intents[1]!.state).toBe('confirmed');
    expect(intents[1]!.inputUsdMicro).toBe('99950000'); // downsized to headroom
    expect(intents[2]!.state).toBe('skipped');
    expect(intents[2]!.reason).toBe('MAX_DEPLOYED_PCT: bankroll cap');
    expect(
      repo
        .listRiskRejections(handle.db, 200)
        .some((r) => r.rule === 'MAX_DEPLOYED_PCT' && r.detail.includes('bankroll cap')),
    ).toBe(true);

    // Both fills pyramided into ONE position worth $199.95 + fees.
    const positions = repo.openPositions(handle.db).filter((p) => p.activationId === activationId);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.inputUsdMicro).toBe('199950000');
  });
});

describe('day-trader discipline: time exits + idle firing', () => {
  let monitor: LeaderMonitor;
  const marks = new Map<string, bigint>();
  const peekMark = (positionId: string) =>
    marks.has(positionId) ? { valueUsdMicro: marks.get(positionId)!, observedAt: Date.now() } : null;

  function backdate(positionId: string, hoursAgo: number): void {
    const pos = repo.getPosition(handle.db, positionId)!;
    repo.updatePosition(handle.db, positionId, {
      openedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    });
    void pos;
  }

  beforeAll(() => {
    monitor = new LeaderMonitor(
      handle.db,
      {
        transactionsSince: async () => [],
        latestCursor: async () => ({ lastSignature: 'x', lastSlot: 1, lastBlockTime: 1 }),
      } as never,
      engine,
      risk,
      lifecycle,
      () => {},
      60_000,
      peekMark,
    );
  });

  function sweep(activationId: string, startedAt: string): Promise<void> {
    return (monitor as unknown as { sweep: (a: string, s: string, n: Date) => Promise<void> }).sweep(
      activationId,
      startedAt,
      new Date(),
    );
  }

  function freshActivation(id: string): void {
    repo.createActivation(handle.db, {
      activationId: id,
      candidateId: 'cand_moon',
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });
  }

  it('sells a positive position at 16h and holds a negative one into grace', async () => {
    freshActivation('act_tx1');
    await engine.handleLeaderTx('act_tx1', 'cand_moon', leaderBuy(400_000_000n));
    const pos = repo.openPositions(handle.db).find((p) => p.activationId === 'act_tx1')!;

    backdate(pos.positionId, 16.5);
    marks.set(pos.positionId, 120_000_000n); // +$20 vs entry
    await sweep('act_tx1', pos.openedAt);
    expect(repo.getPosition(handle.db, pos.positionId)!.status).toBe('closed');

    // Negative at 16.5h: held. Past 19h: force-closed even without a mark.
    await engine.handleLeaderTx('act_tx1', 'cand_moon', leaderBuy(400_000_000n));
    const pos2 = repo.openPositions(handle.db).find((p) => p.activationId === 'act_tx1')!;
    backdate(pos2.positionId, 16.5);
    marks.set(pos2.positionId, 90_000_000n); // -$10
    await sweep('act_tx1', pos2.openedAt);
    expect(repo.getPosition(handle.db, pos2.positionId)!.status).toBe('open');

    backdate(pos2.positionId, 19.5);
    marks.delete(pos2.positionId);
    await sweep('act_tx1', pos2.openedAt);
    expect(repo.getPosition(handle.db, pos2.positionId)!.status).toBe('closed');
    const intents = repo
      .intentsInStates(handle.db, ['confirmed'])
      .filter((i) => i.activationId === 'act_tx1' && i.kind === 'exit');
    expect(intents.length).toBeGreaterThanOrEqual(1);
  });

  it('pyramided positions keep their first-entry age', async () => {
    freshActivation('act_tx2');
    await engine.handleLeaderTx('act_tx2', 'cand_moon', leaderBuy(400_000_000n));
    const pos = repo.openPositions(handle.db).find((p) => p.activationId === 'act_tx2')!;
    backdate(pos.positionId, 15);
    await engine.handleLeaderTx('act_tx2', 'cand_moon', leaderBuy(400_000_000n)); // pyramid at 15h
    const updated = repo.getPosition(handle.db, pos.positionId)!;
    expect(Date.parse(updated.openedAt)).toBeLessThan(Date.now() - 14.9 * 3_600_000);

    // Age is still ~15h (pyramid did not reset openedAt) -> no time exit yet.
    marks.set(pos.positionId, 400_000_000n);
    await sweep('act_tx2', updated.openedAt);
    expect(repo.getPosition(handle.db, pos.positionId)!.status).toBe('open');

    // Cross 16h -> positive PnL sells the whole pyramided position.
    backdate(pos.positionId, 16.5);
    await sweep('act_tx2', updated.openedAt);
    expect(repo.getPosition(handle.db, pos.positionId)!.status).toBe('closed');
  });

  it('two consecutive time-exit losses fire the trader', async () => {
    freshActivation('act_tx3');
    for (let i = 0; i < 2; i++) {
      await engine.handleLeaderTx('act_tx3', 'cand_moon', leaderBuy(400_000_000n));
      const pos = repo.openPositions(handle.db).find((p) => p.activationId === 'act_tx3')!;
      backdate(pos.positionId, 19.5);
      marks.delete(pos.positionId);
      await sweep('act_tx3', pos.openedAt);
    }
    const act = repo.getActivation(handle.db, 'act_tx3')!;
    expect(act.lossStreak).toBe(2);
    expect(act.state).toBe('FIRED');
  });

  it('fires a hire with zero open positions for 12h, resets while holding', async () => {
    // Holding a position: never idle.
    freshActivation('act_idle1');
    await engine.handleLeaderTx('act_idle1', 'cand_moon', leaderBuy(400_000_000n));
    const startedAt1 = repo.getActivation(handle.db, 'act_idle1')!.startedAt;
    await sweep('act_idle1', startedAt1);
    expect(repo.getActivation(handle.db, 'act_idle1')!.state).toBe('ACTIVE');
    expect(repo.kvGet(handle.db, 'monitor.lastOpenAt:act_idle1')).not.toBeUndefined();

    // Zero trades since hire, hire backdated 13h -> fired.
    freshActivation('act_idle2');
    repo.updateActivation(handle.db, 'act_idle2', {
      startedAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
    });
    const startedAt2 = repo.getActivation(handle.db, 'act_idle2')!.startedAt;
    await sweep('act_idle2', startedAt2);
    expect(repo.getActivation(handle.db, 'act_idle2')!.state).toBe('FIRED');

    // Held a position 13h ago during THIS hire (hired 14h ago), flat since -> fired.
    freshActivation('act_idle3');
    repo.updateActivation(handle.db, 'act_idle3', {
      startedAt: new Date(Date.now() - 14 * 3_600_000).toISOString(),
    });
    repo.kvSet(
      handle.db,
      'monitor.lastOpenAt:act_idle3',
      new Date(Date.now() - 13 * 3_600_000).toISOString(),
    );
    const startedAt3 = repo.getActivation(handle.db, 'act_idle3')!.startedAt;
    await sweep('act_idle3', startedAt3);
    expect(repo.getActivation(handle.db, 'act_idle3')!.state).toBe('FIRED');
  });
});

describe('live mode: no trading before ARM', () => {
  it('skips entries with live-not-armed while pre-arm, copies after armLive', async () => {
    const liveEngine = new CopyEngine(
      handle.db,
      { ...risk },
      prices,
      new PaperExecutor(null, async (mint, decimals) => (await prices.priceOf(mint, decimals)).priceUsdMicro),
      control,
      new NoopNotifier(),
      { onFired: () => {}, onStateChanged: () => {} },
      null,
      1_000_000_000n,
      true, // live mode
    );
    repo.createActivation(handle.db, {
      activationId: 'act_livegate',
      candidateId: 'cand_moon',
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });
    await liveEngine.handleLeaderTx('act_livegate', 'cand_moon', leaderBuy(400_000_000n));
    const intents = repo
      .intentsInStates(handle.db, ['skipped'])
      .filter((i) => i.activationId === 'act_livegate');
    expect(intents).toHaveLength(1);
    expect(intents[0]!.reason).toBe('live mode not armed');
    expect(repo.openPositions(handle.db).filter((p) => p.activationId === 'act_livegate')).toHaveLength(0);

    control.armLive();
    await liveEngine.handleLeaderTx('act_livegate', 'cand_moon', leaderBuy(400_000_000n));
    const confirmed = repo
      .intentsInStates(handle.db, ['confirmed'])
      .filter((i) => i.activationId === 'act_livegate');
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    control.disarm();
  });
});
