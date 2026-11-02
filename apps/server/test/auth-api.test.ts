import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@zcode-bot/config';
import { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/http/app.js';

let dir: string;
let rt: Runtime;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-api-'));
  const config = loadConfig({ SESSION_SECRET: 't'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
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

describe('auth + CSRF + control API', () => {
  let app: ReturnType<typeof buildApp>;
  let cookies: Record<string, string>;
  let csrf: string;

  it('bootstraps with needsSetup and rejects bad setup tokens', async () => {
    app = buildApp(rt);
    const boot = await app.request('/api/bootstrap');
    expect((await boot.json()).needsSetup).toBe(true);

    const bad = await app.request('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: 'wrong', username: 'admin', password: 'longenough123' }),
    });
    expect(bad.status).toBe(403);
  });

  it('completes setup with the printed token, issues session + csrf cookies', async () => {
    const token = rt.ensureSetupToken();
    const res = await app.request('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: token.value, username: 'admin', password: 'longenough123' }),
    });
    expect(res.status).toBe(200);
    cookies = extractSetCookie(res);
    expect(cookies['zcode_session']).toBeTruthy();
    expect(cookies['zcode_csrf']).toBeTruthy();
    csrf = cookies['zcode_csrf']!;

    // Setup token is one-time.
    const replay = await app.request('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: token.value, username: 'other', password: 'longenough123' }),
    });
    expect(replay.status).toBe(409); // setup already completed
  });

  it('requires auth for state and audit', async () => {
    expect((await app.request('/api/state')).status).toBe(401);
    expect((await app.request('/api/audit')).status).toBe(401);
  });

  it('serves state with a session', async () => {
    const res = await app.request('/api/state', {
      headers: { cookie: `zcode_session=${cookies['zcode_session']}` },
    });
    expect(res.status).toBe(200);
    const state = (await res.json()) as { mode: string; fictional: boolean; badges: string[] };
    expect(state.mode).toBe('paper');
    expect(state.fictional).toBe(false);
    expect(state.badges).toContain('PAPER');
  });

  it('blocks mutations without CSRF and accepts them with it', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const noCsrf = await app.request('/api/control/pause', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noCsrf.status).toBe(403);

    const withCsrf = await app.request('/api/control/pause', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{"reason":"test"}',
    });
    expect(withCsrf.status).toBe(200);
    expect(rt.control.flags.newEntriesPaused).toBe(true);

    const resume = await app.request('/api/control/resume', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    });
    expect(resume.status).toBe(200);
    expect(rt.control.flags.newEntriesPaused).toBe(false);
  });

  it('close-all demands an explicit confirmation string', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const missing = await app.request('/api/control/close-all', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    });
    const body = (await missing.json()) as { error?: string };
    expect(body.error).toContain('CLOSE-ALL');

    const ok = await app.request('/api/control/close-all', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ confirm: 'CLOSE-ALL' }),
    });
    expect(ok.status).toBe(200);
  });

  it('emergency stop blocks and clears; login rate limit engages', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const stop = await app.request('/api/control/emergency-stop', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    });
    expect(stop.status).toBe(200);
    expect(rt.control.flags.emergencyStopped).toBe(true);
    expect(rt.control.entriesAllowed()).toBe(false);

    const clear = await app.request('/api/control/emergency-clear', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    });
    expect(clear.status).toBe(200);

    // Login limiter: 5 failures per window.
    let lastStatus = 0;
    for (let i = 0; i < 7; i++) {
      const res = await app.request('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('live arming refuses when readiness blockers exist', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const res = await app.request('/api/control/arm-live', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        ack: 'I UNDERSTAND LIVE MODE SIGNS AND SUBMITS REAL SOLANA TRANSACTIONS WITH REAL FUNDS',
      }),
    });
    expect(res.status).toBe(400); // mode is paper -> blocked
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('MODE');
  });

  it('never returns secrets from settings', async () => {
    const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
    const res = await app.request('/api/settings', { headers: { cookie } });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('SESSION_SECRET');
    expect(rt.config.env.SESSION_SECRET.slice(0, 8)).not.toContain(text);
  });
});
