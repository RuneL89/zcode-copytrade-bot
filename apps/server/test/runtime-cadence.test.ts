import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@zcode-bot/config';
import * as repo from '@zcode-bot/db/repo.js';
import { Runtime } from '../src/runtime.js';

/**
 * D5 / plan 06 — the runtime cadence.
 *
 * Exactly two monitoring clocks exist (the watch list and the roster); the
 * research-era snapshot/inbox/rotation timers are gone. Discovery is
 * DEMAND-DRIVEN: a full roster plus a full bench spends nothing, and a thin
 * bench asks for exactly one run (the service's own rate limit is pinned in
 * discovery.test.ts).
 */

let dir: string;
let rt: Runtime;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-cadence-'));
  const config = loadConfig({ SESSION_SECRET: 'k'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
  config.env.DATA_DIR = dir;
  // No FOMOAPI_KEY: a discovery attempt fails closed with a skip, so the demand
  // trigger can be counted without any network call.
  config.env.FOMOAPI_KEY = '';
  rt = new Runtime(config);
});

afterAll(() => {
  rt.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Count demand-triggered discovery runs without touching the network. */
function countSyncs(): { calls: () => number; restore: () => void } {
  let calls = 0;
  const original = rt.discovery;
  const stub = Object.create(Object.getPrototypeOf(original)) as Record<string, unknown>;
  Object.assign(stub, original);
  stub['syncIfNeeded'] = async () => {
    calls++;
    return { skipped: true, reason: 'test' };
  };
  rt.discovery = stub as unknown as typeof rt.discovery;
  return { calls: () => calls, restore: () => (rt.discovery = original) };
}

describe('runtime cadence (D5)', () => {
  it('only the two monitoring timers survive the retirement', () => {
    // The research-era scheduler is gone: no snapshot publish, no inbox watcher.
    for (const retired of [
      'snapshotTimer',
      'snapshotDebounceTimer',
      'inboxTimer',
      'inboxWatcher',
      'fomoWebTimer',
    ]) {
      expect(retired in rt).toBe(false);
    }
    // The two monitoring clocks plus the housekeeping timers stay.
    for (const kept of [
      'watchTimer', // the watch list, WATCH_POLL_MS
      'rosterTimer', // the roster, ROSTER_POLL_MS
      'healthTimer',
      'feeLedgerTimer',
      'activityTimer',
    ]) {
      expect(kept in rt).toBe(true);
    }
  });

  it('a full roster and a full bench ask for no discovery at all', () => {
    for (let i = 0; i < rt.config.risk.ROSTER_SIZE; i++) {
      repo.createActivation(rt.db.db, {
        activationId: `cadence_chair_${i}`,
        candidateId: `cand_cadence_${i}`,
        state: 'ACTIVE',
        startedAt: new Date().toISOString(),
        endedAt: null,
        endReason: null,
        lossStreak: 0,
        firedReason: null,
        source: 'test',
      });
    }
    for (let i = 0; i < rt.config.risk.BENCH_TARGET; i++) {
      repo.upsertWatchWallet(rt.db.db, {
        candidateId: `cadence_bench_${i}`,
        address: `BenchWallet${i}`,
        status: 'promoted',
        reason: 'test',
      });
    }

    const counter = countSyncs();
    try {
      // An hour of watch ticks: 12 ticks at the 5-minute clock.
      for (let i = 0; i < 12; i++) rt.maybeDemandDiscovery();
      expect(counter.calls()).toBe(0);
    } finally {
      counter.restore();
    }
  });

  it('a thin bench asks for discovery', () => {
    // Empty the bench: nothing promotable is waiting.
    for (const wallet of repo.listWatchWallets(rt.db.db, 'promoted')) {
      repo.setWatchStatus(rt.db.db, wallet.candidateId, 'archived', 'test reset');
    }
    const counter = countSyncs();
    try {
      rt.maybeDemandDiscovery();
      expect(counter.calls()).toBe(1);
    } finally {
      counter.restore();
    }
  });
});
