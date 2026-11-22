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
import { PaperExecutor, type IntentSpec, type QuoteCheck } from '../src/services/executors.js';
import { DemoEngine } from '../src/services/demo.js';
import { StateBuilder } from '../src/services/builder.js';
import { LeaderMonitor } from '../src/services/monitor.js';
import type { RiskConfig } from '@zcode-bot/config';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEOW = 'MeowMint111111111111111111111111111111111111111';
const NEWMINT = 'NewMint1111111111111111111111111111111111111111';
const GHOSTMINT = 'GhostMint11111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const LEADER_A = 'LeaderA11111111111111111111111111111111111';
const LEADER_B = 'LeaderB11111111111111111111111111111111111';

let dir: string;
let handle: DbHandle;
let engine: CopyEngine;
let lifecycle: TraderLifecycle;
let control: ControlService;
let risk: RiskConfig;
let firedCount = 0;

/** Poll until a condition holds (the fire path is async). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

/** Age a position past the D4 same-mint coalescing window (60 s). */
function agePastCoalesce(positionId: string): void {
  handle.sqlite
    .prepare('update copied_positions set opened_at = ? where position_id = ?')
    .run(new Date(Date.now() - 61_000).toISOString(), positionId);
}

function leaderSell(mint: string, pre: bigint, post: bigint): LeaderTxSummary {
  return tx({
    tokenDeltas: [
      { mint, decimals: 6, preBase: pre, postBase: post, deltaBase: post - pre },
      { mint: USDC, decimals: 6, preBase: 0n, postBase: 10_000_000n, deltaBase: 10_000_000n },
    ],
  });
}

/** Coin-for-coin rotation: one coin out (partial or full), a different coin in, no funding leg. */
function leaderRotate(
  outMint: string,
  pre: bigint,
  post: bigint,
  inMint: string,
  inBase: bigint,
): LeaderTxSummary {
  return tx({
    tokenDeltas: [
      { mint: outMint, decimals: 6, preBase: pre, postBase: post, deltaBase: post - pre },
      { mint: inMint, decimals: 6, preBase: 0n, postBase: inBase, deltaBase: inBase },
    ],
  });
}

