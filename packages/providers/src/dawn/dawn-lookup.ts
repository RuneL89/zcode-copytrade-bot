import type { BrowserContext, Page } from 'playwright-core';

/**
 * Read-only Dawn (Telegram) trader-lookup adapter.
 *
 * Why this exists: Fomo never shows trader wallet addresses on any surface,
 * but the Dawn Telegram bot resolves a fomo `@handle` to the wallets Dawn
 * displays for that trader (plus on-chain quality stats). Sending one plain
 * text message per handle and reading the reply replaces the manual
 * copy-from-Dawn step the operator would otherwise do.
 *
 * Hard boundaries (mirrors the fomo-web adapter):
 * - Telegram's platform forbids bot-to-bot messaging, so no "our own bot"
 *   can ever read Dawn's replies; the only legitimate surface is a
 *   user-owned Telegram session. The operator logs into Telegram Web ONCE,
 *   in person, by scanning a QR code in the visible browser window. The
 *   adapter NEVER sees, asks for, or stores credentials, and never relays
 *   login codes through any channel.
 * - It only sends plain text ("@handle") into the Dawn bot chat and reads
 *   the bot's reply text. It never taps "Copy trader", never confirms a
 *   copytrade task, never moves funds, and never calls private APIs.
 * - Dawn is a data source only; trading always executes through this app.
 * - Fails closed on: missing login, markup drift, timeouts, ambiguous parses.
 */

export interface DawnLookupConfig {
  /** Dawn bot username (without @). */
  botUsername: string;
  /** Telegram Web base URL (web-k client; deep-links via #username hash). */
  webAppUrl: string;
  /** Persistent browser profile directory (keeps the manual QR login). */
  profileDir: string;
  /** Optional executable path for the browser to launch (playwright-core ships none). */
  executablePath?: string;
  /** Channel: installed Chrome/Edge, or a playwright-installed chromium. */
  channel?: 'chrome' | 'msedge';
  headless: boolean;
  /** How long to wait for the bot's reply before failing, ms. */
  replyTimeoutMs: number;
  /**
   * Minimum gap between lookups, ms. The actual gap is this value plus a
   * random 0-100% jitter so message cadence is not metronomic (anti-spam).
   */
  perLookupDelayMs: number;
}

export const DEFAULT_DAWN_CONFIG: DawnLookupConfig = {
  botUsername: 'DawnTradeBot',
  webAppUrl: 'https://web.telegram.org/k/',
  profileDir: './data/browser-profile-dawn',
  headless: false,
  replyTimeoutMs: 45_000,
  perLookupDelayMs: 20_000,
};

// ---------------------------------------------------------------------------
// Attempt budget: never look like a bot hammering failed lookups
// ---------------------------------------------------------------------------

export interface DawnAttemptRecord {
  attempts: number;
  lastAt: string;
  cooldownUntil: string;
  status: 'try' | 'resolved' | 'gave-up';
}

export interface DawnAttemptPolicy {
  /** Give up after this many failed attempts per handle (stopped for good). */
  maxAttempts: number;
  /** First-failure cooldown; doubles each time up to maxCooldownMs. */
  baseCooldownMs: number;
  maxCooldownMs: number;
}

/**
 * Conservative-by-default: a human looks up a trader once or twice, not five
 * times an hour. Failures escalate 1h -> 2h -> 4h (capped), then the handle
 * is left alone for good — it stays address-less and ineligible instead of
 * generating spam-shaped traffic.
 */
export const DEFAULT_ATTEMPT_POLICY: DawnAttemptPolicy = {
  maxAttempts: 3,
  baseCooldownMs: 60 * 60_000,
  maxCooldownMs: 48 * 60 * 60_000,
};

