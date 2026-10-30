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
  dir = mkdtempSync(join(tmpdir(), 'zcode-settings-'));
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

/**
 * The trade screen reads the published store (SSE pushes on version bumps),
 * so a saved setting must be in the published state immediately — not only in
 * rt.config.risk — or the dashboard lags until the next unrelated rebuild.
 */
describe('settings PATCH', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeAll(async () => {
    app = buildApp(rt);
    const token = rt.ensureSetupToken();
    const setup = await app.request('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: token.value, username: 'admin', password: 'longenough123' }),
    });
    expect(setup.status).toBe(200);
    const cookies = extractSetCookie(setup);
    cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${cookies['zcode_csrf']}`;
  });

  it('applies the patch and publishes it to the dashboard state at once', async () => {
    const before = (await (await app.request('/api/state', { headers: { cookie } })).json()) as {
      version: number;
    };

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': extractCsrf(cookie) },
      body: JSON.stringify({ MAX_POSITION_AGE_HOURS: 9, IDLE_FIRE_HOURS: 7 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; risk: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.risk.MAX_POSITION_AGE_HOURS).toBe(9);
    expect(body.risk.IDLE_FIRE_HOURS).toBe(7);

    const after = (await (await app.request('/api/state', { headers: { cookie } })).json()) as {
      version: number;
      counters: { maxPositionAgeHours: number; positionGraceHours: number };
    };
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.counters.maxPositionAgeHours).toBe(9);
  });

  it('rejects non-numeric junk without touching the config', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': extractCsrf(cookie) },
      body: JSON.stringify({ MAX_POSITION_AGE_HOURS: 'soon' }),
    });
    expect(res.status).toBe(400);
    const state = (await (await app.request('/api/state', { headers: { cookie } })).json()) as {
      counters: { maxPositionAgeHours: number };
    };
    expect(state.counters.maxPositionAgeHours).toBe(9);
  });
});

function extractCsrf(cookie: string): string {
  const m = cookie.match(/zcode_csrf=([^;]+)/);
  return m ? m[1]! : '';
}
