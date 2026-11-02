import { describe, expect, it } from 'vitest';
import { FomoApiClient } from '../src/fomoapi.js';

/** Every test injects `fetchImpl`; no test can reach the network. */
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const KEY = 'test-key-123';
const client = (fetchImpl: typeof fetch, apiKey = KEY) =>
  new FomoApiClient({ baseUrl: 'https://api.test', apiKey, fetchImpl, sleepImpl: async () => {} });

describe('FomoApiClient — leaderboard', () => {
  it('calls the window endpoint with limit=150 and both auth headers (AC1)', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return json([{ userId: 'u1', handle: 'alpha', pnlUsd: 12.5, wallets: { solana: 'WalletAlpha' } }], {
        headers: { 'x-credits-cost': '250', 'x-credits-remaining': '248500', etag: '"w1"' },
      });
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).leaderboard('7d');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.test/v2/leaderboard/7d?limit=150');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers['x-api-key']).toBe(KEY); // documented fallback header
    expect(result.rows).toEqual([{ userId: 'u1', handle: 'alpha', pnlUsd: 12.5, wallet: 'WalletAlpha' }]);
    expect(result.creditsCost).toBe(250);
    expect(result.creditsRemaining).toBe(248500);
    expect(result.etag).toBe('"w1"');
    expect(result.notModified).toBe(false);
    expect(result.unparsed).toBe(0);
  });

  it('builds the url for every window', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      seen.push(String(url));
      return json([]);
    }) as unknown as typeof fetch;
    const c = client(fetchImpl);
    await c.leaderboard('24h');
    await c.leaderboard('30d', 150);
    expect(seen).toEqual([
      'https://api.test/v2/leaderboard/24h?limit=150',
      'https://api.test/v2/leaderboard/30d?limit=150',
    ]);
  });

  it('sends If-None-Match and treats 304 as unchanged with zero credits (AC3)', async () => {
    let sent: string | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = ((init?.headers ?? {}) as Record<string, string>)['if-none-match'];
      return new Response(null, {
        status: 304,
        headers: { 'x-credits-cost': '0', 'x-credits-remaining': '248250' },
      });
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).leaderboard('24h', 150, { etag: '"w1"' });
    expect(sent).toBe('"w1"');
    expect(result.notModified).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.creditsCost).toBe(0);
    expect(result.creditsRemaining).toBe(248250);
    expect(result).not.toHaveProperty('error');
  });

  it('maps 401 and 402 to typed errors without retrying (AC2)', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [402, 'credits_exhausted'],
    ] as const) {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response('{}', { status });
      }) as unknown as typeof fetch;
      await expect(client(fetchImpl).leaderboard('24h')).rejects.toMatchObject({
        name: 'FomoApiError',
        code,
        status,
      });
      expect(calls).toBe(1);
    }
  });

  it('retries 429 up to the bound, then throws rate_limited (AC2)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('{}', { status: 429 });
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).leaderboard('24h')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls).toBe(3); // initial attempt + 2 bounded retries
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 429 });
      return json([{ userId: 'u1', handle: 'alpha' }], { headers: { 'x-credits-cost': '250' } });
    }) as unknown as typeof fetch;
    const result = await client(fetchImpl).leaderboard('24h');
    expect(calls).toBe(2);
    expect(result.rows).toHaveLength(1);
  });

  it('maps a timeout to a typed error (AC2)', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    const c = new FomoApiClient({
      baseUrl: 'https://api.test',
      apiKey: KEY,
      fetchImpl,
      timeoutMs: 5,
      sleepImpl: async () => {},
    });
    await expect(c.leaderboard('24h')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('refuses a non-JSON body or a payload with no rows instead of returning empty rows (AC2)', async () => {
    const htmlFetch = (async () =>
      new Response('<html>nope</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    await expect(client(htmlFetch).leaderboard('24h')).rejects.toMatchObject({ code: 'bad_payload' });

    const noRowsFetch = (async () => json({ ok: true })) as unknown as typeof fetch;
    await expect(client(noRowsFetch).leaderboard('24h')).rejects.toMatchObject({ code: 'bad_payload' });
  });

  it('counts unusable rows instead of inventing fields', async () => {
    const fetchImpl = (async () =>
      json([
        { handle: 'no-user-id' },
        { userId: 'u2' },
        { userId: 'u3', handle: 'beta', pnlUsd: '4.5' },
      ])) as unknown as typeof fetch;
    const result = await client(fetchImpl).leaderboard('24h');
    expect(result.rows).toEqual([{ userId: 'u3', handle: 'beta', pnlUsd: 4.5, wallet: null }]);
    expect(result.unparsed).toBe(2);
  });

  it('accepts a wrapped payload and numeric user ids', async () => {
    const fetchImpl = (async () =>
      json({ data: [{ userId: 42, handle: 'gamma' }] })) as unknown as typeof fetch;
    const result = await client(fetchImpl).leaderboard('30d');
    expect(result.rows[0]).toEqual({ userId: '42', handle: 'gamma', pnlUsd: null, wallet: null });
  });

  it('refuses to call at all without a key (AC2/AC6)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return json([]);
    }) as unknown as typeof fetch;
    const c = new FomoApiClient({ baseUrl: 'https://api.test', apiKey: '   ', fetchImpl });
    expect(c.configured).toBe(false);
    await expect(c.leaderboard('24h')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toBe(0);
  });
});

describe('FomoApiClient — alerts', () => {
  it('parses trader/userId/token/usdValue and never requires a wallet (AC5)', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      return json(
        {
          alerts: [
            {
              trader: 'delta',
              userId: 'u9',
              token: 'MEOW',
              usdValue: 1234.5,
              ts: '2026-11-02T00:00:00Z',
            },
            { userId: 'u10' }, // no trader → unusable
          ],
        },
        { headers: { 'x-credits-cost': '125', 'x-credits-remaining': '248125' } },
      );
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).alerts();
    expect(urls).toEqual(['https://api.test/v2/alerts?limit=50']);
    expect(result.alerts).toEqual([
      { userId: 'u9', handle: 'delta', token: 'MEOW', usdValue: 1234.5, ts: '2026-11-02T00:00:00Z' },
    ]);
    expect(result.unparsed).toBe(1);
    expect(result.creditsCost).toBe(125);
    expect(result.creditsRemaining).toBe(248125);
  });

  it('keeps an alert without a userId (the service decides what to do)', async () => {
    const fetchImpl = (async () => json([{ trader: 'solo' }])) as unknown as typeof fetch;
    const result = await client(fetchImpl).alerts();
    expect(result.alerts).toEqual([{ userId: null, handle: 'solo', token: null, usdValue: null, ts: null }]);
  });
});
