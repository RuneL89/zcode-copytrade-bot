import { z } from 'zod';

/**
 * fomoapi.io leaderboard + alerts client (D3 inlet).
 *
 * Decided contract (D3, verified 2026-11-01 against the live API):
 * - `GET /v2/leaderboard/{24h|7d|30d}?limit=150` — free tier: 250,000
 *   credits/month, 250 credits per leaderboard request.
 * - `GET /v2/alerts?limit=N` — each alert carries trader/userId/token/usdValue
 *   (no wallet; alerts only discover traders).
 * - Each leaderboard row carries a stable `userId`, the handle, the window
 *   `pnlUsd` and a verified `wallets.solana`.
 * - `trades` / `volumeUsd` are lifetime figures and are NOT read here: activity
 *   and copyability are measured by our own funded-swap scan (D4).
 *
 * Fail-closed: every failure surfaces as a typed `FomoApiError`; an empty row
 * list is only ever returned for a genuine empty/304 answer, never for a
 * malformed payload.
 */

export type FomoApiWindow = '24h' | '7d' | '30d';

export interface FomoApiLeaderboardRow {
  /** Stable API identity — handles change, this does not (D3). */
  userId: string;
  handle: string;
  /** Window PnL in USD as displayed. Context only, never a hire gate. */
  pnlUsd: number | null;
  /** The row's verified Solana wallet, when the API carries one. */
  wallet: string | null;
}

export interface FomoApiLeaderboardResult {
  rows: FomoApiLeaderboardRow[];
  /** True when the API answered 304 (If-None-Match matched): leave the pool as-is. */
  notModified: boolean;
  /** Rows the payload carried that the parser could not use (shape drift). */
  unparsed: number;
  creditsCost: number | null;
  creditsRemaining: number | null;
  etag: string | null;
}

export interface FomoApiAlert {
  /** Null when the alert does not identify the trader by user id. */
  userId: string | null;
  handle: string;
  token: string | null;
  usdValue: number | null;
  /** Raw timestamp as delivered (string or number) — used for context only. */
  ts: string | null;
}

export interface FomoApiAlertsResult {
  alerts: FomoApiAlert[];
  unparsed: number;
  creditsCost: number | null;
  creditsRemaining: number | null;
}

export type FomoApiErrorCode =
  'unauthorized' | 'credits_exhausted' | 'rate_limited' | 'http_error' | 'timeout' | 'bad_payload';

export class FomoApiError extends Error {
  constructor(
    readonly code: FomoApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FomoApiError';
  }
}

export interface FomoApiClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout (default 15s). */
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Bounded retry for 429/5xx only — never for 401/402. */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 1500];

const numberLike = z.union([z.number(), z.string()]);
const idLike = z.union([z.string(), z.number()]);

const rowSchema = z.object({
  userId: idLike.nullable().optional(),
  handle: z.string().optional(),
  pnlUsd: numberLike.nullable().optional(),
  wallets: z.object({ solana: z.string().nullable().optional() }).partial().optional(),
});

const alertSchema = z.object({
  trader: z.string().optional(),
  userId: idLike.nullable().optional(),
  token: z.string().nullish(),
  usdValue: numberLike.nullable().optional(),
  ts: z.union([z.string(), z.number()]).nullish(),
});

export class FomoApiClient {
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: FomoApiClientConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = config.fetchImpl ?? fetch;
    this.sleep = config.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** A key must be present before any call — the service checks this first. */
  get configured(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async leaderboard(
    window: FomoApiWindow,
    limit = 150,
    opts: { etag?: string | null } = {},
  ): Promise<FomoApiLeaderboardResult> {
    const res = await this.request(`/v2/leaderboard/${window}`, { limit: String(limit) }, opts.etag ?? null);
    const { creditsCost, creditsRemaining, etag } = readCreditHeaders(res);
    if (res.status === 304) {
      return { rows: [], notModified: true, unparsed: 0, creditsCost: 0, creditsRemaining, etag };
    }
    const payload = await this.json(res);
    const rawRows = unwrapArray(payload, 'leaderboard rows');
    const rows: FomoApiLeaderboardRow[] = [];
    let unparsed = 0;
    for (const raw of rawRows) {
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) {
        unparsed++;
        continue;
      }
      const userId = parsed.data.userId == null ? '' : String(parsed.data.userId).trim();
      const handle = (parsed.data.handle ?? '').trim();
      if (!userId || !handle) {
        unparsed++;
        continue;
      }
      rows.push({
        userId,
        handle,
        pnlUsd: toNumberOrNull(parsed.data.pnlUsd),
        wallet: emptyToNull(parsed.data.wallets?.solana),
      });
    }
    return { rows, notModified: false, unparsed, creditsCost, creditsRemaining, etag };
  }

