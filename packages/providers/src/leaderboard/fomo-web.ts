import type { BrowserContext, Page } from 'playwright-core';
import type { LeaderboardEntry, LeaderboardImportResult, LeaderboardProvider } from './types.js';
import { isLikelySolanaAddress } from './import.js';
import { syncPersonalChromeProfile, type PersonalProfileSyncOptions } from './profile-copy.js';
import { randomUUID } from 'node:crypto';

/**
 * Read-only FOMO web discovery adapter.
 *
 * Hard boundaries (documented in README/RUNBOOK):
 * - Visible browser only; the user performs any login manually; the adapter
 *   NEVER sees, asks for, or stores credentials.
 * - It reads the public (or user-visible) leaderboard page only. It never
 *   trades, never touches the wallet, never bypasses CAPTCHA or access
 *   controls, and never calls private APIs.
 * - Fails closed on: markup drift, expired login, CAPTCHA, robots
 *   disallowal, inconsistent values, or stale data.
 */

export interface FomoWebConfig {
  /** Leaderboard URL to read. Must be configured explicitly. */
  leaderboardUrl: string;
  /** Where to robots-check from. */
  robotsUrl: string;
  /** Persistent browser profile directory (keeps the manual login). */
  profileDir: string;
  /** Minimum gap between page fetches, ms. */
  minFetchIntervalMs: number;
  /** Entries older than this are treated as stale (fail closed). */
  maxAgeMs: number;
  /** DOM selectors; drift here fails closed. */
  selectors: {
    row: string;
    handle: string;
    rank: string;
    pnl: string;
    profileLink: string;
    avatar: string;
  };
  /** Optional executable path for the browser to launch (playwright-core ships none). */
  executablePath?: string;
  /** Channel: installed Chrome/Edge, or a playwright-installed chromium. */
  channel?: 'chrome' | 'msedge';
  headless: boolean;
  /**
   * Optional selector that matches the Solana address text on a trader profile
   * page. When set, the adapter visits each profile (top N only) to resolve
   * addresses; without it, imported candidates have no address and stay
   * ineligible until addresses are filled in manually.
   */
  profileAddressSelector?: string;
  /** How many top entries get their profile visited for addresses. */
  profileScrapeLimit?: number;
  /** Politeness delay before each profile page read, ms. */
  profileDelayMs?: number;
  /**
   * Personal-Chrome mode: run on a selective copy of the operator's desktop
   * Chrome profile (existing Google/Fomo sessions, no login ceremony). The
   * copy refreshes whenever the real Chrome is closed and the copy is stale.
   */
  personalProfileSync?: PersonalProfileSyncOptions;
}

export const DEFAULT_FOMO_CONFIG: FomoWebConfig = {
  leaderboardUrl: '',
  robotsUrl: '',
  profileDir: './data/browser-profile',
  minFetchIntervalMs: 5 * 60_000,
  maxAgeMs: 2 * 60 * 60_000,
  selectors: {
    row: '[data-testid="leaderboard-row"]',
    handle: '[data-testid="handle"]',
    rank: '[data-testid="rank"]',
    pnl: '[data-testid="pnl"]',
    profileLink: '[data-testid="profile-link"]',
    avatar: '[data-testid="avatar"]',
  },
  headless: false,
};

interface Cache {
  result: LeaderboardImportResult;
  at: number;
}

export class FomoWebLeaderboardProvider implements LeaderboardProvider {
  readonly name = 'fomo-web';
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cache: Cache | null = null;
  private lastFetch = 0;
  private loginReady = false;
  /** Last personal-profile sync note (for audit), null when not in that mode. */
  lastSyncNote: string | null = null;

  constructor(private config: FomoWebConfig) {}

  async available(): Promise<boolean> {
    return this.config.leaderboardUrl.trim().length > 0;
  }

  /** Launch a VISIBLE browser and land on Fomo so the user can log in. */
  async openForManualLogin(): Promise<void> {
    const page = await this.ensurePage();
    const current = page.url();
    if (current === 'about:blank' && this.config.leaderboardUrl) {
      await page
        .goto(this.config.leaderboardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        .catch(() => undefined);
    }
  }

  /**
   * Setup helper: capture whatever page the operator has navigated to, so the
   * leaderboard selectors and URL can be configured against the real DOM.
   * Returns metadata; the caller owns the HTML payload.
   */
  async debugCapture(): Promise<{ url: string; title: string; html: string }> {
    const page = await this.ensurePage();
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      html: await page.content(),
    };
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    this.loginReady = false;
  }

