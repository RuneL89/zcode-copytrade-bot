import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@zcode-bot/config';
import { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/http/app.js';

/**
 * Provider-keys endpoint: validation, .env persistence (to a test-owned file),
 * live application, and the write-only guarantee — key values must never
 * appear in any response.
 */
let dir: string;
let envFile: string;
let rt: Runtime;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-keys-'));
  envFile = join(dir, 'env-test.txt');
  process.env.ZCODE_ENV_FILE = envFile;
  const config = loadConfig({ SESSION_SECRET: 'k'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
  config.env.DATA_DIR = dir;
  rt = new Runtime(config);
});

afterAll(() => {
  rt.stop();
  delete process.env.ZCODE_ENV_FILE;
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

describe('provider keys API', () => {
  let app: ReturnType<typeof buildApp>;
  let cookie: string;
  let csrf: string;
  const HELIUS_KEY = 'test-helius-key-0123456789abcdef';
  const JUP_KEY = 'test-jupiter-key-1234567890';

  beforeAll(async () => {
    app = buildApp(rt);
    rt.ensureSetupToken();
    const boot = (await (await app.request('/api/bootstrap')).json()) as {
      needsSetup: boolean;
      testSetupToken: string | null;
    };
    const res = await app.request('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setupToken: boot.testSetupToken,
        username: 'keysuser',
        password: 'keys-password-1',
      }),
    });
    const cookies = extractSetCookie(res);
    csrf = cookies['zcode_csrf']!;
    cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${csrf}`;
  });

  it('requires auth', async () => {
    expect(
      (
        await app.request('/api/settings/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
  });

  it('rejects invalid keys', async () => {
    const short = await app.request('/api/settings/keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ heliusApiKey: 'short' }),
    });
    expect(short.status).toBe(400);

    const spaces = await app.request('/api/settings/keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ heliusApiKey: 'has spaces in key 1234' }),
    });
    expect(spaces.status).toBe(400);

    const empty = await app.request('/api/settings/keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it('accepts valid keys, applies live, and never echoes the value', async () => {
    const res = await app.request('/api/settings/keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ heliusApiKey: HELIUS_KEY, jupiterApiKey: JUP_KEY }),
    });
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(HELIUS_KEY);
    expect(body).not.toContain(JUP_KEY);
    expect(body).toContain('"helius":true');

    // Applied live in the running providers.
    expect(rt.helius.configured).toBe(true);

    // Settings view reports configured but never includes the value.
    const settings = await app.request('/api/settings', { headers: { cookie } });
    const settingsText = JSON.stringify(await settings.json());
    expect(settingsText).toContain('"heliusConfigured":true');
    expect(settingsText).not.toContain(HELIUS_KEY);
    expect(settingsText).not.toContain(JUP_KEY);

    // Persisted to the env file for restarts.
    expect(existsSync(envFile)).toBe(true);
    const envText = readFileSync(envFile, 'utf8');
    expect(envText).toContain(`HELIUS_API_KEY=${HELIUS_KEY}`);
    expect(envText).toContain(`JUPITER_API_KEY=${JUP_KEY}`);
  });

  it('replacing a key updates the same line instead of duplicating it', async () => {
    const KEY2 = 'test-helius-key-fedcba9876543210';
    const res = await app.request('/api/settings/keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ heliusApiKey: KEY2 }),
    });
    expect(res.status).toBe(200);
    const envText = readFileSync(envFile, 'utf8');
    expect(envText).toContain(`HELIUS_API_KEY=${KEY2}`);
    expect(envText).not.toContain(HELIUS_KEY);
    expect(envText.match(/HELIUS_API_KEY=/g)?.length).toBe(1);
  });
});
