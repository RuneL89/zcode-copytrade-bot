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
  const config = loadConfig({
    SESSION_SECRET: 't'.repeat(48),
    DATA_DIR: dir,
    MODE: 'paper',
    RISK_PIN: '2468',
  });
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

    const refused = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': extractCsrf(cookie) },
      body: JSON.stringify({ MAX_POSITION_AGE_HOURS: 9 }),
    });
    expect(refused.status).toBe(403);

    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': extractCsrf(cookie) },
      body: JSON.stringify({ MAX_POSITION_AGE_HOURS: 9, IDLE_FIRE_HOURS: 7, pin: '2468' }),
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

  it('persists the D4 watch/promotion fields across a runtime reload', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': extractCsrf(cookie) },
      body: JSON.stringify({
        WATCH_LIST_SIZE: 25,
        BENCH_TARGET: 12,
        ROSTER_SIZE: 3,
        PER_MINT_CAP_USD: 0, // 0 = cap disabled, not "unset"
        WATCH_POLL_MS: 300000,
        ROSTER_POLL_MS: 45000,
        SHADOW_BACKFILL_ON_ADMIT: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { risk: Record<string, number | boolean> };
    expect(body.risk.WATCH_LIST_SIZE).toBe(25);
    expect(body.risk.BENCH_TARGET).toBe(12);
    expect(body.risk.ROSTER_SIZE).toBe(3);
    expect(body.risk.PER_MINT_CAP_USD).toBe(0);
    expect(body.risk.SHADOW_BACKFILL_ON_ADMIT).toBe(false);

    // A fresh Runtime over the same DATA_DIR re-applies the saved overrides.
    const reloaded = loadConfig({ SESSION_SECRET: 't'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
    reloaded.env.DATA_DIR = dir;
    const rt2 = new Runtime(reloaded);
    try {
      expect(rt2.config.risk.WATCH_LIST_SIZE).toBe(25);
      expect(rt2.config.risk.BENCH_TARGET).toBe(12);
      expect(rt2.config.risk.ROSTER_SIZE).toBe(3);
      expect(rt2.config.risk.PER_MINT_CAP_USD).toBe(0);
      expect(rt2.config.risk.SHADOW_BACKFILL_ON_ADMIT).toBe(false);
    } finally {
      rt2.stop();
    }
  });

  it('refuses a bench target above the stored watch-list size (merged config)', async () => {
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': extractCsrf(cookie) },
      body: JSON.stringify({ BENCH_TARGET: 99 }),
    });
    expect(res.status).toBe(400);
    const state = (await (await app.request('/api/state', { headers: { cookie } })).json()) as {
      version: number;
    };
    const settings = (await (await app.request('/api/settings', { headers: { cookie } })).json()) as {
      risk: Record<string, number>;
    };
    expect(settings.risk.BENCH_TARGET).toBe(12);
    expect(state.version).toBeGreaterThan(0);
  });
});

function extractCsrf(cookie: string): string {
  const m = cookie.match(/zcode_csrf=([^;]+)/);
  return m ? m[1]! : '';
}