export function nextAttemptRecord(
  prev: DawnAttemptRecord | undefined,
  ok: boolean,
  now: Date,
  policy: DawnAttemptPolicy = DEFAULT_ATTEMPT_POLICY,
): DawnAttemptRecord {
  if (ok) {
    return {
      attempts: prev?.attempts ?? 0,
      lastAt: now.toISOString(),
      cooldownUntil: now.toISOString(),
      status: 'resolved',
    };
  }
  const attempts = (prev?.attempts ?? 0) + 1;
  const cooldownMs = Math.min(policy.baseCooldownMs * 2 ** (attempts - 1), policy.maxCooldownMs);
  return {
    attempts,
    lastAt: now.toISOString(),
    cooldownUntil: new Date(now.getTime() + cooldownMs).toISOString(),
    status: attempts >= policy.maxAttempts ? 'gave-up' : 'try',
  };
}

export function shouldAttemptNow(
  rec: DawnAttemptRecord | undefined,
  now: Date,
): { ok: boolean; reason: string } {
  if (!rec) return { ok: true, reason: 'never attempted' };
  if (rec.status === 'resolved') return { ok: false, reason: 'already resolved' };
  if (rec.status === 'gave-up') return { ok: false, reason: 'gave up after repeated failures' };
  if (new Date(rec.cooldownUntil).getTime() > now.getTime()) return { ok: false, reason: 'cooling down' };
  return { ok: true, reason: 'cooldown elapsed' };
}

/** Thrown when the Telegram Web session is missing/expired: needs one manual QR scan. */
export class DawnNeedsLoginError extends Error {
  constructor() {
    super(
      'dawn: Telegram Web session missing — open the Dawn browser window and scan the QR (one-time manual login)',
    );
    this.name = 'DawnNeedsLoginError';
  }
}

export type DawnCardVariant = 'rich' | 'compact-pnl' | 'addresses-only' | 'unknown';

export interface DawnTraderInfo {
  handle: string;
  solanaAddress: string | null;
  evmAddress: string | null;
  /** Legacy rich-card field: "PnL on fomo" (USD, unverified). */
  pnlOnFomoUsd: number | null;
  /** "Realized on-chain" (rich card only; null on the compact card). */
  realizedOnchainUsd: number | null;
  /** "Win N%" (rich card only; null on the compact card). */
  winRatePct: number | null;
  /** Compact card: PnL per period as displayed by Dawn (unrealized marks). */
  pnl24hUsd: number | null;
  pnl7dUsd: number | null;
  pnl30dUsd: number | null;
  pnlAllTimeUsd: number | null;
  /** Compact card: leaderboard position per period, when Dawn shows it. */
  rank24h: number | null;
  rank7d: number | null;
  rankAllTime: number | null;
  /** Compact card Trading block: lifetime trades, volume, recent flow. */
  tradesTotal: number | null;
  volumeUsd: number | null;
  recentBuys: number | null;
  recentSells: number | null;
  coinsTraded: number | null;
  /** Hours since Dawn's "Last trade: Nh ago" line; null when absent. */
  lastTradeAgeHours: number | null;
  /** Which card layout the reply matched — lets callers tell absent from unparsed. */
  cardVariant: DawnCardVariant;
  /** Raw reply text kept for audit; never contains credentials. */
  rawReplyText: string;
}

// ---------------------------------------------------------------------------
// Pure parsing (unit-tested; DOM-independent)
// ---------------------------------------------------------------------------

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Strict full-length Solana address shape (43–44 base58 chars, untrimmed input). */
export function isFullSolanaAddress(value: string): boolean {
  return value.length >= 43 && value.length <= 44 && BASE58.test(value);
}

/**
 * Parse money as Dawn displays it: "+$1.6M", "−$93.6K", "-$1,234.56", "$272.7K".
 * Handles the Unicode minus (−). Returns null when no amount is present.
 */
export function parseDawnMoney(text: string): number | null {
  const m = text.replace(/\u2212/g, '-').match(/([-+]?)\s*\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMB])?/i);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const digits = m[2] ?? '';
  const base = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = (m[3] ?? '').toUpperCase();
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
  return sign * base * mult;
}

