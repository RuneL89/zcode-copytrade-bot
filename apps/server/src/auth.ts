import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

/**
 * Single-user auth: scrypt password hashing, HMAC-signed session cookies
 * (HttpOnly + SameSite=Strict), CSRF double-submit tokens, and in-memory
 * login/control rate limits. The first user is created through the setup
 * wizard using a one-time token printed on the server console.
 */

const SESSION_COOKIE = 'zcode_session';
const CSRF_COOKIE = 'zcode_csrf';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export interface SessionPayload {
  sub: string; // username
  exp: number;
}

export class SessionManager {
  constructor(private secret: string) {}

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }

  issue(username: string): { token: string; expiresAt: number } {
    const payload: SessionPayload = { sub: username, exp: Date.now() + SESSION_TTL_MS };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${body}.${this.sign(body)}`;
    return { token, expiresAt: payload.exp };
  }

  verify(token: string | undefined | null): SessionPayload | null {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = this.sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
      if (payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }
}

export function applySessionCookie(c: Context, token: string, expiresAt: number): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: secureCookies(),
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export function csrfCookieName(): string {
  return CSRF_COOKIE;
}

/** Double-submit CSRF: cookie value must equal X-CSRF-Token header. */
export function csrfOk(c: Context): boolean {
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header('x-csrf-token');
  return Boolean(cookie && header && cookie.length >= 16 && cookie === header);
}

export function issueCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

export function applyCsrfCookie(c: Context, token: string): void {
  setCookie(c, CSRF_COOKIE, token, {
    httpOnly: false, // readable by the SPA for the double-submit header
    sameSite: 'Strict',
    // Must mirror applySessionCookie: a Secure CSRF cookie is dropped over
    // plain HTTP (e.g. phone access on the LAN), which would fail every
    // state-changing request.
    secure: secureCookies(),
    // Persist for the session lifetime. Without an expiry this is a browser
    // -session cookie, which mobile browsers drop aggressively while the
    // 12h login cookie survives — leaving the user logged in but unable to
    // pass any CSRF check.
    expires: new Date(Date.now() + SESSION_TTL_MS),
    path: '/',
  });
}

/** Cookies are Secure in production unless the operator opts out for LAN HTTP. */
function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.FORCE_INSECURE_COOKIE !== '1';
}

/** Simple fixed-window rate limiter (per key). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    entry.count++;
    if (entry.count > this.max) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

// Login bursts are capped at 5 per 10 minutes per source; override only for
// test harnesses (LOGIN_RATE_LIMIT_MAX) where every test signs in fresh.
const loginMax = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 5);
export const loginLimiter = new RateLimiter(
  Number.isFinite(loginMax) && loginMax > 0 ? loginMax : 5,
  10 * 60 * 1000,
);
export const controlLimiter = new RateLimiter(30, 60 * 1000);

/** Auth guard middleware factory. */
export type AppEnv = { Variables: { username: string } };

export function requireAuth(sessions: SessionManager) {
  return async (c: Context<AppEnv>, next: Next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const payload = sessions.verify(token);
    if (!payload) return c.json({ error: 'unauthorized' }, 401);
    c.set('username', payload.sub);
    await next();
  };
}

/** CSRF guard for state-changing endpoints (always combined with requireAuth). */
export async function requireCsrf(c: Context, next: Next) {
  if (!csrfOk(c)) return c.json({ error: 'csrf check failed' }, 403);
  await next();
}

/** Redact obvious secrets from arbitrary error objects before logging. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 24 && /^(sk-|[A-Za-z0-9]{40,})/.test(value)
      ? value.slice(0, 6) + '...[redacted]'
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|password|token|apikey|api_key|privatekey|private_key/i.test(k)) out[k] = '[redacted]';
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