  async alerts(limit = 50): Promise<FomoApiAlertsResult> {
    const res = await this.request('/v2/alerts', { limit: String(limit) });
    const { creditsCost, creditsRemaining } = readCreditHeaders(res);
    const payload = await this.json(res);
    const rawAlerts = unwrapArray(payload, 'alerts');
    const alerts: FomoApiAlert[] = [];
    let unparsed = 0;
    for (const raw of rawAlerts) {
      const parsed = alertSchema.safeParse(raw);
      if (!parsed.success) {
        unparsed++;
        continue;
      }
      const handle = (parsed.data.trader ?? '').trim();
      if (!handle) {
        unparsed++;
        continue;
      }
      alerts.push({
        userId: parsed.data.userId == null ? null : String(parsed.data.userId).trim() || null,
        handle,
        token: emptyToNull(parsed.data.token),
        usdValue: toNumberOrNull(parsed.data.usdValue),
        ts: parsed.data.ts == null ? null : String(parsed.data.ts),
      });
    }
    return { alerts, unparsed, creditsCost, creditsRemaining };
  }

  /** One HTTP attempt with bounded 429/5xx retries; auth errors never retry. */
  private async request(
    path: string,
    params: Record<string, string>,
    etag: string | null = null,
  ): Promise<Response> {
    if (!this.configured) {
      throw new FomoApiError('unauthorized', 'FOMOAPI_KEY is not configured');
    }
    const url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let lastError: FomoApiError | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0)
        await this.sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]!);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.doFetch(url.toString(), {
          method: 'GET',
          headers: {
            // Bearer is the documented primary; x-api-key is the documented
            // fallback header, sent alongside so either variant authenticates.
            authorization: `Bearer ${this.config.apiKey}`,
            'x-api-key': this.config.apiKey,
            accept: 'application/json',
            ...(etag ? { 'if-none-match': etag } : {}),
          },
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const aborted = (e as { name?: string }).name === 'AbortError';
        lastError = new FomoApiError(
          aborted ? 'timeout' : 'http_error',
          aborted ? `request timed out after ${this.timeoutMs}ms` : `request failed: ${(e as Error).message}`,
        );
        continue; // transport failures are retried like 5xx
      }
      clearTimeout(timer);

      if (res.status === 401) {
        throw new FomoApiError('unauthorized', 'fomoapi rejected the key (401)', 401);
      }
      if (res.status === 402) {
        throw new FomoApiError('credits_exhausted', 'fomoapi credits exhausted (402)', 402);
      }
      if (res.status === 429) {
        lastError = new FomoApiError('rate_limited', 'fomoapi rate limit (429)', 429);
        continue;
      }
      if (res.status >= 500) {
        lastError = new FomoApiError('http_error', `fomoapi server error (${res.status})`, res.status);
        continue;
      }
      if (!res.ok && res.status !== 304) {
        throw new FomoApiError('http_error', `fomoapi answered ${res.status}`, res.status);
      }
      return res;
    }
    throw lastError ?? new FomoApiError('http_error', 'fomoapi call failed');
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new FomoApiError('bad_payload', `non-JSON body (status ${res.status})`, res.status);
    }
  }
}

function readCreditHeaders(res: Response): {
  creditsCost: number | null;
  creditsRemaining: number | null;
  etag: string | null;
} {
  return {
    creditsCost: parseIntOrNull(res.headers.get('x-credits-cost')),
    creditsRemaining: parseIntOrNull(res.headers.get('x-credits-remaining')),
    etag: res.headers.get('etag'),
  };
}

/**
 * The rows live either at the top level or under a wrapper object; the first
 * array-valued field is the payload (no field-name guessing).
 */
function unwrapArray(payload: unknown, what: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const value of Object.values(payload as Record<string, unknown>)) {
      if (Array.isArray(value)) return value;
    }
  }
  throw new FomoApiError('bad_payload', `payload carries no ${what} array`);
}

function parseIntOrNull(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNumberOrNull(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