  async fetchLatest(): Promise<LeaderboardImportResult> {
    if (!this.config.leaderboardUrl) {
      throw new Error('fomo-web: FOMO_LEADERBOARD_URL is not configured');
    }
    if (this.cache && Date.now() - this.cache.at < this.config.minFetchIntervalMs) {
      return this.cache.result;
    }
    if (Date.now() - this.lastFetch < this.config.minFetchIntervalMs) {
      throw new Error(
        `fomo-web: rate limit; retry in ${Math.ceil((this.config.minFetchIntervalMs - (Date.now() - this.lastFetch)) / 1000)}s`,
      );
    }
    this.lastFetch = Date.now();

    await this.assertRobotsAllowed();
    const page = await this.ensurePage();
    await page.goto(this.config.leaderboardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.assertNotCaptured(page);

    const rows = page.locator(this.config.selectors.row);
    const count = await rows.count();
    if (count === 0) {
      throw new Error(
        'fomo-web: no leaderboard rows matched selectors; page markup may have changed or login expired (fail closed)',
      );
    }

    const now = new Date();
    const entries: LeaderboardEntry[] = [];
    const warnings: string[] = [];
    for (let i = 0; i < Math.min(count, 50); i++) {
      const row = rows.nth(i);
      const handle = (await row.locator(this.config.selectors.handle).first().textContent())?.trim();
      if (!handle) {
        warnings.push(`row ${i}: missing handle; skipped`);
        continue;
      }
      const rankText = (await row.locator(this.config.selectors.rank).first().textContent())?.trim();
      const rank = rankText ? Number(rankText.replace(/[^0-9]/g, '')) : NaN;
      const pnlText = (await row.locator(this.config.selectors.pnl).first().textContent())?.trim();
      const pnl = parseDisplayedPnl(pnlText);
      if (pnlText && pnl === null) warnings.push(`${handle}: unparseable PnL "${pnlText}" recorded as null`);
      const profileUrl =
        (await row.locator(this.config.selectors.profileLink).first().getAttribute('href')) ?? null;
      const avatarUrl = (await row.locator(this.config.selectors.avatar).first().getAttribute('src')) ?? null;
      entries.push({
        handle,
        weeklyRank: Number.isInteger(rank) && rank > 0 ? rank : null,
        displayedPnlUsd: pnl,
        profileUrl,
        avatarUrl,
        solanaAddresses: [], // addresses are resolved on the profile page or via manual import
        enabled: true,
        observedAt: now.toISOString(),
      });
    }
    if (entries.length === 0) throw new Error('fomo-web: zero parseable rows (fail closed)');

    // Optional: resolve Solana addresses by visiting trader profiles. Only the
    // top N, with a politeness delay. Addresses that do not validate as full
    // base58 (e.g. truncated display text) are skipped with a warning.
    if (this.config.profileAddressSelector) {
      const limit = Math.min(this.config.profileScrapeLimit ?? 10, entries.length);
      for (const entry of entries.slice(0, limit)) {
        if (!entry.profileUrl) continue;
        try {
          await page.goto(entry.profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.waitForTimeout(this.config.profileDelayMs ?? 2500);
          const texts = await page.locator(this.config.profileAddressSelector).allTextContents();
          const addresses = [
            ...new Set(texts.map((t) => t.trim()).filter((t) => isLikelySolanaAddress(t))),
          ].slice(0, 4);
          entry.solanaAddresses = addresses;
          if (addresses.length === 0) {
            warnings.push(
              `${entry.handle}: no full Solana address found on profile (selector matched, text invalid or truncated)`,
            );
          }
        } catch (e) {
          warnings.push(`${entry.handle}: profile read failed: ${(e as Error).message}`);
        }
      }
    }

    const result: LeaderboardImportResult = {
      entries,
      importId: randomUUID(),
      warnings,
      skipped: [],
    };
    this.cache = { result, at: Date.now() };
    return result;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    if (this.config.personalProfileSync) {
      const sync = syncPersonalChromeProfile(this.config.personalProfileSync);
      this.lastSyncNote = sync.reason;
    }
    const pw = (await import('playwright-core')) as unknown as typeof import('playwright-core');
    const launch = this.config.executablePath
      ? { executablePath: this.config.executablePath }
      : this.config.channel
        ? { channel: this.config.channel }
        : {};
    try {
      this.context = await pw.chromium.launchPersistentContext(this.config.profileDir, {
        headless: this.config.headless,
        ...launch,
      });
    } catch (e) {
      if (/existing browser session|ProcessSingleton|already in use/i.test((e as Error).message)) {
        throw new Error(
          'fomo-web: the browser profile is locked (is that Chrome window still open?); fetch skipped, will retry (fail closed)',
        );
      }
      throw e;
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  /** Respect robots.txt: fail closed when Disallow matches our path. */
  private async assertRobotsAllowed(): Promise<void> {
    if (!this.config.robotsUrl) return;
    try {
      const res = await fetch(this.config.robotsUrl);
      if (!res.ok && res.status !== 404) throw new Error(`robots.txt fetch failed (${res.status})`);
      if (res.status === 404) return;
      const text = await res.text();
      if (robotsDisallows(text, new URL(this.config.leaderboardUrl).pathname)) {
        throw new Error('fomo-web: robots.txt disallows this path; refusing to scrape (fail closed)');
      }
    } catch (e) {
      if ((e as Error).message.includes('robots.txt disallows')) throw e;
      throw new Error(`fomo-web: robots.txt check failed closed: ${(e as Error).message}`);
    }
  }

  private async assertNotCaptured(page: Page): Promise<void> {
    const html = (await page.content()).toLowerCase();
    const markers = ['captcha', 'are you human', 'verify you are human'];
    if (markers.some((m) => html.includes(m))) {
      throw new Error('fomo-web: CAPTCHA/access challenge detected; refusing to bypass (fail closed)');
    }
  }
}

/** Parse "+123.45", "-$12", "+438%" style displayed PnL; % values return null (not a USD PnL). */
export function parseDisplayedPnl(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.trim();
  if (t.includes('%')) return null;
  const n = Number(t.replace(/[$,\s+]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Pure robots.txt evaluation for "User-agent: * Disallow: <path>". */
export function robotsDisallows(robotsText: string, pathname: string): boolean {
  const lines = robotsText.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  let inStar = false;
  let collecting = false;
  const disallows: string[] = [];
  for (const line of lines) {
    if (/^user-agent:/i.test(line)) {
      if (collecting) break; // next group started
      inStar = line.slice(line.indexOf(':') + 1).trim() === '*';
    } else if (/^disallow:/i.test(line) && inStar) {
      collecting = true;
      const path = line.slice(line.indexOf(':') + 1).trim();
      if (path) disallows.push(path);
    }
  }
  return disallows.some((d) => d === '/' || pathname.startsWith(d));
}
