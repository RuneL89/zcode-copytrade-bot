import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type AppConfig } from '@zcode-bot/config';
import { CopyEngine } from '../src/services/engine.js';
import { TraderLifecycle } from '../src/services/lifecycle.js';
import { ControlService } from '../src/services/control.js';
import type { ExecOutcome, Executor, IntentSpec, QuoteCheck } from '../src/services/executors.js';
import type { PriceProvider } from '@zcode-bot/providers';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = 'MintFireClose111111111111111111111111111111';

class ScriptedExecutor implements Executor {
  readonly mode = 'paper' as const;
  readonly specs: IntentSpec[] = [];
  constructor(private script: ExecOutcome[]) {}

  async quote(spec: IntentSpec): Promise<QuoteCheck> {
    this.specs.push(spec);
    return { slippageBps: 0, priceImpactBps: 0, minOutputBase: '0', source: 'jupiter' };
  }

  async execute(spec: IntentSpec): Promise<ExecOutcome> {
    const next = this.script.shift();
    if (!next) {
      return {
        kind: 'filled',
        signature: 'sig-test',
        inputAmountBase: spec.inputAmountBase,
        outputAmountBase: '1000000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'paper',
      };
    }
    if (next.kind === 'filled') return { ...next, inputAmountBase: spec.inputAmountBase };
    return next;
  }

  async availableBalance(): Promise<bigint | null> {
    return null;
  }

  async availableSolLamports(): Promise<number | null> {
    return null;
  }
}

const prices = {
  priceOf: async () => ({ priceUsdMicro: 1_000_000n, observedAt: new Date().toISOString() }),
  priceSolUsdMicro: async () => ({ priceUsdMicro: 150_000_000n, observedAt: new Date().toISOString() }),
} as unknown as PriceProvider;

const notifier = { notify: async () => {}, enabled: false } as never;

let dir: string;
let handle: AppDatabase;
let config: AppConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-fire-recon-'));
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
  config = loadConfig({ SESSION_SECRET: 'f'.repeat(48) });
  config.risk.PROMOTION_MIN_CLOSED = 1;
  config.risk.PROMOTION_MIN_NET_USD = 1;
  config.risk.PROMOTION_MAX_LAST_BUY_HOURS = 4;
  config.risk.ROSTER_SIZE = 5;
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedCandidate(candidateId: string, address: string): void {
  repo.upsertCandidate(handle.db, {
    candidateId,
    handle: candidateId,
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
    address,
    verification: 'reported',
  });
}

function seedActivation(activationId: string, candidateId: string, state = 'ACTIVE'): void {
  repo.createActivation(handle.db, {
    activationId,
    candidateId,
    state,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: null,
    source: 'test',
  });
}

function seedPosition(
  activationId: string,
  positionId: string,
  candidateId: string,
  status = 'open',
  remaining = '1000',
): void {
  repo.insertPosition(handle.db, {
    positionId,
    activationId,
    candidateId,
    mint: TOKEN,
    mintSymbol: 'TOKEN',
    status,
    entryIntentId: null,
    inputMint: USDC,
    inputUsdMicro: '10000000',
    copiedTokenBase: '1000',
    remainingTokenBase: remaining,
    leaderTokenBase: null,
    realizedPnlUsdMicro: '0',
    feesUsdMicro: '0',
    openedAt: new Date(Date.now() - 3_600_000).toISOString(),
    closedAt: status === 'closed' ? new Date().toISOString() : null,
    closeReason: status === 'closed' ? 'fire_close_all' : null,
  });
}

function seedTarget(
  activationId = 'act_target',
  candidateId = 'cand_target',
): {
  activationId: string;
  candidateId: string;
  positionId: string;
} {
  const positionId = 'pos_' + activationId;
  seedCandidate(candidateId, 'Wallet' + candidateId);
  repo.upsertWatchWallet(handle.db, {
    candidateId,
    address: 'Wallet' + candidateId,
    status: 'hired',
    reason: 'test',
  });
  seedActivation(activationId, candidateId);
  seedPosition(activationId, positionId, candidateId);
  return { activationId, candidateId, positionId };
}

function seedQualifiedBench(candidateId = 'cand_bench'): void {
  const address = 'Wallet' + candidateId;
  seedCandidate(candidateId, address);
  repo.upsertWatchWallet(handle.db, {
    candidateId,
    address,
    status: 'bench',
    reason: 'test',
  });
  for (let i = 0; i < 3; i++) {
    const id = repo.openShadowTrade(handle.db, {
      candidateId,
      mint: TOKEN,
      openedAt: new Date(Date.now() - (3 - i) * 3_600_000).toISOString(),
      entryPriceUsdMicro: '1000000',
      notionalUsdMicro: '6000000',
    });
    repo.closeShadowTrade(handle.db, id, {
      closedAt: new Date(Date.now() - (3 - i) * 3_600_000 + 60_000).toISOString(),
      exitReason: 'leader_sell',
      exitPriceUsdMicro: '1000000',
      pnlUsdMicro: '2000000',
    });
  }
  repo.insertWatchEvent(handle.db, {
    candidateId,
    address,
    signature: 'bench-buy',
    side: 'buy',
    mint: TOKEN,
    tokenAmountBase: '6000000',
    decimals: 6,
    usdMicro: '6000000',
    blockTime: Math.floor(Date.now() / 1000) - 60,
    observedAt: new Date().toISOString(),
    source: 'test',
  });
}

