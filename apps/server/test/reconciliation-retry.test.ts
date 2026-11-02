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
import { TraderLifecycle } from '../src/services/lifecycle.js';
import type { CopyEngine } from '../src/services/engine.js';

let dir: string;
let handle: AppDatabase;
let config: AppConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-recon-retry-'));
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
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Engine stub: records close calls and settles the position as closed. */
function stubEngine(outcome: 'closed' | 'failed' | 'unknown' = 'closed') {
  const calls: string[] = [];
  const engine = {
    calls,
    closePosition: async (positionId: string) => {
      calls.push(positionId);
      if (outcome === 'closed') {
        repo.updatePosition(handle.db, positionId, {
          status: 'closed',
          remainingTokenBase: '0',
          closedAt: new Date().toISOString(),
          closeReason: 'reconciliation_retry',
        });
      }
      return outcome;
    },
  };
  return engine as unknown as CopyEngine & { calls: string[] };
}

function seedBlockedFire(opts: { signature: string | null }) {
  const activationId = 'act_' + crypto.randomUUID();
  repo.createActivation(handle.db, {
    activationId,
    candidateId: 'cand_test',
    state: 'REQUIRES_RECONCILIATION',
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    lossStreak: 0,
    firedReason: 'rank: left the board',
    source: 'manual',
  });
  repo.insertFiringEvent(handle.db, {
    activationId,
    candidateId: 'cand_test',
    reason: 'rank: left the board',
    lossStreak: 0,
    positionPolicy: 'close_all_before_switch',
    firedAt: new Date().toISOString(),
    closeCompletedAt: null,
    handoffStatus: 'none',
  });
  const positionId = 'pos_' + crypto.randomUUID();
  repo.insertPosition(handle.db, {
    positionId,
    activationId,
    candidateId: 'cand_test',
    mint: 'MintPURR',
    mintSymbol: 'PURR',
    status: 'requires_reconciliation',
    entryIntentId: null,
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    inputUsdMicro: '10000000',
    copiedTokenBase: '3696405178492',
    remainingTokenBase: '3696405178492',
    leaderTokenBase: null,
    realizedPnlUsdMicro: '0',
    feesUsdMicro: '0',
    openedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    closedAt: null,
    closeReason: null,
  });
  const intentId = 'intent_' + crypto.randomUUID();
  repo.insertIntent(handle.db, {
    intentId,
    kind: 'fire_close',
    mode: 'live',
    activationId,
    candidateId: 'cand_test',
    positionId,
    mint: 'MintPURR',
    inputMint: 'MintPURR',
    inputAmountBase: '3696405178492',
    minOutputBase: null,
    slippageBps: null,
    priceImpactBps: null,
    state: 'requires_reconciliation',
    idempotencyKey: 'idem_' + crypto.randomUUID(),
    quoteJson: null,
    txSignature: opts.signature,
    reason: 'jupiter: rate limited (429)',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const caseId = repo.insertReconciliationCase(handle.db, {
    kind: 'unknown_execution',
    intentId,
    positionId,
    signature: null,
    status: 'open',
    detail: 'jupiter: rate limited (429)',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  });
  // Parent summary case, as fire() writes it.
  repo.insertReconciliationCase(handle.db, {
    kind: 'unknown_execution',
    intentId: null,
    positionId: null,
    signature: null,
    status: 'open',
    detail: 'fire close-out has 1 unknown outcome(s)',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  });
  return { activationId, positionId, caseId };
}

describe('signature-less reconciliation retry', () => {
  it('closes the position, resolves the case, and completes the blocked fire', async () => {
    const { activationId, positionId, caseId } = seedBlockedFire({ signature: null });
    const engine = stubEngine('closed');
    const lifecycle = new TraderLifecycle(handle.db, config.risk, engine);

    const result = await lifecycle.retrySignaturelessCloses();

    expect(result.retried).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(0);
    expect(engine.calls).toEqual([positionId]);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('closed');
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === caseId)).toBe(false);
    // Fire completed: the activation left reconciliation.
    const activation = repo.getActivation(handle.db, activationId)!;
    expect(activation.state).toBe('FIRED');
    // The pipeline is retired (D6): the close is retried, the case resolves,
    // and the chair simply stays empty.
    expect(result.retried).toBe(1);
    expect(result.closed).toBe(1);
    expect(repo.activeActivationCount(handle.db)).toBe(0);
    // The parent summary case clears once nothing is held.
    expect(repo.openReconciliationCases(handle.db)).toHaveLength(0);
  });

  it('never retries a case whose intent has a signature', async () => {
    const { positionId, caseId } = seedBlockedFire({ signature: 'sigABC' });
    const engine = stubEngine('closed');
    const lifecycle = new TraderLifecycle(handle.db, config.risk, engine);

    const result = await lifecycle.retrySignaturelessCloses();

    expect(result.retried).toBe(0);
    expect(engine.calls).toEqual([]);
    expect(repo.getPosition(handle.db, positionId)!.status).toBe('requires_reconciliation');
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === caseId)).toBe(true);
  });

  it('keeps the case open and the activation blocked when the retry fails', async () => {
    const { activationId, caseId } = seedBlockedFire({ signature: null });
    const engine = stubEngine('failed');
    const lifecycle = new TraderLifecycle(handle.db, config.risk, engine);

    const result = await lifecycle.retrySignaturelessCloses();

    expect(result.failed).toBe(1);
    expect(repo.openReconciliationCases(handle.db).some((c) => c.id === caseId)).toBe(true);
    expect(repo.getActivation(handle.db, activationId)!.state).toBe('REQUIRES_RECONCILIATION');
  });

  it('completeBlockedFire refuses while any position is still held', async () => {
    const { activationId } = seedBlockedFire({ signature: null });
    const lifecycle = new TraderLifecycle(handle.db, config.risk, stubEngine('closed'));

    const res = await lifecycle.completeBlockedFire(activationId);
    expect(res.status).toBe('STILL_BLOCKED');
    expect(repo.getActivation(handle.db, activationId)!.state).toBe('REQUIRES_RECONCILIATION');
  });
});