function moneyAfterLabel(text: string, label: RegExp, windowChars = 60): number | null {
  const m = label.exec(text);
  if (!m) return null;
  return parseDawnMoney(text.slice(m.index + m[0].length, m.index + m[0].length + windowChars));
}

function pctAfterLabel(text: string, label: RegExp, windowChars = 40): number | null {
  const m = label.exec(text);
  if (!m) return null;
  const window = text.slice(m.index + m[0].length, m.index + m[0].length + windowChars);
  const pct = window.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return pct ? Number(pct[1]) : null;
}

/** First capture-group money inside a regex match on flattened text. */
function moneyFrom(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  return m ? parseDawnMoney(m[1] ?? '') : null;
}

/** First capture-group integer (commas allowed) inside a regex match. */
function intFrom(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  if (!m) return null;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "Last trade: 8h ago" / "1h ago" / "25m ago" / "2d ago" -> hours. */
export function hoursAgoFrom(text: string): number | null {
  if (/last trade:\s*(just now|now)\b/i.test(text)) return 0;
  const m = /last trade:\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*ago/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit.startsWith('d')) return v * 24;
  if (unit.startsWith('h')) return v;
  return v / 60;
}

const BOUND = String.fromCharCode(0); // never occurs in message text; used to join safely

/**
 * Parse a Dawn trader-card reply (plain text of one or more bubbles).
 * Layout observed in the wild (whitespace/newlines vary):
 *   PnL on fomo +$1.6M / Win 13% / Swaps 1,696 / Realized on-chain −$93.6K
 *   Wallets / Solana / Beqv6...eit / Copy / EVM / 0xfd8...d94 / Copy
 * All fields are null-safe: an unparseable reply yields nulls, not an error.
 */