function seedSummary(
  activationId: string,
  opts: {
    kind?: string;
    marker?: boolean;
    signature?: string | null;
    createdAt?: string;
  } = {},
): number {
  return repo.insertReconciliationCase(handle.db, {
    kind: opts.kind ?? 'close_failed',
    intentId: null,
    positionId: null,
    signature: opts.signature ?? null,
    status: 'open',
    detail:
      'fire close-out incomplete: 0 closed, 0 unknown, 1 failed after retries' +
      (opts.marker === false ? '' : ` [activation:${activationId}]`),
    createdAt: opts.createdAt ?? new Date().toISOString(),
    resolvedAt: null,
  });
}

function engineWith(executor: Executor) {
  let lifecycle: TraderLifecycle;
  const engine = new CopyEngine(
    handle.db,
    config.risk,
    prices,
    executor,
    new ControlService(handle.db),
    notifier,
    {
      onFired: () => {},
      onStateChanged: () => {},
      onFireCloseFilled: async (activationId) => {
        await lifecycle.completeBlockedFire(activationId);
      },
    },
    null,
    1_000_000_000n,
    false,
  );
  lifecycle = new TraderLifecycle(handle.db, config.risk, engine);
  return { engine, lifecycle };
}

describe('fire close-out completion after an exit-queue retry', () => {
  it('completes the blocked fire, resolves its summary case, and fills the chair', async () => {
    const target = seedTarget();
    seedQualifiedBench();
    const failed: ExecOutcome = {
      kind: 'failed',
      error: 'paper simulation failed: jupiter: rate limited (429)',
    };
    const executor = new ScriptedExecutor([
      failed,
      failed,
      failed,
      {
        kind: 'filled',
        signature: 'sig-fire-close',
        inputAmountBase: '1000',
        outputAmountBase: '15000000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'paper',
      },
    ]);
    const { engine, lifecycle } = engineWith(executor);

    const fired = await lifecycle.fire(target.activationId, 'stall: test');
    expect(fired.status).toBe('NO_REPLACEMENT');
    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('REQUIRES_RECONCILIATION');
    const summary = repo.openReconciliationCases(handle.db).find((c) => !c.intentId && !c.positionId)!;
    expect(summary.detail).toContain(`[activation:${target.activationId}]`);
    expect(repo.kvGet(handle.db, `exit.queue:${target.positionId}`)).toBeDefined();

    const retry = await engine.retryQueuedExits(Date.now() + 10 * 60_000);
    expect(retry.filled).toBe(1);
    expect(repo.getPosition(handle.db, target.positionId)!.status).toBe('closed');
    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('FIRED');
    expect(repo.openReconciliationCases(handle.db)).toHaveLength(0);
    expect(repo.getWatchWallet(handle.db, target.candidateId)?.status).toBe('cooling');
    expect(repo.getWatchWallet(handle.db, 'cand_bench')?.status).toBe('hired');
    expect(repo.kvGet(handle.db, `exit.queue:${target.positionId}`)).toBeUndefined();
  });

  it('ignores open positions owned by other activations', async () => {
    const target = seedTarget();
    seedActivation('act_other', 'cand_other');
    seedPosition('act_other', 'pos_other', 'cand_other');
    seedQualifiedBench();
    const failed: ExecOutcome = {
      kind: 'failed',
      error: 'paper simulation failed: jupiter: rate limited (429)',
    };
    const executor = new ScriptedExecutor([
      failed,
      failed,
      failed,
      {
        kind: 'filled',
        signature: 'sig-fire-close',
        inputAmountBase: '1000',
        outputAmountBase: '15000000',
        feeUsdMicro: '0',
        evidence: {},
        commitment: 'paper',
      },
    ]);
    const { engine, lifecycle } = engineWith(executor);

    await lifecycle.fire(target.activationId, 'stall: test');
    await engine.retryQueuedExits(Date.now() + 10 * 60_000);

    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('FIRED');
    expect(repo.getPosition(handle.db, 'pos_other')!.status).toBe('open');
    expect(repo.getActivation(handle.db, 'act_other')!.state).toBe('ACTIVE');
    expect(repo.openReconciliationCases(handle.db)).toHaveLength(0);
  });
});

