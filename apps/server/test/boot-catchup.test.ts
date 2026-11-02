import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@zcode-bot/config';
import * as repo from '@zcode-bot/db/repo.js';
import { Runtime } from '../src/runtime.js';

/**
 * D5 / plan 06 — boot catch-up.
 *
 * `start()` sequences discovery (when the bench is thin) → one watch pass →
 * `fillRoster()` BEFORE the two monitoring clocks start, and a boot with no API
 * key still starts and audits the skip instead of failing.
 */

let dir: string;
let rt: Runtime;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-boot-'));
});

afterAll(() => {
  rt?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('boot catch-up (D5)', () => {
  it('skips discovery without a key, runs the watch pass and fills the roster before the clocks', async () => {
    const config = loadConfig({ SESSION_SECRET: 'b'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
    config.env.DATA_DIR = dir;
    config.env.FOMOAPI_KEY = '';
    rt = new Runtime(config);

    await rt.start();
    // The catch-up is async; start() returns while it runs.
    for (
      let i = 0;
      i < 50 && !repo.listAudit(rt.db.db, 50).some((a) => /boot roster fill:/.test(a.message));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const messages = repo.listAudit(rt.db.db, 80).map((a) => a.message);
    // The demand gate asked for a run; the service failed closed without a key
    // and audited the skip (its own line, not a boot-prefixed one).
    expect(messages.some((m) => /discovery skipped: FOMOAPI_KEY not configured/.test(m))).toBe(true);
    expect(messages.some((m) => /boot roster fill:/.test(m))).toBe(true);
    // Fail closed AND fail visible: the runtime still runs.
    expect(rt.monitor?.running).toBe(true);
    expect(messages.some((m) => /watch list enabled/.test(m))).toBe(true);
  });

  it('fills a free chair from the promotion queue during the boot catch-up', async () => {
    // A bench wallet whose shadow record passes the runtime's default gate:
    // K = 8 closed trades, net > $3, a funded buy five minutes ago.
    const candidateId = 'cand_boot_bench';
    repo.upsertCandidate(rt.db.db, {
      candidateId,
      handle: 'boot_bench',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(rt.db.db, candidateId, {
      chain: 'solana',
      address: 'WalletBootBench',
      verification: 'reported',
    });
    repo.upsertWatchWallet(rt.db.db, {
      candidateId,
      address: 'WalletBootBench',
      status: 'promoted',
      reason: 'test bench',
    });

    // The catch-up already ran; a fresh start runs it again with the bench in
    // place (the chair is free because the earlier chairs were never activated).
    rt.stop();
    const config = loadConfig({ SESSION_SECRET: 'b'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
    config.env.DATA_DIR = dir;
    config.env.FOMOAPI_KEY = '';
    rt = new Runtime(config);
    await rt.start();
    for (
      let i = 0;
      i < 50 && repo.listActiveActivations(rt.db.db).every((a) => a.candidateId !== candidateId);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(repo.listActiveActivations(rt.db.db).map((a) => a.candidateId)).toContain(candidateId);
  });
});
