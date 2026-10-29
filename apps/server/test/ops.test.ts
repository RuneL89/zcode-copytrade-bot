import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@zcode-bot/config';
import { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/http/app.js';
import { OpsRunner, type OpDefinition } from '../src/services/ops.js';
import { openDatabase } from '@zcode-bot/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let dir: string;
let rt: Runtime;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-ops-'));
  const config = loadConfig({ SESSION_SECRET: 'o'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
  config.env.DATA_DIR = dir;
  rt = new Runtime(config);
});

afterAll(() => {
  rt.stop();
  rmSync(dir, { recursive: true, force: true });
});

function extractSetCookie(res: Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const raw of (res.headers.getSetCookie?.() ?? []) as string[]) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return cookies;
}

describe('ops runner (injected definitions, no pnpm spawns)', () => {
  let runner: OpsRunner;
  const testOps: OpDefinition[] = [
    {
      id: 'echo-ok',
      label: 'Echo ok',
      group: 'setup',
      description: 'test',
      kind: 'action',
      danger: 'normal',
      action: () => 'all good',
    },
    {
      id: 'delayed',
      label: 'Delayed',
      group: 'setup',
      description: 'test',
      kind: 'action',
      danger: 'normal',
      action: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return 'done';
      },
    },
    {
      id: 'spawn-version',
      label: 'Spawn node --version',
      group: 'testing',
      description: 'test',
      kind: 'spawn',
      command: 'node --version',
      danger: 'normal',
      timeoutMs: 30_000,
    },
    {
      id: 'spawn-fail',
      label: 'Spawn failing command',
      group: 'testing',
      description: 'test',
      kind: 'spawn',
      command: 'node -e "process.exit(3)"',
      danger: 'normal',
      timeoutMs: 30_000,
    },
    {
      id: 'guarded',
      label: 'Guarded',
      group: 'maintenance',
      description: 'test',
      kind: 'action',
      danger: 'destructive',
      confirmWord: 'RESET',
      action: () => 'nuked',
    },
  ];

  it('refuses unknown op ids', async () => {
    runner = new OpsRunner(rt, rt.db.db, dir, testOps);
    const r = await runner.run('no-such-op');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown operation');
  });

  it('runs an action op and records history', async () => {
    const r = await runner.run('echo-ok');
    expect(r.ok).toBe(true);
    expect(r.run?.summary).toBe('all good');
    expect(r.run?.status).toBe('succeeded');
    expect(runner.snapshot().history[0]?.opId).toBe('echo-ok');
  });

  it('captures spawn output and exit codes', async () => {
    const okRun = await runner.run('spawn-version');
    expect(okRun.ok).toBe(true);
    expect(okRun.run?.lines.join('\n')).toMatch(/^v\d+\./);

    const failRun = await runner.run('spawn-fail');
    expect(failRun.ok).toBe(false);
    expect(failRun.run?.status).toBe('failed');
    expect(failRun.run?.exitCode).toBe(3);
  });

  it('enforces the single-op mutex', async () => {
    const first = runner.run('delayed');
    await new Promise((r) => setTimeout(r, 150));
    const second = await runner.run('echo-ok');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('still running');
    await first;
    expect(runner.snapshot().current).toBeNull();
  });

  it('refuses destructive ops without the exact confirmation word', async () => {
    const noConfirm = await runner.run('guarded');
    expect(noConfirm.ok).toBe(false);
    const wrongWord = await runner.run('guarded', 'reset');
    expect(wrongWord.ok).toBe(false);
    const right = await runner.run('guarded', 'RESET');
    expect(right.ok).toBe(true);
  });

  it('creates wallets only with matching strong secrets and refuses duplicates', () => {
    const weak = runner.createWallet('short', 'short');
    expect(weak.ok).toBe(false);
    const mismatch = runner.createWallet('a-sufficiently-long-secret', 'different-secret-12345');
    expect(mismatch.ok).toBe(false);
    const good = runner.createWallet('a-sufficiently-long-secret', 'a-sufficiently-long-secret');
    expect(good.ok).toBe(true);
    expect(good.publicKey).toBeTruthy();
    const duplicate = runner.createWallet('another-sufficiently-long', 'another-sufficiently-long');
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('already exists');
  });
});

describe('ops API (auth + csrf + backup)', () => {
  let app: ReturnType<typeof buildApp>;
  let cookies: Record<string, string>;
  let csrf: string;

  beforeAll(async () => {
    app = buildApp(rt);
    rt.ensureSetupToken(); // the standalone Runtime has no server main() to do it
    const boot = (await (await app.request('/api/bootstrap')).json()) as {
      needsSetup: boolean;
      testSetupToken: string | null;
    };
    expect(boot.needsSetup).toBe(true);
    const token = boot.testSetupToken;
    if (token) {
      const res = await app.request('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupToken: token, username: 'opuser', password: 'ops-password-1' }),
      });
      expect(res.status).toBe(200);
      cookies = extractSetCookie(res);
      console.log('DEBUG KEYS:', Object.keys(cookies).join(','), 'csrf len:', cookies['zcode_csrf']?.length);
      csrf = cookies['zcode_csrf']!;
    }
  });

  it('requires auth for the ops catalog', async () => {
    expect((await app.request('/api/ops')).status).toBe(401);
  });

  it('exposes the production whitelist and system info', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const res = await app.request('/api/ops', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      operations: Array<{ id: string; group: string }>;
      system: { mode: string; backups: string[] };
    };
    const ids = body.operations.map((o) => o.id);
    expect(ids).toContain('install-deps');
    expect(ids).toContain('test-e2e');
    expect(ids).toContain('backup-data');
    expect(ids).toContain('reset-db');
    expect(body.system.mode).toBe('paper');
  });

  it('rejects ops calls without csrf and runs backup with it', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}`;
    const noCsrf = await app.request('/api/ops/backup-data/run', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' }, // intentional: no csrf header
      body: '{}',
    });
    expect(noCsrf.status).toBe(403);

    const cookie2 = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const run = await app.request('/api/ops/backup-data/run', {
      method: 'POST',
      headers: { cookie: cookie2, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    });
    expect(run.status).toBe(200);
    const body = (await run.json()) as { run: { status: string; summary: string | null } };
    expect(body.run.status).toBe('succeeded');

    const backupsDir = join(dir, 'backups');
    expect(existsSync(backupsDir)).toBe(true);
    expect(readdirSync(backupsDir).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses destructive reset without typing RESET', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const res = await app.request('/api/ops/reset-db/run', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ confirm: 'please' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('RESET');
  });
});