describe('startup recovery for an already-closed blocked fire', () => {
  it('completes a legacy unmarked summary case without closing or booking again', async () => {
    const target = seedTarget('act_startup', 'cand_startup');
    repo.updateActivation(handle.db, target.activationId, { state: 'REQUIRES_RECONCILIATION' });
    repo.updatePosition(handle.db, target.positionId, {
      status: 'closed',
      remainingTokenBase: '0',
      closedAt: new Date().toISOString(),
      closeReason: 'fire_close_all',
    });
    repo.insertPnlLot(handle.db, {
      positionId: target.positionId,
      closedBase: '1000',
      proceedsUsdMicro: '15000000',
      costBasisUsdMicro: '10000000',
      feesUsdMicro: '0',
      pnlUsdMicro: '5000000',
      unitType: 'position_closed',
      closedAt: new Date().toISOString(),
      signature: 'sig-already-closed',
    });
    const caseId = seedSummary(target.activationId, { marker: false });
    const executor = new ScriptedExecutor([]);
    const { lifecycle } = engineWith(executor);

    const result = await lifecycle.recoverBlockedFires('test-startup');

    expect(result.completed).toContainEqual({
      activationId: target.activationId,
      status: 'NO_REPLACEMENT',
    });
    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('FIRED');
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === caseId)).toBe(false);
    expect(repo.listPnlLots(handle.db, 10).filter((l) => l.positionId === target.positionId)).toHaveLength(1);
    expect(executor.specs).toHaveLength(0);
  });

  it('resolves an orphaned legacy summary for an activation already marked FIRED', async () => {
    const target = seedTarget('act_fired_orphan', 'cand_fired_orphan');
    const endedAt = new Date().toISOString();
    repo.updateActivation(handle.db, target.activationId, {
      state: 'FIRED',
      endedAt,
      endReason: 'fired',
    });
    repo.updatePosition(handle.db, target.positionId, {
      status: 'closed',
      remainingTokenBase: '0',
      closedAt: endedAt,
      closeReason: 'fire_close_all',
    });
    repo.insertFiringEvent(handle.db, {
      activationId: target.activationId,
      candidateId: target.candidateId,
      reason: 'stall: test',
      lossStreak: 0,
      positionPolicy: 'close_all_before_switch',
      firedAt: endedAt,
      closeCompletedAt: null,
      handoffStatus: 'none',
    });
    const caseId = seedSummary(target.activationId, { marker: false, createdAt: endedAt });
    const { lifecycle } = engineWith(new ScriptedExecutor([]));

    await lifecycle.recoverBlockedFires('test-startup');

    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('FIRED');
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === caseId)).toBe(false);
  });

  it('attributes a legacy summary by its firing-event time, not desk-wide cleanup', async () => {
    const target = seedTarget('act_legacy_match', 'cand_legacy_match');
    repo.updateActivation(handle.db, target.activationId, { state: 'REQUIRES_RECONCILIATION' });
    repo.updatePosition(handle.db, target.positionId, {
      status: 'closed',
      remainingTokenBase: '0',
      closedAt: new Date().toISOString(),
      closeReason: 'fire_close_all',
    });
    const firedAt = new Date().toISOString();
    repo.insertFiringEvent(handle.db, {
      activationId: target.activationId,
      candidateId: target.candidateId,
      reason: 'stall: test',
      lossStreak: 0,
      positionPolicy: 'close_all_before_switch',
      firedAt,
      closeCompletedAt: null,
      handoffStatus: 'none',
    });
    const ownCase = seedSummary(target.activationId, { marker: false, createdAt: firedAt });
    const unrelatedCase = seedSummary('act_unrelated_legacy', {
      marker: false,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const { lifecycle } = engineWith(new ScriptedExecutor([]));

    await lifecycle.recoverBlockedFires('test-startup');

    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('FIRED');
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === ownCase)).toBe(false);
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === unrelatedCase)).toBe(true);
  });

  it('never completes a blocked fire with an unknown summary case', async () => {
    const target = seedTarget('act_unknown', 'cand_unknown');
    repo.updateActivation(handle.db, target.activationId, { state: 'REQUIRES_RECONCILIATION' });
    repo.updatePosition(handle.db, target.positionId, {
      status: 'closed',
      remainingTokenBase: '0',
      closedAt: new Date().toISOString(),
      closeReason: 'fire_close_all',
    });
    const caseId = seedSummary(target.activationId, { kind: 'unknown_execution' });
    const { lifecycle } = engineWith(new ScriptedExecutor([]));

    await lifecycle.recoverBlockedFires('test-startup');

    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('REQUIRES_RECONCILIATION');
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === caseId)).toBe(true);
  });

  it('never completes a blocked fire with a signed summary case', async () => {
    const target = seedTarget('act_signed', 'cand_signed');
    repo.updateActivation(handle.db, target.activationId, { state: 'REQUIRES_RECONCILIATION' });
    repo.updatePosition(handle.db, target.positionId, {
      status: 'closed',
      remainingTokenBase: '0',
      closedAt: new Date().toISOString(),
      closeReason: 'fire_close_all',
    });
    const caseId = seedSummary(target.activationId, { signature: 'sig-signed' });
    const { lifecycle } = engineWith(new ScriptedExecutor([]));

    await lifecycle.recoverBlockedFires('test-startup');

    expect(repo.getActivation(handle.db, target.activationId)!.state).toBe('REQUIRES_RECONCILIATION');
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === caseId)).toBe(true);
  });
});