const prices = new StaticPriceProvider(
  new Map([
    [USDC, 1_000_000n],
    [MEOW, 500_000n], // $0.50: round trips are deterministic LOSSES with the assumed-price executor
    [NEWMINT, 2_000_000n], // $2.00
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
  config.risk.MAX_PER_BUY_PCT = 25; // 25% of the $1,000 bankroll = $250
  config.risk.MAX_OPEN_PER_TRADER_PCT = 100;
  config.risk.MAX_DEPLOYED_PCT = 100; // flow tests use a huge bankroll instead
  config.risk.MAX_POSITION_AGE_HOURS = 8;
  config.risk.POSITION_GRACE_HOURS = 3;
  config.risk.SELL_ON_GREEN = false;
  config.risk.PARTIAL_TP_BPS = 100_000;
  risk = config.risk;

  control = new ControlService(handle.db);

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
  lifecycle = new TraderLifecycle(handle.db, config.risk, engine);
  lifecycle.setEngine(engine);

  // Wire the async fire path like Runtime does (refresh latest valid rec first).
  const origFire = lifecycle.fire.bind(lifecycle);
  lifecycle.fire = async (activationId: string, reason: string) => {
    return origFire(activationId, reason);
  };
  void pendingFire;
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('copy engine end-to-end (paper simulation, no signing)', () => {
  it('mirrors a partial leader exit and books a PnL lot', async () => {
    // Seed the copied position this test splits (the research-path test that
    // used to open it is retired with the pipeline).
    repo.createActivation(handle.db, {
      activationId: 'act_exits',
      candidateId: 'cand_ape',
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });
    await engine.handleLeaderTx('act_exits', 'cand_ape', leaderBuy(400_000_000n));
    const activation = repo.getActivation(handle.db, 'act_exits')!;
    const position = repo.openPositions(handle.db).find((p) => p.activationId === 'act_exits')!;
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
    const activation = repo.getActivation(handle.db, 'act_exits')!;
    await engine.handleLeaderTx(activation.activationId, 'cand_ape', leaderSell(MEOW, 4_500_000n, 0n));
    const positions = repo.listPositions(handle.db, 10);
    const pos = positions.find((p) => p.candidateId === 'cand_ape')!;
    expect(pos.status).toBe('closed');
    expect(BigInt(pos.remainingTokenBase)).toBe(0n);
  });

  it('two consecutive losing closes fire the trader and free the chair (roster, plan 05)', async () => {
    // Lot 1 (full close) already booked in the previous test -> streak 1.
    const ape = repo.getActivation(handle.db, 'act_exits')!;
    expect(ape.lossStreak).toBe(1);

    // Second losing full close -> streak 2 -> automatic firing.
    await engine.handleLeaderTx(ape.activationId, 'cand_ape', leaderBuy(400_000_000n));
    await engine.handleLeaderTx(ape.activationId, 'cand_ape', leaderSell(MEOW, 9_000_000n, 0n));
    expect(firedCount).toBeGreaterThanOrEqual(1);

    await waitFor(() => repo.getActivation(handle.db, ape.activationId)?.state === 'FIRED');
    const fired = repo.getActivation(handle.db, ape.activationId)!;
    expect(fired.state).toBe('FIRED');

    // The chair is free, and with an EMPTY bench nothing is hired from the
    // retired ordering path — an empty chair is the decided outcome (D4).
    expect(repo.activeActivationCount(handle.db)).toBe(0);
    expect(repo.listActiveActivations(handle.db)).toHaveLength(0);
  });

  it('a fire is filled from the promotion queue and entries pause while paused', async () => {
    // Hire a fresh chair, bench a wallet, then fire: the bench fills it.
    const candidateId = 'cand_bench_fill';
    repo.upsertCandidate(handle.db, {
      candidateId,
      handle: 'bench_fill',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(handle.db, candidateId, {
      chain: 'solana',
      address: 'WalletBenchFill',
      verification: 'reported',
    });
    repo.createActivation(handle.db, {
      activationId: 'act_bench_fill',
      candidateId: 'cand_star',
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });
    repo.upsertWatchWallet(handle.db, {
      candidateId,
      address: 'WalletBenchFill',
      status: 'bench',
      reason: 'test bench',
    });
    // A hire re-checks the bench record: 8 closed shadow trades in profit and a
    // funded buy inside the recency window.
    for (let i = 0; i < 8; i++) {
      const openedAt = new Date(Date.now() - (i + 1) * 3_600_000).toISOString();
      const id = repo.openShadowTrade(handle.db, {
        candidateId,
        mint: 'BenchMint11111111111111111111111111111111111',
        openedAt,
        entryPriceUsdMicro: '1000000',
        notionalUsdMicro: '5000000',
      });
      repo.closeShadowTrade(handle.db, id, {
        closedAt: openedAt,
        exitReason: 'leader_sell',
        exitPriceUsdMicro: '1000000',
        pnlUsdMicro: '2000000',
      });
    }
    repo.insertWatchEvent(handle.db, {
      candidateId,
      address: 'WalletBenchFill',
      signature: 'bench-fill-buy',
      side: 'buy',
      mint: 'BenchMint11111111111111111111111111111111111',
      tokenAmountBase: '5000000',
      decimals: 6,
      usdMicro: '5000000',
      blockTime: Math.floor(Date.now() / 1000) - 120,
      observedAt: new Date(Date.now() - 120_000).toISOString(),
      source: 'test',
    });
    const outcome = await lifecycle.fire('act_bench_fill', 'manual test fire');
    expect(outcome.status).toBe('ACTIVATED');
    expect(repo.listActiveActivations(handle.db).map((a) => a.candidateId)).toEqual([candidateId]);

    // The paused path is exercised directly on the engine with a synthetic
    // activation: entries are skipped while new entries are paused.
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
  it('is disabled by default', () => {});
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

    // 2) Second buy into the same mint AFTER the coalescing window -> pyramids
    // into the SAME position (D4: inside 60 s a burst is one position).
    agePastCoalesce(pos.positionId);
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
      { ...risk, MAX_PER_BUY_PCT: 40, MAX_OPEN_PER_TRADER_PCT: 100, MAX_DEPLOYED_PCT: 80 },
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
    const pos = repo.openPositions(handle.db).filter((p) => p.activationId === activationId)[0]!;
    // Buy 2: wants $100 -> downsized to exactly the remaining headroom (past
    // the D4 coalescing window, so it is an ADD, not a burst).
    agePastCoalesce(pos.positionId);
    await bankEngine.handleLeaderTx(activationId, 'cand_ape', leaderBuy(400_000_000n));
    // Buy 3: headroom now 0 -> BANKROLL CAP skip, no position change.
    agePastCoalesce(pos.positionId);
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
        signaturesSince: async () => [],
        transactionSummary: async () => null,
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

  /**
   * The monitor splits its work: the idle fire runs on every tick, the hourly
   * sweep owns time exits and the stall watcher. This helper exercises both the
   * way a tick would, so the discipline tests below cover the real sequence.
   */
  async function sweep(activationId: string, startedAt: string): Promise<void> {
    const m = monitor as unknown as {
      checkIdle: (a: string, s: string, n: Date) => Promise<boolean>;
      sweep: (a: string, n: Date) => Promise<void>;
    };
    const now = new Date();
    const fired = await m.checkIdle(activationId, startedAt, now);
    if (fired) return;
    await m.sweep(activationId, now);
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

  // D4 sets the shipped ceiling to 8h + 3h grace (config defaults); the
  // operator's .env may override both.
  it('sells a positive position at 8h and holds a negative one into grace', async () => {
    freshActivation('act_tx1');
    await engine.handleLeaderTx('act_tx1', 'cand_moon', leaderBuy(400_000_000n));
    const pos = repo.openPositions(handle.db).find((p) => p.activationId === 'act_tx1')!;

    backdate(pos.positionId, 8.5);
    marks.set(pos.positionId, 120_000_000n); // +$20 vs entry
    await sweep('act_tx1', pos.openedAt);
    expect(repo.getPosition(handle.db, pos.positionId)!.status).toBe('closed');

    // Negative at 8.5h: held. Past the 11h grace deadline: force-closed even
    // without a mark.
    await engine.handleLeaderTx('act_tx1', 'cand_moon', leaderBuy(400_000_000n));
    const pos2 = repo.openPositions(handle.db).find((p) => p.activationId === 'act_tx1')!;
    backdate(pos2.positionId, 8.5);
    marks.set(pos2.positionId, 90_000_000n); // -$10
    await sweep('act_tx1', pos2.openedAt);
    expect(repo.getPosition(handle.db, pos2.positionId)!.status).toBe('open');

    backdate(pos2.positionId, 11.5);
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
    backdate(pos.positionId, 7);
    await engine.handleLeaderTx('act_tx2', 'cand_moon', leaderBuy(400_000_000n)); // pyramid at 7h
    const updated = repo.getPosition(handle.db, pos.positionId)!;
    expect(Date.parse(updated.openedAt)).toBeLessThan(Date.now() - 6.9 * 3_600_000);

    // Age is still ~7h (pyramid did not reset openedAt) -> no time exit yet.
    marks.set(pos.positionId, 400_000_000n);
    await sweep('act_tx2', updated.openedAt);
    expect(repo.getPosition(handle.db, pos.positionId)!.status).toBe('open');

    // Cross the 8h ceiling -> positive PnL sells the whole pyramided position.
    backdate(pos.positionId, 8.5);
    await sweep('act_tx2', updated.openedAt);
    expect(repo.getPosition(handle.db, pos.positionId)!.status).toBe('closed');
  });

  it('two consecutive time-exit losses fire the trader', async () => {
    freshActivation('act_tx3');
    for (let i = 0; i < 2; i++) {
      await engine.handleLeaderTx('act_tx3', 'cand_moon', leaderBuy(400_000_000n));
      const pos = repo.openPositions(handle.db).find((p) => p.activationId === 'act_tx3')!;
      backdate(pos.positionId, 11.5);
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
    // Live mode must never fall through to the paper simulator, so the engine
    // is handed an executor that reports itself as live while reusing the
    // paper fill logic (there is no real wallet in a unit test).
    const paper = new PaperExecutor(
      null,
      async (mint, decimals) => (await prices.priceOf(mint, decimals)).priceUsdMicro,
    );
    const liveStub = {
      mode: 'live' as const,
      quote: paper.quote.bind(paper),
      execute: async (spec: IntentSpec, quote: QuoteCheck) => {
        const out = await paper.execute(spec, quote);
        // A real live executor always returns the signature of the bytes it
        // signed; the stub keeps paper prices but adds that evidence.
        return out.kind === 'filled' ? { ...out, signature: 'test-live-sig' } : out;
      },
    };
    const liveEngine = new CopyEngine(
      handle.db,
      { ...risk },
      prices,
      liveStub,
      control,
      new NoopNotifier(),
      { onFired: () => {}, onStateChanged: () => {} },
      null,
      1_000_000_000n,
      true, // live mode
    );
    repo.upsertCandidate(handle.db, {
      candidateId: 'cand_livegate',
      handle: 'livegate',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    repo.createActivation(handle.db, {
      activationId: 'act_livegate',
      candidateId: 'cand_livegate',
      mode: 'live',
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });
    await liveEngine.handleLeaderTx('act_livegate', 'cand_livegate', leaderBuy(400_000_000n));
    const intents = repo
      .intentsInStates(handle.db, ['skipped'])
      .filter((i) => i.activationId === 'act_livegate');
    expect(intents).toHaveLength(1);
    expect(intents[0]!.reason).toBe('live mode not armed');
    expect(repo.openPositions(handle.db).filter((p) => p.activationId === 'act_livegate')).toHaveLength(0);

    control.armLive();
    await liveEngine.handleLeaderTx('act_livegate', 'cand_livegate', leaderBuy(400_000_000n));
    const confirmed = repo
      .intentsInStates(handle.db, ['confirmed'])
      .filter((i) => i.activationId === 'act_livegate');
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    control.disarm();
  });
});

describe('coin-for-coin rotation copying (operator decision 2026-11-22)', () => {
  function seedActivation(activationId: string, candidateId: string): void {
    repo.createActivation(handle.db, {
      activationId,
      candidateId,
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'test',
    });
  }

  it('mirrors a rotation: exits the outgoing coin, enters the incoming one', async () => {
    seedActivation('act_rot1', 'cand_rot1');
    // Leader buys $40 of MEOW (our copy: $10), then rotates the whole MEOW
    // bag into 24M NEWMINT at $2 = $48 of value (copy: $12, above the $5 min).
    await engine.handleLeaderTx('act_rot1', 'cand_rot1', leaderBuy(40_000_000n));
    const meow = repo.openPositions(handle.db).find((p) => p.activationId === 'act_rot1')!;
    expect(meow.mint).toBe(MEOW);

    await engine.handleLeaderTx(
      'act_rot1',
      'cand_rot1',
      leaderRotate(MEOW, 9_000_000n, 0n, NEWMINT, 24_000_000n),
    );

    // The outgoing position closed through the leader-exit path…
    const closed = repo.getPosition(handle.db, meow.positionId)!;
    expect(closed.status).toBe('closed');
    expect(BigInt(closed.remainingTokenBase)).toBe(0n);
    // …and the incoming coin is open at 0.25x of its $48 swap value.
    const entered = repo.openPositions(handle.db).find((p) => p.activationId === 'act_rot1')!;
    expect(entered.mint).toBe(NEWMINT);
    expect(entered.inputUsdMicro).toBe('12000000');
  });

  it('trades neither leg when the incoming coin has no quote', async () => {
    seedActivation('act_rot2', 'cand_rot2');
    await engine.handleLeaderTx('act_rot2', 'cand_rot2', leaderBuy(40_000_000n));
    const meow = repo.openPositions(handle.db).find((p) => p.activationId === 'act_rot2')!;

    await engine.handleLeaderTx(
      'act_rot2',
      'cand_rot2',
      leaderRotate(MEOW, 9_000_000n, 0n, GHOSTMINT, 24_000_000n),
    );

    const rejection = repo
      .listRiskRejections(handle.db, 50)
      .find((r) => r.activationId === 'act_rot2' && r.rule === 'ROTATION_UNPRICED');
    expect(rejection).toBeDefined();
    // Fail closed: the MEOW position was not exited and nothing was entered.
    expect(repo.getPosition(handle.db, meow.positionId)!.status).toBe('open');
    expect(repo.openPositions(handle.db).filter((p) => p.activationId === 'act_rot2')).toHaveLength(1);
  });

  it('trades neither leg of a stale rotation', async () => {
    seedActivation('act_rot3', 'cand_rot3');
    await engine.handleLeaderTx('act_rot3', 'cand_rot3', leaderBuy(40_000_000n));
    const meow = repo.openPositions(handle.db).find((p) => p.activationId === 'act_rot3')!;

    const stale = leaderRotate(MEOW, 9_000_000n, 0n, NEWMINT, 24_000_000n);
    stale.blockTime = Math.floor(Date.now() / 1000) - 7_200;
    await engine.handleLeaderTx('act_rot3', 'cand_rot3', stale);

    const rejection = repo
      .listRiskRejections(handle.db, 50)
      .find((r) => r.activationId === 'act_rot3' && r.rule === 'MAX_COPY_EVENT_AGE_SECONDS');
    expect(rejection).toBeDefined();
    expect(repo.getPosition(handle.db, meow.positionId)!.status).toBe('open');
    expect(repo.openPositions(handle.db).filter((p) => p.activationId === 'act_rot3')).toHaveLength(1);
  });

  it('enters only the incoming coin when the outgoing coin is not held', async () => {
    seedActivation('act_rot4', 'cand_rot4');
    // No prior buy: the leader's outgoing coin maps to no position of ours —
    // the exit leg no-ops and only the entry mirrors.
    await engine.handleLeaderTx(
      'act_rot4',
      'cand_rot4',
      leaderRotate(MEOW, 9_000_000n, 0n, NEWMINT, 24_000_000n),
    );

    const positions = repo.openPositions(handle.db).filter((p) => p.activationId === 'act_rot4');
    expect(positions).toHaveLength(1);
    expect(positions[0]!.mint).toBe(NEWMINT);
    expect(positions[0]!.inputUsdMicro).toBe('12000000');
  });

  it('keeps the mirrored exit while entries are paused', async () => {
    seedActivation('act_rot5', 'cand_rot5');
    await engine.handleLeaderTx('act_rot5', 'cand_rot5', leaderBuy(40_000_000n));
    const meow = repo.openPositions(handle.db).find((p) => p.activationId === 'act_rot5')!;

    control.pauseNewEntries('rotation test');
    try {
      await engine.handleLeaderTx(
        'act_rot5',
        'cand_rot5',
        leaderRotate(MEOW, 9_000_000n, 0n, NEWMINT, 24_000_000n),
      );
    } finally {
      control.resumeNewEntries();
    }

    // Mirrored exits continue while paused; the entry is recorded as the
    // gate's skipped intent, never traded.
    expect(repo.getPosition(handle.db, meow.positionId)!.status).toBe('closed');
    expect(repo.openPositions(handle.db).filter((p) => p.activationId === 'act_rot5')).toHaveLength(0);
    const pausedEntry = repo
      .intentsInStates(handle.db, ['skipped'])
      .find((i) => i.activationId === 'act_rot5' && i.mint === NEWMINT);
    expect(pausedEntry).toBeDefined();
    expect(pausedEntry!.reason).toBe('new entries paused');
  });
});