export function parseDawnTraderReply(text: string): Omit<DawnTraderInfo, 'handle'> {
  const t = text.replace(/\u00a0/g, ' ');
  // Label-anchored Solana address first; bare scan as fallback. Lookarounds
  // prevent matching inside longer base58 runs.
  const labeledSol =
    /solana[\s:]*\n?[^\n]{0,20}?((?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{43,44}(?![1-9A-HJ-NP-Za-km-z]))/i.exec(
      t,
    );
  const bareSol = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{43,44}(?![1-9A-HJ-NP-Za-km-z])/.exec(t);
  const solanaAddress = labeledSol?.[1] ?? bareSol?.[0] ?? null;
  const labeledEvm = /evm[\s:]*\n?[^\n]{0,20}?(0x[a-fA-F0-9]{40})/i.exec(t);
  const bareEvm = /0x[a-fA-F0-9]{40}/.exec(t);
  const evmAddress = labeledEvm?.[1] ?? bareEvm?.[0] ?? null;

  // Legacy rich-card labels (the richer card layout).
  const pnlOnFomoUsd = moneyAfterLabel(t, /pnl on fomo/i);
  const realizedOnchainUsd = moneyAfterLabel(t, /realized on[- ]?chain/i);
  const winRatePct = pctAfterLabel(t, /\bwin\b/i);

  // Compact card text is line-broken ("24h: \n +$390.1K · #5"), so period
  // parsing runs on whitespace-flattened text.
  const n = t.replace(/\s+/g, ' ');
  const pnl24hUsd = moneyFrom(n, /24h:\s*([-+]?\$[\d.,]+\s*[KMB]?)/i);
  const pnl7dUsd = moneyFrom(n, /7d:\s*([-+]?\$[\d.,]+\s*[KMB]?)/i);
  const pnl30dUsd = moneyFrom(n, /30d:\s*([-+]?\$[\d.,]+\s*[KMB]?)/i);
  const pnlAllTimeUsd = moneyFrom(n, /all time:\s*([-+]?\$[\d.,]+\s*[KMB]?)/i);
  const rank24h = intFrom(n, /24h:\s*[-+]?\$[\d.,]+\s*[KMB]?\s*·\s*#(\d+)/i);
  const rank7d = intFrom(n, /7d:\s*[-+]?\$[\d.,]+\s*[KMB]?\s*·\s*#(\d+)/i);
  const rankAllTime = intFrom(n, /all time:\s*[-+]?\$[\d.,]+\s*[KMB]?\s*·\s*#(\d+)/i);

  // Trading block.
  const tradesTotal = intFrom(n, /\btrades:\s*([\d,]+)/i);
  const volumeUsd = moneyFrom(n, /\bvolume:\s*(\$[\d.,]+\s*[KMB]?)/i);
  const recent = /recent buys\s*\/\s*sells:\s*(\d+)\s*\/\s*(\d+)/i.exec(n);
  const recentBuys = recent ? Number(recent[1]) : null;
  const recentSells = recent ? Number(recent[2]) : null;
  const coinsTraded = intFrom(n, /\bcoins:\s*(\d+)/i);
  const lastTradeAgeHours = hoursAgoFrom(n);

  const cardVariant: DawnCardVariant =
    realizedOnchainUsd !== null || winRatePct !== null
      ? 'rich'
      : pnl24hUsd !== null ||
          pnl7dUsd !== null ||
          pnl30dUsd !== null ||
          pnlAllTimeUsd !== null ||
          tradesTotal !== null
        ? 'compact-pnl'
        : solanaAddress
          ? 'addresses-only'
          : 'unknown';

  return {
    solanaAddress: solanaAddress && isFullSolanaAddress(solanaAddress) ? solanaAddress : null,
    evmAddress,
    pnlOnFomoUsd,
    realizedOnchainUsd,
    winRatePct,
    pnl24hUsd,
    pnl7dUsd,
    pnl30dUsd,
    pnlAllTimeUsd,
    rank24h,
    rank7d,
    rankAllTime,
    tradesTotal,
    volumeUsd,
    recentBuys,
    recentSells,
    coinsTraded,
    lastTradeAgeHours,
    cardVariant,
    rawReplyText: t.slice(0, 4000),
  };
}

export function extractReplyTail(bubbleTexts: string[], sentText: string): string {
  const joined = bubbleTexts.join(BOUND);
  const idx = joined.lastIndexOf(sentText);
  if (idx === -1) return '';
  const tail = joined.slice(idx + sentText.length);
  return tail.split(BOUND).join('\n');
}

/** True when a tail looks like a real trader card (any marker) rather than noise. */
export function tailLooksLikeTraderCard(tail: string): boolean {
  return (
    /pnl on fomo|wallets|realized on[- ]?chain|\bSOL\s*:/i.test(tail) || isFullSolanaAddress(tail.trim())
  );
}

// ---------------------------------------------------------------------------
// Browser adapter
// ---------------------------------------------------------------------------

interface SendProbe {
  bubbleCount: number;
  tail: string;
}

export class DawnTraderLookupProvider {
  readonly name = 'dawn-lookup';
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastLookupAt = 0;

  constructor(private config: DawnLookupConfig) {}

  async available(): Promise<boolean> {
    return this.config.botUsername.trim().length > 0;
  }

  /**
   * Launch a VISIBLE browser on the Telegram Web login page so the operator
   * can scan the QR once. The session persists in the profile directory.
   */
  async openForManualLogin(): Promise<void> {
    const page = await this.ensurePage();
    if (!page.url().startsWith(this.config.webAppUrl)) {
      await page
        .goto(this.config.webAppUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        .catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
  }

  /**
   * Resolve one fomo handle via the Dawn bot. Sends the trader's fomo.family
   * profile link when provided (the documented trader-card trigger; a bare
   * "@handle" is interpreted by Dawn as a token-ticker search) and parses the
   * bot's reply. Throws DawnNeedsLoginError when the session is missing;
   * other errors are fail-closed with context included.
   */
  async lookupHandle(handle: string, profileUrl?: string): Promise<DawnTraderInfo> {
    const clean = handle.trim().replace(/^@/, '');
    if (!clean) throw new Error('dawn: empty handle');
    const sentText = (profileUrl ?? '').trim() || `@${clean}`;
    if (Date.now() - this.lastLookupAt < this.config.perLookupDelayMs) {
      const base = this.config.perLookupDelayMs - (Date.now() - this.lastLookupAt);
      const jitter = Math.floor(Math.random() * this.config.perLookupDelayMs); // 0-100%: non-metronomic
      await sleep(base + jitter);
    }
    const page = await this.ensureChat();
    const input = await this.messageInput(page);
    await this.assertNotLoggingIn(page);

    const before = await this.probe(page, sentText);
    await input.click();
    await page.keyboard.type(sentText, { delay: 25 });
    await page.keyboard.press('Enter');
    this.lastLookupAt = Date.now();
    await sleep(2_500); // let the SPA settle; deep-link/hash navigation can churn

    const deadline = Date.now() + this.config.replyTimeoutMs;
    let tail = '';
    while (Date.now() < deadline) {
      await sleep(1_200);
      const probe = await this.probe(page, sentText);
      tail = probe.tail;
      // Dawn often renders the trader card as a web-preview attached to OUR
      // message (no new bubble), so bubble counts are not a success signal —
      // the anchored tail content is.
      if (tail && tailLooksLikeTraderCard(tail)) {
        const parsed = parseDawnTraderReply(tail);
        // Card previews truncate displayed addresses ("2heJ…og…"); the full
        // addresses live behind Dawn's inline "(Copy)" buttons — click and
        // read the clipboard. NEVER touches "Copy trader" (exact-match only).
        if (!parsed.solanaAddress || !parsed.evmAddress) {
          const fromButtons = await this.copyWalletsFromButtons(page);
          parsed.solanaAddress = parsed.solanaAddress ?? fromButtons.solana;
          parsed.evmAddress = parsed.evmAddress ?? fromButtons.evm;
        }
        return { handle: clean, ...parsed };
      }
      if (/not found|couldn'?t find|no results|nothing found/i.test(tail)) {
        throw new Error(`dawn: bot found no trader for @${clean}: ${truncate(tail, 200)}`);
      }
      // The SPA can bounce to the auth screen mid-run (fresh sessions do this
      // once); detect and surface it instead of spinning to timeout.
      await this.assertNotLoggingIn(page).catch(() => undefined);
    }
    // Final attempt: the last tail may already carry a complete address that
    // raced the loop's marker checks.
    const last = parseDawnTraderReply(tail);
    if (last.solanaAddress) return { handle: clean, ...last };
    throw new Error(
      `dawn: no trader-card reply for @${clean} within ${this.config.replyTimeoutMs}ms; last tail: ${truncate(tail, 200)}`,
    );
  }

  /** Best-effort session probe for scheduling/audit: 'ready' | 'needs-login'. */
  async sessionState(): Promise<'ready' | 'needs-login'> {
    const page = await this.ensurePage();
    await page
      .goto(`${this.config.webAppUrl}#@${this.config.botUsername}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      .catch(() => undefined);
    await sleep(3_000);
    const inputCount = await page.locator('div[contenteditable="true"]').count();
    if (inputCount > 0) return 'ready';
    const text = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).toLowerCase();
    if (/log in by qr|log in to telegram|qr code/.test(text)) return 'needs-login';
    throw new Error('dawn: Telegram Web DOM unrecognized (markup drift, fail closed)');
  }

  // ---- internals ------------------------------------------------------------

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    const pw = (await import('playwright-core')) as unknown as typeof import('playwright-core');
    const launch = this.config.executablePath
      ? { executablePath: this.config.executablePath }
      : this.config.channel
        ? { channel: this.config.channel }
        : {};
    this.context = await pw.chromium.launchPersistentContext(this.config.profileDir, {
      headless: this.config.headless,
      ...launch,
    });
    // Clipboard reads power the wallet Copy-button extraction.
    await this.context
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://web.telegram.org' })
      .catch(() => undefined);
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  /** Navigate to the bot chat and wait until the message input exists. */
  private async ensureChat(): Promise<Page> {
    const page = await this.ensurePage();
    const chatUrl = `${this.config.webAppUrl}#@${this.config.botUsername}`;
    if (!page.url().includes(`#@${this.config.botUsername}`)) {
      await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    }
    const input = page.locator('div.input-message-input[contenteditable="true"]').first();
    try {
      await input.waitFor({ state: 'visible', timeout: 20_000 });
    } catch {
      await this.assertNotLoggingIn(page);
      throw new Error(
        'dawn: message input not found in Telegram Web (markup drift or chat not open, fail closed)',
      );
    }
    return page;
  }

  private async messageInput(page: Page) {
    const input = page.locator('div.input-message-input[contenteditable="true"]').first();
    if ((await input.count()) === 0) {
      await this.assertNotLoggingIn(page);
      throw new Error('dawn: message input disappeared (fail closed)');
    }
    return input;
  }

  private async assertNotLoggingIn(page: Page): Promise<void> {
    const text = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).toLowerCase();
    if (/log in by qr code|log in to telegram by phone/.test(text)) throw new DawnNeedsLoginError();
  }

  /** Read the chat's message bubbles and the reply tail after our handle text. */
  /**
   * Click Dawn's inline wallet "Copy" buttons (exact label match — never
   * "Copy trader") and read the clipboard to recover full addresses that the
   * message text truncates. Returns whatever classified cleanly.
   */
  private async copyWalletsFromButtons(page: Page): Promise<{ solana: string | null; evm: string | null }> {
    const out: { solana: string | null; evm: string | null } = { solana: null, evm: null };
    let buttons = page.locator('.btn-inline', { hasText: /^Copy$/ });
    if ((await buttons.count()) === 0) {
      buttons = page.locator('button', { hasText: /^Copy$/ });
    }
    const n = Math.min(await buttons.count(), 4);
    for (let i = 0; i < n; i++) {
      try {
        await buttons.nth(i).click({ timeout: 3_000 });
        await sleep(400);
        const text = await page
          .evaluate(() => {
            const nav = (globalThis as { navigator?: { clipboard?: { readText(): Promise<string> } } })
              .navigator;
            return nav?.clipboard ? nav.clipboard.readText() : Promise.resolve('');
          })
          .catch(() => '');
        const t = (text ?? '').trim();
        if (isFullSolanaAddress(t) && !out.solana) out.solana = t;
        else if (/^0x[a-fA-F0-9]{40}$/.test(t) && !out.evm) out.evm = t;
        if (out.solana && out.evm) break;
      } catch {
        // button may vanish between locate and click; skip
      }
    }
    return out;
  }

  private async probe(page: Page, sentText: string): Promise<SendProbe> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const bubbleTexts = await page.evaluate(() => {
          // DOM types are unavailable in this package's tsconfig; access narrowly.
          const doc = (
            globalThis as { document?: { querySelectorAll(s: string): Iterable<{ innerText?: string }> } }
          ).document;
          if (!doc) return [] as string[];
          return Array.from(doc.querySelectorAll('.bubble, .message'))
            .map((n) => (n.innerText || '').trim())
            .filter((t) => t.length > 0);
        });
        return { bubbleCount: bubbleTexts.length, tail: extractReplyTail(bubbleTexts, sentText) };
      } catch (e) {
        // SPA navigation can destroy the execution context mid-evaluate; transient.
        if (/execution context|context was destroyed|target closed/i.test((e as Error).message)) {
          await sleep(1_500);
          continue;
        }
        throw e;
      }
    }
    return { bubbleCount: 0, tail: '' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
