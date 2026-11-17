import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { loadConfig, type RiskConfig } from '@zcode-bot/config';
import { STABLE_MINTS, type FundedSwap, type LeaderTxSummary, type TokenDelta } from '@zcode-bot/core';
import { PriceUnavailableError } from '@zcode-bot/providers';
import { WatchService, shadowPnlUsdMicro, type WatchServiceDeps } from '../src/services/watch.js';
import { Runtime } from '../src/runtime.js';
import { buildApp } from '../src/http/app.js';

let dir: string;
let handle: ReturnType<typeof openDatabase>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zcode-watch-'));
  handle = openDatabase(dir);
  const migrationsFolder = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    '..',
    '..',
    'packages',
    'db',
    'drizzle',
  );
  migrate(handle.db, { migrationsFolder });
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const USDC = [...STABLE_MINTS][0]!;
const TOKEN = 'TokenMint111111111111111111111111111111111111';
const HOUR = 3_600_000;
const NOW_SEC = Math.floor(Date.now() / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

/** D4 thresholds scaled down so the tests stay readable. */
function riskConfig(over: Partial<RiskConfig> = {}): RiskConfig {
  const risk = loadConfig({ SESSION_SECRET: 'w'.repeat(48) }).risk;
  return {
    ...risk,
    MIN_PER_BUY_USD: 5,
    MAX_PER_BUY_USD: 10,
    PROMOTION_MIN_CLOSED: 3,
    PROMOTION_MIN_NET_USD: 1,
    PROMOTION_MAX_LAST_BUY_HOURS: 4,
    ADMISSION_MIN_BUYS_24H: 3,
    ADMISSION_MAX_LAST_BUY_HOURS: 24,
    ROSTER_SIZE: 5,
    MAX_POSITION_AGE_HOURS: 8,
    POSITION_GRACE_HOURS: 3,
    WATCH_EVICTION_DAYS: 14,
    SHADOW_BACKFILL_ON_ADMIT: false,
    ...over,
  };
}

function leg(mint: string, deltaBase: bigint, decimals = 6): TokenDelta {
  return { mint, decimals, preBase: 0n, postBase: deltaBase, deltaBase };
}

/** A funded swap summary (stable or native SOL funding). */
function swapSummary(over: {
  signature: string;
  minutesAgo: number;
  tokens: bigint;
  usd: bigint;
  side: 'buy' | 'sell';
  native?: boolean;
  mint?: string;
}): LeaderTxSummary {
  const mint = over.mint ?? TOKEN;
  const tokenDelta = over.side === 'buy' ? over.tokens : -over.tokens;
  return {
    chain: 'solana',
    leaderAddress: 'Leader',
    signature: over.signature,
    slot: 1,
    transactionIndex: 0,
    blockTime: NOW_SEC - over.minutesAgo * 60,
    err: false,
    nativeDeltaBase: over.native ? (over.side === 'buy' ? -over.usd : over.usd) : 0n,
    tokenDeltas: over.native
      ? [leg(mint, tokenDelta)]
      : [leg(mint, tokenDelta), leg(USDC, over.side === 'buy' ? -over.usd : over.usd)],
    programs: [],
  };
}

interface Harness {
  svc: WatchService;
  summaries: Map<string, LeaderTxSummary>;
  page: Array<{ signature: string; blockTime: number | null }>;
  /** Per-address overrides, so one test can give wallets different histories. */
  perAddress: Map<
    string,
    { page: Array<{ signature: string; blockTime: number | null }>; summaries: Map<string, LeaderTxSummary> }
  >;
  prices: Map<string, bigint>;
  /** Injected price failures (typed no-route or transient). */
  priceErrors: Map<string, Error>;
  hired: string[];
  /** Signature-page attempts per address (admission scan cadence). */
  signatureCalls: Map<string, number>;
  /** Paid detail attempts per address (watch-list safety valve). */
  heliusDetailCalls: Map<string, number>;
}

interface HarnessOptions {
  /** Simulate the public RPC being configured (Helius fallback stays the answer). */
  publicConfigured?: boolean;
  /** Every public signature/detail call throws (e.g. HTTP 429). */
  publicPageFails?: boolean;
  publicDetailFails?: boolean;
  /** Per-address Helius failures. */
  heliusPageFailures?: string[];
  heliusDetailFailures?: string[];
}

function harness(risk: RiskConfig, over: HarnessOptions = {}): Harness {
  const summaries = new Map<string, LeaderTxSummary>();
  const page: Array<{ signature: string; blockTime: number | null }> = [];
  const perAddress = new Map<
    string,
    { page: Array<{ signature: string; blockTime: number | null }>; summaries: Map<string, LeaderTxSummary> }
  >();
  const prices = new Map<string, bigint>([[TOKEN, 1_000_000n]]); // $1.00 per whole token
  const priceErrors = new Map<string, Error>();
  const hired: string[] = [];
  const signatureCalls = new Map<string, number>();
  const heliusDetailCalls = new Map<string, number>();
  const notePageCall = (address: string) =>
    signatureCalls.set(address, (signatureCalls.get(address) ?? 0) + 1);

  const pageFor = (address: string, limit = 100, before?: string) => {
    const rows = perAddress.get(address)?.page ?? page;
    if (before === undefined) return rows.slice(0, limit).map((row) => ({ ...row }));
    const index = rows.findIndex((row) => row.signature === before);
    if (index === -1) return [];
    return rows.slice(index + 1, index + 1 + limit).map((row) => ({ ...row }));
  };

  const deps: WatchServiceDeps = {
    db: handle.db,
    risk,
    publicSolana: {
      configured: over.publicConfigured ?? false,
      recentSignatures: async (address: string, limit = 100, before?: string) => {
        notePageCall(address);
        if (over.publicPageFails) throw new Error('public-solana: rate limited (HTTP 429)');
        return pageFor(address, limit, before);
      },
      transactionSummary: async (address: string, signature: string) => {
        if (over.publicDetailFails) throw new Error('public-solana: rate limited (HTTP 429)');
        return perAddress.get(address)?.summaries.get(signature) ?? summaries.get(signature) ?? null;
      },
    } as unknown as WatchServiceDeps['publicSolana'],
    helius: {
      latestCursor: async () => ({
        lastSignature: '',
        lastSlot: 0,
        lastTransactionIndex: 0,
        lastBlockTime: null,
      }),
      // Production shape: the tolerant method returns [] when the RPC fails.
      recentSignatures: async (address: string, limit = 100, before?: string) => {
        if (over.heliusPageFailures?.includes(address)) return [];
        return pageFor(address, limit, before);
      },
      // Admission uses the strict method, which throws instead of hiding failure.
      recentSignaturesStrict: async (address: string, limit = 100, before?: string) => {
        notePageCall(address);
        if (over.heliusPageFailures?.includes(address)) throw new Error('helius: HTTP 429');
        return pageFor(address, limit, before);
      },
      transactionSummary: async (address: string, signature: string) => {
        heliusDetailCalls.set(address, (heliusDetailCalls.get(address) ?? 0) + 1);
        if (over.heliusDetailFailures?.includes(address)) throw new Error('helius: HTTP 429');
        return perAddress.get(address)?.summaries.get(signature) ?? summaries.get(signature) ?? null;
      },
    } as unknown as WatchServiceDeps['helius'],
    prices: {
      priceOf: async (mint: string) => {
        const injected = priceErrors.get(mint);
        if (injected) throw injected;
        const priceUsdMicro = prices.get(mint);
        if (priceUsdMicro === undefined) throw new Error('no quote');
        return { priceUsdMicro, observedAt: Date.now() };
      },
    } as unknown as WatchServiceDeps['prices'],
    lifecycle: {
      hireFromWatch: async (candidateId: string) => {
        if (!hired.includes(candidateId)) hired.push(candidateId);
        return { ok: true, activationId: 'act_' + candidateId };
      },
      // The watch tick seats free chairs through fillRoster; the stub hires the
      // bench in payload order (the real one ranks by shadow net — roster.test
      // covers that).
      fillRoster: async () => {
        const ids = repo
          .listWatchWallets(handle.db, 'bench')
          .map((w) => w.candidateId)
          .filter((id) => !hired.includes(id));
        hired.push(...ids);
        return { hired: ids, reason: ids.length > 0 ? 'roster filled' : 'no promotable wallet' };
      },
    } as unknown as WatchServiceDeps['lifecycle'],
    onStateChanged: () => {},
  };

  return {
    svc: new WatchService(deps),
    summaries,
    page,
    perAddress,
    prices,
    priceErrors,
    hired,
    signatureCalls,
    heliusDetailCalls,
  };
}

function seedCandidate(candidateId: string, candidateHandle: string, address: string | null): void {
  repo.upsertCandidate(handle.db, {
    candidateId,
    handle: candidateHandle,
    weeklyRank: null,
    displayedWeeklyPnlUsdMicro: null,
    profileUrl: null,
    avatarUrl: null,
    enabled: true,
    source: 'fomoapi',
    observedAt: iso(Date.now()),
  });
  if (address !== null) {
    repo.upsertCandidateAddress(handle.db, candidateId, {
      chain: 'solana',
      address,
      verification: 'reported',
    });
  }
}

function seedWatching(candidateId: string, candidateHandle: string, address: string): void {
  seedCandidate(candidateId, candidateHandle, address);
  repo.upsertWatchWallet(handle.db, {
    candidateId,
    address,
    status: 'watching',
    reason: 'test',
  });
  repo.setWatchCursor(handle.db, {
    address,
    candidateId,
    lastSignature: '',
    lastSlot: 0,
    lastTransactionIndex: 0,
  });
}

function setActivity(
  candidateId: string,
  over: Partial<{
    swaps24h: number;
    lastSwapAt: string | null;
    lastBuyAt: string | null;
    buys24h: number;
    sells24h: number;
    checkedAt: string;
  }> = {},
): void {
  repo.updateCandidateActivity(handle.db, candidateId, {
    swaps24h: 0,
    lastSwapAt: null,
    lastBuyAt: null,
    buys24h: 0,
    sells24h: 0,
    status: 'ok',
    checkedAt: iso(Date.now()),
    ...over,
  });
}

/** Give every candidate a fresh reading so one deliberately stale target is first in line. */
function stampAllActivity(checkedAt = iso(Date.now())): void {
  for (const candidate of repo.listCandidates(handle.db)) {
    setActivity(candidate.candidateId, { checkedAt });
  }
}

/** Record funded buys on the watch record (the promotion clock reads these). */
function recordBuys(candidateId: string, address: string, count: number, minutesAgo: number): void {
  for (let i = 0; i < count; i++) {
    repo.insertWatchEvent(handle.db, {
      candidateId,
      address,
      signature: `seed-buy-${candidateId}-${minutesAgo}-${i}`,
      side: 'buy',
      mint: TOKEN,
      tokenAmountBase: '6000000',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: NOW_SEC - Math.round(minutesAgo * 60),
      observedAt: iso(Date.now() - minutesAgo * 60_000),
      source: 'test',
    });
  }
}

/** Admission reading from a set of swaps (funded definition). */
function readingFrom(
  swaps: Array<{ signature: string; side: 'buy' | 'sell'; tokens: bigint; usd: bigint; minutesAgo: number }>,
) {
  const events: FundedSwap[] = swaps.map((s) => ({
    side: s.side,
    signature: s.signature,
    slot: 1,
    transactionIndex: 0,
    blockTime: NOW_SEC - s.minutesAgo * 60,
    mint: TOKEN,
    decimals: 6,
    tokenDeltaBase: s.side === 'buy' ? s.tokens : -s.tokens,
    fundingMint: USDC,
    fundingDecimals: 6,
    fundingDeltaBase: s.usd,
  }));
  const buys = events.filter((e) => e.side === 'buy');
  const newest = buys[buys.length - 1] ?? null;
  return {
    fundedBuys24h: buys.length,
    lastFundedBuyAt: newest && newest.blockTime !== null ? iso(newest.blockTime * 1000) : null,
    measuredAt: iso(Date.now()),
    partial: false,
    events,
  };
}

const buy = (signature: string, minutesAgo: number, tokens = 6_000_000n, usd = 6_000_000n) => ({
  signature,
  side: 'buy' as const,
  tokens,
  usd,
  minutesAgo,
});
const sell = (signature: string, minutesAgo: number, tokens = 6_000_000n, usd = 6_000_000n) => ({
  signature,
  side: 'sell' as const,
  tokens,
  usd,
  minutesAgo,
});

describe('WatchService — admission (AC2)', () => {
  it('admits a wallet with enough fresh funded buys and starts the cursor at the tip', async () => {
    seedCandidate('cand_watch1', 'watcher1', 'Wallet1');
    const h = harness(riskConfig());
    const verdict = await h.svc.admit(
      'cand_watch1',
      readingFrom([buy('b1', 60), buy('b2', 30), buy('b3', 10)]),
    );
    expect(verdict).toEqual({ ok: true, reason: 'ADMITTED' });
    const wallet = repo.getWatchWallet(handle.db, 'cand_watch1');
    expect(wallet?.status).toBe('watching');
    expect(wallet?.address).toBe('Wallet1');
    expect(repo.getWatchCursor(handle.db, 'Wallet1')).toBeTruthy();
    expect(repo.listAudit(handle.db, 5).some((a) => /watch admitted: watcher1/.test(a.message))).toBe(true);
  });

  it('refuses too few funded buys, a stale last buy, a stale reading and a walletless candidate', async () => {
    seedCandidate('cand_watch2', 'watcher2', 'Wallet2');
    seedCandidate('cand_nowallet', 'nowallet', null);
    const h = harness(riskConfig());
    expect((await h.svc.admit('cand_watch2', readingFrom([buy('b1', 60), buy('b2', 30)]))).reason).toBe(
      'TOO_FEW_FUNDED_BUYS',
    );
    expect(
      (
        await h.svc.admit(
          'cand_watch2',
          readingFrom([buy('b1', 30 * 60), buy('b2', 29 * 60), buy('b3', 28 * 60)]),
        )
      ).reason,
    ).toBe('LAST_BUY_TOO_OLD');
    const stale = {
      ...readingFrom([buy('b1', 10), buy('b2', 9), buy('b3', 8)]),
      measuredAt: iso(Date.now() - 6 * HOUR),
    };
    expect((await h.svc.admit('cand_watch2', stale)).reason).toBe('STALE_READING');
    expect(
      (
        await h.svc.admit('cand_nowallet', {
          ...readingFrom([buy('b1', 10), buy('b2', 9), buy('b3', 8)]),
        })
      ).reason,
    ).toBe('NO_WALLET');
    const listed = repo.listWatchWallets(handle.db).map((w) => w.candidateId);
    expect(listed).not.toContain('cand_watch2');
    expect(listed).not.toContain('cand_nowallet');
  });
});

describe('WatchService — shadow ledger (AC3/AC4/AC5/AC9)', () => {
  it('a funded buy opens one lot at the D1 notional; a funded sell closes it at the leader price', async () => {
    seedCandidate('cand_shadow', 'shadowy', 'WalletShadow');
    const h = harness(riskConfig());
    await h.svc.admit('cand_shadow', readingFrom([buy('a1', 60), buy('a2', 30), buy('a3', 10)]));

    // A buy of $24 → 0.25x = $6 → clamped to the $5 floor? No: $6 is inside [5,10].
    h.summaries.set(
      'buy-1',
      swapSummary({ signature: 'buy-1', minutesAgo: 5, tokens: 6_000_000n, usd: 6_000_000n, side: 'buy' }),
    );
    h.page.unshift({ signature: 'buy-1', blockTime: NOW_SEC - 5 * 60 });
    await h.svc.tick();

    let lots = repo.listOpenShadowTrades(handle.db, 'cand_shadow');
    expect(lots).toHaveLength(1);
    // 0.25 × $6 is below the $5 floor, so the lot takes the floor (D1).
    expect(lots[0]!.notionalUsdMicro).toBe('5000000');
    expect(lots[0]!.entryPriceUsdMicro).toBe('1000000'); // the LEADER's $1 per token

    // The leader sells his 6 tokens for $9 ($1.50 each): the lot's 5 tokens make $7.50.
    h.summaries.set(
      'sell-1',
      swapSummary({ signature: 'sell-1', minutesAgo: 2, tokens: 6_000_000n, usd: 9_000_000n, side: 'sell' }),
    );
    h.page.unshift({ signature: 'sell-1', blockTime: NOW_SEC - 2 * 60 });
    await h.svc.tick();

    lots = repo.listOpenShadowTrades(handle.db, 'cand_shadow');
    expect(lots).toHaveLength(0);
    const aggregates = repo.shadowAggregates(handle.db, 'cand_shadow');
    expect(aggregates.closedCount).toBe(1);
    // D4's working assumption (1% slippage per side) rides in the PnL: the
    // gross $5 → $7.50 becomes a little less.
    expect(aggregates.netPnlUsdMicro).toBe(shadowPnlUsdMicro(5_000_000n, 1_000_000n, 1_500_000n));
    expect(aggregates.netPnlUsdMicro).toBeLessThan(2_500_000n);
    expect(aggregates.netPnlUsdMicro).toBeGreaterThan(2_000_000n);

    // Re-polling the same signatures adds nothing (idempotent, AC9).
    await h.svc.tick();
    expect(repo.shadowAggregates(handle.db, 'cand_shadow').closedCount).toBe(1);
    expect(repo.listWatchEvents(handle.db, 'cand_shadow')).toHaveLength(2);
  });

  it('a partial sell closes FIFO lots proportionally and leaves the remainder open', async () => {
    seedCandidate('cand_fifo', 'fifo', 'WalletFifo');
    const h = harness(riskConfig());
    await h.svc.admit('cand_fifo', readingFrom([buy('f1', 60), buy('f2', 30), buy('f3', 10)]));

    // Two lots: the first takes the $5 floor (6 tokens at $1), the second the
    // $10 cap (10 tokens at $4).
    h.summaries.set(
      'f-b1',
      swapSummary({ signature: 'f-b1', minutesAgo: 20, tokens: 6_000_000n, usd: 6_000_000n, side: 'buy' }),
    );
    h.summaries.set(
      'f-b2',
      swapSummary({ signature: 'f-b2', minutesAgo: 15, tokens: 10_000_000n, usd: 40_000_000n, side: 'buy' }),
    );
    // Newest-first, like a signature page.
    h.page.unshift({ signature: 'f-b1', blockTime: NOW_SEC - 20 * 60 });
    h.page.unshift({ signature: 'f-b2', blockTime: NOW_SEC - 15 * 60 });
    await h.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_fifo')).toHaveLength(2);

    // Sell 2 of the 5 tokens the first lot holds (FIFO) at the entry price.
    h.summaries.set(
      'f-s1',
      swapSummary({ signature: 'f-s1', minutesAgo: 5, tokens: 2_000_000n, usd: 2_000_000n, side: 'sell' }),
    );
    h.page.unshift({ signature: 'f-s1', blockTime: NOW_SEC - 5 * 60 });
    // The live mark has to sit on the dearer lot's entry, or the −25% stop
    // closes that lot before the sell is applied.
    h.prices.set(TOKEN, 4_000_000n);
    await h.svc.tick();

    // The repo returns them in FIFO order (openedAt), which is the order the
    // sell consumed them in.
    const open = repo.listOpenShadowTrades(handle.db, 'cand_fifo');
    expect(open).toHaveLength(2); // the trimmed first lot + the untouched second
    expect(open[0]!.notionalUsdMicro).toBe('3000000'); // $5 − $2 closed
    expect(open[1]!.notionalUsdMicro).toBe('10000000');
    const aggregates = repo.shadowAggregates(handle.db, 'cand_fifo');
    expect(aggregates.closedCount).toBe(1);
    // Round-tripping at the same price is a small loss under D4's 1%-per-side
    // assumption — never a fake break-even.
    expect(aggregates.netPnlUsdMicro).toBe(shadowPnlUsdMicro(2_000_000n, 1_000_000n, 1_000_000n));
    expect(aggregates.netPnlUsdMicro).toBeLessThan(0n);
  });

  it('a sell with no lot (before admission) is ignored', async () => {
    seedCandidate('cand_nolot', 'nolot', 'WalletNoLot');
    const h = harness(riskConfig());
    await h.svc.admit('cand_nolot', readingFrom([buy('n1', 60), buy('n2', 30), buy('n3', 10)]));
    h.summaries.set(
      'n-sell',
      swapSummary({ signature: 'n-sell', minutesAgo: 5, tokens: 5_000_000n, usd: 5_000_000n, side: 'sell' }),
    );
    h.page.unshift({ signature: 'n-sell', blockTime: NOW_SEC - 5 * 60 });
    await h.svc.tick();
    expect(repo.shadowAggregates(handle.db, 'cand_nolot').closedCount).toBe(0);
    expect(repo.lastFundedSellAt(handle.db, 'cand_nolot')).toBeTruthy();
  });

  it('the ceiling closes an aged lot at the live quote (AC5)', async () => {
    seedCandidate('cand_ceiling', 'ceiling', 'WalletCeiling');
    const h = harness(riskConfig());
    await h.svc.admit('cand_ceiling', readingFrom([buy('c1', 60), buy('c2', 30), buy('c3', 10)]));

    // A buy 9h ago: already past MAX_POSITION_AGE_HOURS (8h). Scope the page
    // to this wallet so the shared test DB's other watchers do not receive it.
    const buySummary = swapSummary({
      signature: 'c-b1',
      minutesAgo: 9 * 60,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
    });
    h.perAddress.set('WalletCeiling', {
      page: [{ signature: 'c-b1', blockTime: NOW_SEC - 9 * 60 * 60 }],
      summaries: new Map([['c-b1', buySummary]]),
    });
    await h.svc.tick();
    const lot = repo.listOpenShadowTrades(handle.db, 'cand_ceiling')[0]!;
    expect(lot).toBeDefined();

    // Positive mark → closes now at the quote.
    h.prices.set(TOKEN, 2_000_000n);
    await h.svc.tick();
    const aggregates = repo.shadowAggregates(handle.db, 'cand_ceiling');
    expect(aggregates.closedCount).toBe(1);
    expect(aggregates.netPnlUsdMicro).toBe(shadowPnlUsdMicro(5_000_000n, 1_000_000n, 2_000_000n)); // $5 at $1 → $10 at $2
    expect(repo.listWatchEvents(handle.db, 'cand_ceiling').length).toBeGreaterThan(0);

    const stored = handle.sqlite
      .prepare('select exit_reason from shadow_trades where id = ?')
      .get(lot.id) as { exit_reason: string };
    expect(stored.exit_reason).toBe('grace_green');
    const audit = repo
      .listAudit(handle.db, 50)
      .find((a) => (a.dataJson ?? '').includes('cand_ceiling') && a.message.startsWith('shadow exit'));
    expect(audit?.message).toMatch(/shadow exit grace_green at \$.* after 9\.0h/);
    expect(JSON.parse(audit!.dataJson!)).toMatchObject({
      decision: 'grace_green',
      ageHours: 9,
    });
  });

  it('labels a stop-loss close with its real decision and age', async () => {
    seedCandidate('cand_stop_audit', 'stop_audit', 'WalletStopAudit');
    const h = harness(riskConfig());
    await h.svc.admit('cand_stop_audit', readingFrom([buy('sa1', 60), buy('sa2', 30), buy('sa3', 10)]));
    const buySummary = swapSummary({
      signature: 'sa-b1',
      minutesAgo: 60,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
    });
    h.perAddress.set('WalletStopAudit', {
      page: [{ signature: 'sa-b1', blockTime: NOW_SEC - 60 * 60 }],
      summaries: new Map([['sa-b1', buySummary]]),
    });
    await h.svc.tick();
    const lot = repo.listOpenShadowTrades(handle.db, 'cand_stop_audit')[0]!;

    // −50% is past the −25% stop, and the lot is only 1h old.
    h.prices.set(TOKEN, 500_000n);
    await h.svc.tick();
    const stored = handle.sqlite
      .prepare('select exit_reason from shadow_trades where id = ?')
      .get(lot.id) as { exit_reason: string };
    expect(stored.exit_reason).toBe('stop_loss');
    const audit = repo
      .listAudit(handle.db, 50)
      .find((a) => (a.dataJson ?? '').includes('cand_stop_audit') && a.message.startsWith('shadow exit'));
    expect(audit?.message).toMatch(/shadow exit stop_loss at \$.* after 1\.0h/);
    expect(audit?.message).not.toMatch(/ceiling closed/);
    expect(JSON.parse(audit!.dataJson!)).toMatchObject({
      decision: 'stop_loss',
      ageHours: 1,
    });
  });

  it('labels a grace-expired close with its real decision and age', async () => {
    seedCandidate('cand_grace_audit', 'grace_audit', 'WalletGraceAudit');
    const h = harness(riskConfig());
    await h.svc.admit('cand_grace_audit', readingFrom([buy('ga1', 60), buy('ga2', 30), buy('ga3', 10)]));
    const buySummary = swapSummary({
      signature: 'ga-b1',
      minutesAgo: 12 * 60,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
    });
    h.perAddress.set('WalletGraceAudit', {
      page: [{ signature: 'ga-b1', blockTime: NOW_SEC - 12 * 60 * 60 }],
      summaries: new Map([['ga-b1', buySummary]]),
    });
    await h.svc.tick();
    const lot = repo.listOpenShadowTrades(handle.db, 'cand_grace_audit')[0]!;

    // 12h old and 10% red: past max 8h + grace 3h, above the −25% stop.
    h.prices.set(TOKEN, 900_000n);
    await h.svc.tick();
    const stored = handle.sqlite
      .prepare('select exit_reason from shadow_trades where id = ?')
      .get(lot.id) as { exit_reason: string };
    expect(stored.exit_reason).toBe('grace_expired');
    const audit = repo
      .listAudit(handle.db, 50)
      .find((a) => (a.dataJson ?? '').includes('cand_grace_audit') && a.message.startsWith('shadow exit'));
    expect(audit?.message).toMatch(/shadow exit grace_expired at \$.* after 12\.0h/);
    expect(JSON.parse(audit!.dataJson!)).toMatchObject({
      decision: 'grace_expired',
      ageHours: 12,
    });
  });

  it('a negative mark rides to the grace deadline, and no quote never closes (AC5)', async () => {
    seedCandidate('cand_grace', 'grace', 'WalletGrace');
    const h = harness(riskConfig());
    await h.svc.admit('cand_grace', readingFrom([buy('g1', 60), buy('g2', 30), buy('g3', 10)]));
    h.summaries.set(
      'g-b1',
      swapSummary({
        signature: 'g-b1',
        minutesAgo: 9 * 60,
        tokens: 6_000_000n,
        usd: 6_000_000n,
        side: 'buy',
      }),
    );
    h.page.unshift({ signature: 'g-b1', blockTime: NOW_SEC - 9 * 60 * 60 });
    await h.svc.tick();

    // 9h old and only 10% red: inside the 3h grace, and above the −25% stop.
    h.prices.set(TOKEN, 900_000n);
    await h.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_grace')).toHaveLength(1);

    // No quote at all: still open, nothing invented.
    h.prices.delete(TOKEN);
    await h.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_grace')).toHaveLength(1);
  });

  it('closes a no-route lot at zero at the grace deadline, exactly once', async () => {
    seedCandidate('cand_unpriced', 'unpriced', 'WalletUnpriced');
    const h = harness(riskConfig());
    await h.svc.admit('cand_unpriced', readingFrom([buy('u1', 60), buy('u2', 30), buy('u3', 10)]));
    const buySummary = swapSummary({
      signature: 'u-b1',
      minutesAgo: 12 * 60,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
    });
    h.perAddress.set('WalletUnpriced', {
      page: [{ signature: 'u-b1', blockTime: NOW_SEC - 12 * 60 * 60 }],
      summaries: new Map([['u-b1', buySummary]]),
    });
    await h.svc.tick();
    const lot = repo.listOpenShadowTrades(handle.db, 'cand_unpriced')[0]!;
    const notional = BigInt(lot.notionalUsdMicro);

    h.priceErrors.set(TOKEN, new PriceUnavailableError('no_route', 'no route'));
    await h.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_unpriced')).toHaveLength(0);

    const aggregates = repo.shadowAggregates(handle.db, 'cand_unpriced');
    expect(aggregates.closedCount).toBe(1);
    expect(aggregates.netPnlUsdMicro).toBe(-notional);
    const row = handle.sqlite
      .prepare(
        'select status, exit_reason, exit_price_usd_micro, pnl_usd_micro from shadow_trades where id = ?',
      )
      .get(lot.id) as {
      status: string;
      exit_reason: string;
      exit_price_usd_micro: string;
      pnl_usd_micro: string;
    };
    expect(row).toEqual({
      status: 'closed',
      exit_reason: 'unpriceable',
      exit_price_usd_micro: '0',
      pnl_usd_micro: (-notional).toString(),
    });
    const audits = () =>
      repo
        .listAudit(handle.db, 500)
        .filter(
          (a) => a.message.includes('unpriceable at $0') && (a.dataJson ?? '').includes('cand_unpriced'),
        ).length;
    expect(audits()).toBe(1);

    // A second tick cannot double-close the same lot.
    await h.svc.tick();
    expect(repo.shadowAggregates(handle.db, 'cand_unpriced').closedCount).toBe(1);
    expect(audits()).toBe(1);
  });

  it('keeps a transient unpriceable lot open inside the 24h backstop', async () => {
    seedCandidate('cand_transient_price', 'transient_price', 'WalletTransientPrice');
    const h = harness(riskConfig());
    await h.svc.admit('cand_transient_price', readingFrom([buy('tp1', 60), buy('tp2', 30), buy('tp3', 10)]));
    const buySummary = swapSummary({
      signature: 'tp-b1',
      minutesAgo: 12 * 60,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
    });
    h.perAddress.set('WalletTransientPrice', {
      page: [{ signature: 'tp-b1', blockTime: NOW_SEC - 12 * 60 * 60 }],
      summaries: new Map([['tp-b1', buySummary]]),
    });
    await h.svc.tick();

    h.priceErrors.set(TOKEN, new Error('jupiter: rate limited (429)'));
    await h.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_transient_price')).toHaveLength(1);
    expect(repo.shadowAggregates(handle.db, 'cand_transient_price').closedCount).toBe(0);
  });

  it('closes a transient unpriceable lot only after grace + 24h', async () => {
    seedCandidate('cand_transient_backstop', 'transient_backstop', 'WalletTransientBackstop');
    const h = harness(riskConfig());
    await h.svc.admit(
      'cand_transient_backstop',
      readingFrom([buy('tb1', 60), buy('tb2', 30), buy('tb3', 10)]),
    );
    const buySummary = swapSummary({
      signature: 'tb-b1',
      minutesAgo: 36 * 60,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
    });
    h.perAddress.set('WalletTransientBackstop', {
      page: [{ signature: 'tb-b1', blockTime: NOW_SEC - 36 * 60 * 60 }],
      summaries: new Map([['tb-b1', buySummary]]),
    });
    await h.svc.tick();

    h.priceErrors.set(TOKEN, new Error('jupiter: HTTP 503'));
    await h.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_transient_backstop')).toHaveLength(0);
    expect(repo.shadowAggregates(handle.db, 'cand_transient_backstop').closedCount).toBe(1);
    expect(
      repo
        .listAudit(handle.db, 500)
        .some(
          (a) =>
            a.message.includes('no quote after 24h backstop') &&
            (a.dataJson ?? '').includes('cand_transient_backstop'),
        ),
    ).toBe(true);
  });
});

describe('WatchService — promotion, re-entry, eviction (AC6/AC7/AC8)', () => {
  /** Seed a closed shadow record directly: promotion reads the ledger, not the wire. */
  function seedRecord(candidateId: string, closed: number, pnlEach: bigint): void {
    for (let i = 0; i < closed; i++) {
      const id = repo.openShadowTrade(handle.db, {
        candidateId,
        mint: TOKEN,
        openedAt: iso(Date.now() - (closed - i) * HOUR),
        entryPriceUsdMicro: '1000000',
        notionalUsdMicro: '6000000',
      });
      repo.closeShadowTrade(handle.db, id, {
        closedAt: iso(Date.now() - (closed - i) * HOUR + 60_000),
        exitReason: 'leader_sell',
        exitPriceUsdMicro: '1000000',
        pnlUsdMicro: pnlEach.toString(),
      });
    }
  }

  it('counts an unpriceable close in closedCount and blocks on net', async () => {
    seedCandidate('cand_unpriced_promo', 'unpriced_promo', 'WalletUnpricedPromo');
    const h = harness(riskConfig());
    await h.svc.admit('cand_unpriced_promo', readingFrom([buy('up1', 60), buy('up2', 30), buy('up3', 10)]));
    recordBuys('cand_unpriced_promo', 'WalletUnpricedPromo', 1, 5);
    seedRecord('cand_unpriced_promo', 2, 2_000_000n); // +$4 from the good record
    repo.insertWatchEvent(handle.db, {
      candidateId: 'cand_unpriced_promo',
      address: 'WalletUnpricedPromo',
      signature: 'unpriced-promo-history',
      side: 'buy',
      mint: TOKEN,
      tokenAmountBase: '6000000',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: NOW_SEC - 12 * 3600,
      observedAt: iso(Date.now() - 12 * HOUR),
      source: 'test',
    });
    repo.openShadowTrade(handle.db, {
      candidateId: 'cand_unpriced_promo',
      mint: TOKEN,
      openedAt: iso(Date.now() - 12 * HOUR),
      entryPriceUsdMicro: '1000000',
      notionalUsdMicro: '6000000',
    });
    h.priceErrors.set(TOKEN, new PriceUnavailableError('no_route', 'no route'));

    await h.svc.tick();
    const aggregates = repo.shadowAggregates(handle.db, 'cand_unpriced_promo');
    expect(aggregates.closedCount).toBe(3);
    expect(aggregates.netPnlUsdMicro).toBe(-2_000_000n);
    expect(h.svc.promotionDecision('cand_unpriced_promo').reason).toBe('NET_BELOW_THRESHOLD');
  });

  it('benches a wallet when every gate passes and hands it to the lifecycle', async () => {
    seedCandidate('cand_promote', 'promotable', 'WalletPromote');
    const h = harness(riskConfig());
    await h.svc.admit('cand_promote', readingFrom([buy('p1', 60), buy('p2', 30), buy('p3', 5)]));
    recordBuys('cand_promote', 'WalletPromote', 1, 5); // the live "last funded buy" clock
    seedRecord('cand_promote', 3, 2_000_000n); // 3 closed, +$2 each

    const evaluation = await h.svc.evaluate();
    expect(evaluation.benched).toBe(1);
    expect(h.hired).toEqual(['cand_promote']);
    expect(repo.getWatchWallet(handle.db, 'cand_promote')?.status).toBe('bench');
    expect(repo.listAudit(handle.db, 10).some((a) => /benched: record passes/.test(a.message))).toBe(true);
  });

  it('pre-builds the bench while the roster is full: no chair is required to qualify', async () => {
    // The operator's bench rule: a qualifying wallet waits on the bench, so a
    // sudden firing is filled instantly instead of waiting for a watch sweep.
    seedCandidate('cand_bench_full', 'benchfull', 'WalletBenchFull');
    const h = harness(riskConfig({ ROSTER_SIZE: 1 }));
    await h.svc.admit('cand_bench_full', readingFrom([buy('f1', 60), buy('f2', 30), buy('f3', 5)]));
    recordBuys('cand_bench_full', 'WalletBenchFull', 1, 5);
    seedRecord('cand_bench_full', 3, 2_000_000n);

    await h.svc.tick();
    expect(repo.getWatchWallet(handle.db, 'cand_bench_full')?.status).toBe('bench');
  });

  it('blocks with the specific reason for each failing condition', async () => {
    seedCandidate('cand_blocked', 'blocked', 'WalletBlocked');
    const h = harness(riskConfig());
    await h.svc.admit('cand_blocked', readingFrom([buy('q1', 60), buy('q2', 30), buy('q3', 5)]));

    // Not enough sample.
    expect(h.svc.promotionDecision('cand_blocked').reason).toBe('FEWER_THAN_K_CLOSED');
    // A full sample that nets nothing: below the > $1 threshold.
    seedRecord('cand_blocked', 3, 0n);
    expect(h.svc.promotionDecision('cand_blocked').reason).toBe('NET_BELOW_THRESHOLD');

    // Enough net, but the last funded buy is too old.
    seedRecord('cand_blocked', 0, 0n);
    repo.setWatchStatus(handle.db, 'cand_blocked', 'watching', 'test');
    for (let i = 0; i < 3; i++) {
      const id = repo.openShadowTrade(handle.db, {
        candidateId: 'cand_blocked',
        mint: TOKEN,
        openedAt: iso(Date.now() - (i + 1) * HOUR),
        entryPriceUsdMicro: '1000000',
        notionalUsdMicro: '6000000',
      });
      repo.closeShadowTrade(handle.db, id, {
        closedAt: iso(Date.now() - (i + 1) * HOUR),
        exitReason: 'leader_sell',
        exitPriceUsdMicro: '1000000',
        pnlUsdMicro: '2000000',
      });
    }
    repo.insertWatchEvent(handle.db, {
      candidateId: 'cand_blocked',
      address: 'WalletBlocked',
      signature: 'old-buy',
      side: 'buy',
      mint: TOKEN,
      tokenAmountBase: '6000000',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: NOW_SEC - 10 * 3600,
      observedAt: iso(Date.now() - 10 * HOUR),
      source: 'test',
    });
    expect(h.svc.promotionDecision('cand_blocked').reason).toBe('LAST_BUY_TOO_OLD');

    // Fresh buy → the wallet is promotable. Capital is not part of the gate
    // (operator decision, 2026-11-03): no headroom figure is even consulted.
    repo.insertWatchEvent(handle.db, {
      candidateId: 'cand_blocked',
      address: 'WalletBlocked',
      signature: 'fresh-buy',
      side: 'buy',
      mint: TOKEN,
      tokenAmountBase: '6000000',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: NOW_SEC - 60,
      observedAt: iso(Date.now() - 60_000),
      source: 'test',
    });
    expect(h.svc.promotionDecision('cand_blocked')).toEqual({ ok: true, reason: null });
  });

  it('bench hygiene: a benched wallet with a negative full record is archived', async () => {
    seedCandidate('cand_bench_neg', 'benchneg', 'WalletBenchNeg');
    const h = harness(riskConfig());
    repo.upsertWatchWallet(handle.db, {
      candidateId: 'cand_bench_neg',
      address: 'WalletBenchNeg',
      status: 'bench',
      reason: 'test',
    });
    recordBuys('cand_bench_neg', 'WalletBenchNeg', 1, 5); // a fresh buy: only the net blocks
    seedRecord('cand_bench_neg', 3, -1_000_000n);

    await h.svc.tick();
    expect(repo.getWatchWallet(handle.db, 'cand_bench_neg')?.status).toBe('archived');
  });

  it('bench hygiene: a benched wallet whose last buy went stale returns to watching', async () => {
    seedCandidate('cand_bench_stale', 'benchstale', 'WalletBenchStale');
    const h = harness(riskConfig());
    repo.upsertWatchWallet(handle.db, {
      candidateId: 'cand_bench_stale',
      address: 'WalletBenchStale',
      status: 'bench',
      reason: 'test',
    });
    recordBuys('cand_bench_stale', 'WalletBenchStale', 1, 5 * 60); // 5 hours ago > 4h
    seedRecord('cand_bench_stale', 3, 2_000_000n);

    await h.svc.tick();
    expect(repo.getWatchWallet(handle.db, 'cand_bench_stale')?.status).toBe('watching');
    expect(repo.listAudit(handle.db, 20).some((a) => /bench demoted: LAST_BUY_TOO_OLD/.test(a.message))).toBe(
      true,
    );
  });

  it('re-entry: another trader hired after the firing lifts the block (AC7)', async () => {
    handle.sqlite.prepare('delete from trader_activations').run();
    seedCandidate('cand_reentry', 'reentry', 'WalletReentry');
    const h = harness(riskConfig());
    await h.svc.admit('cand_reentry', readingFrom([buy('r1', 60), buy('r2', 30), buy('r3', 5)]));
    recordBuys('cand_reentry', 'WalletReentry', 1, 5);
    seedRecord('cand_reentry', 3, 2_000_000n);
    const firedAt = iso(Date.now() - 60_000);
    repo.insertFiringEvent(handle.db, {
      activationId: 'act_old',
      candidateId: 'cand_reentry',
      reason: 'idle',
      lossStreak: 0,
      positionPolicy: 'keep_positions',
      firedAt,
      closeCompletedAt: null,
      handoffStatus: 'none',
    });
    repo.setWatchStatus(handle.db, 'cand_reentry', 'cooling', 'fired');

    expect(repo.hasHireSince(handle.db, firedAt, 'cand_reentry')).toBe(false);
    expect(h.svc.promotionDecision('cand_reentry').reason).toBe('REENTRY_BANNED');
    expect(await h.svc.coolingTick()).toBe(0);

    // Another trader is hired after the firing: the block lifts immediately,
    // even though the 3h window has not elapsed.
    repo.createActivation(handle.db, {
      activationId: 'act_other_hire',
      candidateId: 'cand_other_hire',
      state: 'ACTIVE',
      startedAt: iso(Date.now() - 30_000),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source: 'manual',
    });
    expect(repo.hasHireSince(handle.db, firedAt, 'cand_reentry')).toBe(true);
    expect(await h.svc.coolingTick()).toBe(1);
    expect(repo.getWatchWallet(handle.db, 'cand_reentry')?.status).toBe('watching');
    expect(h.svc.promotionDecision('cand_reentry').ok).toBe(true);
  });

  it('re-entry: the cooldown with a free chair returns a fired trader (AC7)', async () => {
    handle.sqlite.prepare('delete from trader_activations').run();
    seedCandidate('cand_reentry_timed', 'reentry_timed', 'WalletReentryTimed');
    const h = harness(riskConfig());
    await h.svc.admit('cand_reentry_timed', readingFrom([buy('t1', 60), buy('t2', 30), buy('t3', 5)]));
    recordBuys('cand_reentry_timed', 'WalletReentryTimed', 1, 5);
    seedRecord('cand_reentry_timed', 3, 2_000_000n);
    const firedAt = iso(Date.now() - 4 * HOUR);
    repo.insertFiringEvent(handle.db, {
      activationId: 'act_timed',
      candidateId: 'cand_reentry_timed',
      reason: 'idle',
      lossStreak: 0,
      positionPolicy: 'keep_positions',
      firedAt,
      closeCompletedAt: null,
      handoffStatus: 'none',
    });
    repo.setWatchStatus(handle.db, 'cand_reentry_timed', 'cooling', 'fired');
    expect(repo.hasHireSince(handle.db, firedAt, 'cand_reentry_timed')).toBe(false);
    expect(await h.svc.coolingTick()).toBe(1);
    expect(repo.getWatchWallet(handle.db, 'cand_reentry_timed')?.status).toBe('watching');
    expect(h.svc.promotionDecision('cand_reentry_timed').ok).toBe(true);
  });

  it('evicts a wallet with no funded buy for the eviction window (AC8)', async () => {
    seedCandidate('cand_stale', 'stale', 'WalletStale');
    const h = harness(riskConfig());
    await h.svc.admit('cand_stale', readingFrom([buy('s1', 60), buy('s2', 30), buy('s3', 5)]));
    // Age the funded-buy stamp beyond the window.
    handle.sqlite
      .prepare('update watch_wallets set last_funded_buy_at = ? where candidate_id = ?')
      .run(iso(Date.now() - 15 * 24 * HOUR), 'cand_stale');
    const evaluation = await h.svc.evaluate();
    expect(evaluation.archived).toBe(1);
    expect(repo.getWatchWallet(handle.db, 'cand_stale')?.status).toBe('archived');
    expect(repo.listAudit(handle.db, 30).some((a) => /watch archived/.test(a.message))).toBe(true);
  });

  it('demotes a negative record with a full sample', async () => {
    seedCandidate('cand_negative', 'negative', 'WalletNegative');
    const h = harness(riskConfig());
    await h.svc.admit('cand_negative', readingFrom([buy('x1', 60), buy('x2', 30), buy('x3', 5)]));
    seedRecord('cand_negative', 3, -2_000_000n);
    const evaluation = await h.svc.evaluate();
    expect(evaluation.demoted).toBe(1);
    expect(repo.getWatchWallet(handle.db, 'cand_negative')?.status).toBe('archived');
  });

  it('promoteNow refuses a blocked wallet and hires an eligible one', async () => {
    seedCandidate('cand_manual', 'manual', 'WalletManual');
    const h = harness(riskConfig());
    await h.svc.admit('cand_manual', readingFrom([buy('m1', 60), buy('m2', 30), buy('m3', 5)]));
    expect((await h.svc.promoteNow('cand_manual')).ok).toBe(false);
    recordBuys('cand_manual', 'WalletManual', 1, 5);
    seedRecord('cand_manual', 3, 2_000_000n);
    const promoted = await h.svc.promoteNow('cand_manual');
    expect(promoted).toEqual({ ok: true, reason: 'HIRED' });
    expect(h.hired).toContain('cand_manual');
  });
});

describe('WatchService — restart safety (AC10)', () => {
  it('cursors, events, lots and statuses survive a new service instance', async () => {
    seedCandidate('cand_restart', 'restarter', 'WalletRestart');
    const first = harness(riskConfig());
    await first.svc.admit('cand_restart', readingFrom([buy('z1', 60), buy('z2', 30), buy('z3', 5)]));
    first.summaries.set(
      'z-b1',
      swapSummary({ signature: 'z-b1', minutesAgo: 5, tokens: 6_000_000n, usd: 6_000_000n, side: 'buy' }),
    );
    first.page.unshift({ signature: 'z-b1', blockTime: NOW_SEC - 5 * 60 });
    await first.svc.tick();

    const cursor = repo.getWatchCursor(handle.db, 'WalletRestart');
    expect(cursor?.lastSignature).toBe('z-b1');
    const lotsBefore = repo.listOpenShadowTrades(handle.db, 'cand_restart');
    expect(lotsBefore).toHaveLength(1);

    // A fresh service instance (a restarted process) sees the same state and
    // does not replay the already-applied signature.
    const second = harness(riskConfig());
    second.summaries.set(
      'z-b1',
      swapSummary({ signature: 'z-b1', minutesAgo: 5, tokens: 6_000_000n, usd: 6_000_000n, side: 'buy' }),
    );
    second.page.unshift({ signature: 'z-b1', blockTime: NOW_SEC - 5 * 60 });
    await second.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_restart')).toHaveLength(1);
    expect(repo.getWatchWallet(handle.db, 'cand_restart')?.status).toBe('watching');
    expect(repo.listWatchEvents(handle.db, 'cand_restart')).toHaveLength(1);
  });
});

/**
 * The dashboard contract (AC11/AC12): the watch-list section carries the
 * status, ages, counts, PnL, exposure and the gate's blocked reason, all
 * labeled with the shadow-ledger source. Built through the real Runtime so the
 * builder wiring is what is measured.
 */
describe('watchlist dashboard state (AC11/AC12)', () => {
  it('exposes status, counts, net, open/ceiling exposure and the blocked reason', async () => {
    seedCandidate('cand_state_ok', 'stateful', 'WalletStateOk');
    seedCandidate('cand_state_blocked', 'blockedstate', 'WalletStateBlocked');
    const h = harness(riskConfig());
    await h.svc.admit('cand_state_ok', readingFrom([buy('so1', 60), buy('so2', 30), buy('so3', 5)]));
    await h.svc.admit('cand_state_blocked', readingFrom([buy('sb1', 60), buy('sb2', 30), buy('sb3', 5)]));
    recordBuys('cand_state_ok', 'WalletStateOk', 1, 5);
    // A three-trade closed record (the runtime's default K is 8, so this row
    // still reports a blocked reason — the numbers are what this test pins).
    for (let i = 0; i < 3; i++) {
      const id = repo.openShadowTrade(handle.db, {
        candidateId: 'cand_state_ok',
        mint: TOKEN,
        openedAt: iso(Date.now() - (i + 1) * HOUR),
        entryPriceUsdMicro: '1000000',
        notionalUsdMicro: '5000000',
      });
      repo.closeShadowTrade(handle.db, id, {
        closedAt: iso(Date.now() - (i + 1) * HOUR + 60_000),
        exitReason: 'leader_sell',
        exitPriceUsdMicro: '1000000',
        pnlUsdMicro: '2000000',
      });
    }
    // An open lot already past the RUNTIME's age ceiling (DEFAULT_RISK is 16h)
    // for the other row.
    repo.openShadowTrade(handle.db, {
      candidateId: 'cand_state_blocked',
      mint: TOKEN,
      openedAt: iso(Date.now() - 17 * HOUR),
      entryPriceUsdMicro: '1000000',
      notionalUsdMicro: '7000000',
    });

    const config = loadConfig({ SESSION_SECRET: 's'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
    config.env.DATA_DIR = dir;
    const rt = new Runtime(config);
    try {
      const state = rt.rebuildState();
      // Earlier tests in this file left their own watching rows behind.
      expect(state.watchlist.size).toBeGreaterThanOrEqual(2);
      expect(state.watchlist.rows.map((r) => r.candidateId)).toEqual(
        expect.arrayContaining(['cand_state_ok', 'cand_state_blocked']),
      );
      expect(state.watchlist.cap).toBe(config.risk.WATCH_LIST_SIZE);
      expect(state.watchlist.benchTarget).toBe(config.risk.BENCH_TARGET);
      expect(state.watchlist.nextDiscoveryReason).toBeTruthy();

      const ok = state.watchlist.rows.find((r) => r.candidateId === 'cand_state_ok')!;
      expect(ok.status).toBe('watching');
      expect(ok.source).toBe('SHADOW_LEDGER');
      expect(ok.closedTrades).toBe(3);
      expect(ok.netShadowPnlUsdMicro).toBe('6000000'); // 3 × +$2
      expect(ok.openNotionalUsdMicro).toBe('0');
      expect(ok.fundedBuys24h).toBeGreaterThanOrEqual(1);
      expect(ok.lastFundedBuyAt).toBeTruthy();
      expect(ok.blockedReason).toBe('FEWER_THAN_K_CLOSED'); // the runtime default K is 8

      const blocked = state.watchlist.rows.find((r) => r.candidateId === 'cand_state_blocked')!;
      expect(blocked.openNotionalUsdMicro).toBe('7000000');
      expect(blocked.ceilingExposureUsdMicro).toBe('7000000'); // past the 16h default ceiling
      expect(blocked.blockedReason).not.toBeNull();
    } finally {
      rt.stop();
    }
  });
});

/**
 * AC11's interactive half at the API layer (paper mode): the routes the panel's
 * buttons call really promote / archive / unarchive, and a refused promotion
 * carries the gate's reason.
 */
describe('watch list API (AC11)', () => {
  it('refuses, promotes, archives and unarchives through the real app', async () => {
    seedCandidate('cand_api', 'api_watch', 'WalletApi');
    const h = harness(riskConfig());
    await h.svc.admit('cand_api', readingFrom([buy('api1', 60), buy('api2', 30), buy('api3', 5)]));

    const config = loadConfig({ SESSION_SECRET: 'a'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
    config.env.DATA_DIR = dir;
    const rt = new Runtime(config);
    try {
      // The runtime's own watch service drives the routes; give it the same
      // stubbed stances by pointing lifecycle hires at an activation.
      const app = buildApp(rt);
      const token = rt.ensureSetupToken();
      const setup = await app.request('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          setupToken: token.value,
          username: 'watchuser',
          password: 'watch-password-1',
        }),
      });
      expect(setup.status).toBe(200);
      const cookies: Record<string, string> = {};
      for (const raw of (setup.headers.getSetCookie?.() ?? []) as string[]) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
      const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${cookies['zcode_csrf']}`;
      const csrf = cookies['zcode_csrf']!;
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify(body),
        });

      // No closed record yet → refused with the gate's reason.
      const refused = await post('/api/watch/promote', { candidateId: 'cand_api' });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/FEWER_THAN_K_CLOSED/);

      // Archive works and the status flips.
      expect((await post('/api/watch/archive', { candidateId: 'cand_api' })).status).toBe(200);
      expect(repo.getWatchWallet(handle.db, 'cand_api')?.status).toBe('archived');
      expect((await post('/api/watch/unarchive', { candidateId: 'cand_api' })).status).toBe(200);
      expect(repo.getWatchWallet(handle.db, 'cand_api')?.status).toBe('watching');

      // Unknown wallets are refused explicitly.
      expect((await post('/api/watch/archive', { candidateId: 'nope' })).status).toBe(404);

      // A full record + a fresh buy promotes through the route (the runtime's
      // default gate: K=8, net > $3, last buy ≤ 4h).
      const candidateId = 'cand_api';
      for (let i = 0; i < 8; i++) {
        const id = repo.openShadowTrade(handle.db, {
          candidateId,
          mint: TOKEN,
          openedAt: iso(Date.now() - (i + 1) * HOUR),
          entryPriceUsdMicro: '1000000',
          notionalUsdMicro: '5000000',
        });
        repo.closeShadowTrade(handle.db, id, {
          closedAt: iso(Date.now() - (i + 1) * HOUR + 60_000),
          exitReason: 'leader_sell',
          exitPriceUsdMicro: '1000000',
          pnlUsdMicro: '2000000',
        });
      }
      recordBuys(candidateId, 'WalletApi', 1, 5);
      const promoted = await post('/api/watch/promote', { candidateId });
      expect(promoted.status).toBe(200);
      const body = (await promoted.json()) as { ok: boolean; outcome: string };
      expect(body.ok).toBe(true);
      expect(body.outcome).toBe('HIRED'); // activate() takes the free single chair
      expect(repo.getWatchWallet(handle.db, candidateId)?.status).toBe('hired');
      expect(repo.activeActivationCount(handle.db)).toBe(1);
      expect(repo.listAudit(handle.db, 10).some((a) => /watch hired into the roster/.test(a.message))).toBe(
        true,
      );
    } finally {
      rt.stop();
    }
  });
});

/** Plan 05 API addressing: the roster names a chair, and a seated candidate is refused. */
describe('roster API addressing (AC11)', () => {
  it('refuses an ambiguous fire, fires a named chair, and refuses a duplicate activation', async () => {
    const config = loadConfig({ SESSION_SECRET: 'z'.repeat(48), DATA_DIR: dir, MODE: 'paper' });
    config.env.DATA_DIR = dir;
    const rt = new Runtime(config);
    try {
      const app = buildApp(rt);
      // The earlier API test shares this DB and may have created the user
      // already — `ensureSetupToken()` refuses once setup is complete.
      let auth: Response;
      if (repo.countUsers(rt.db.db) === 0) {
        const token = rt.ensureSetupToken();
        auth = await app.request('/api/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            setupToken: token.value,
            username: 'chairuser',
            password: 'chair-password-1',
          }),
        });
      } else {
        auth = await app.request('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'watchuser', password: 'watch-password-1' }),
        });
      }
      expect(auth.ok).toBe(true);
      const setup = auth;
      const cookies: Record<string, string> = {};
      for (const raw of (setup.headers.getSetCookie?.() ?? []) as string[]) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
      const cookie = `zcode_session=${cookies['zcode_session']}; zcode_csrf=${cookies['zcode_csrf']}`;
      const csrf = cookies['zcode_csrf']!;
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify(body),
        });

      // Two chairs, so a bare fire is ambiguous. They are seated directly: the
      // dashboard's manual activate runs the day-trader pre-hire gate, which is
      // not this test's subject.
      seedCandidate('cand_amb_a', 'amb_a', 'WalletAmbA');
      seedCandidate('cand_amb_b', 'amb_b', 'WalletAmbB');
      for (const [activationId, candidateId] of [
        ['act_amb_a', 'cand_amb_a'],
        ['act_amb_b', 'cand_amb_b'],
      ] as const) {
        repo.createActivation(handle.db, {
          activationId,
          candidateId,
          state: 'ACTIVE',
          startedAt: new Date().toISOString(),
          endedAt: null,
          endReason: null,
          lossStreak: 0,
          firedReason: null,
          source: 'test',
        });
      }
      const bare = await post('/api/fire', {});
      expect(bare.status).toBe(400);
      expect(((await bare.json()) as { error: string }).error).toMatch(/specify activationId or candidateId/);

      // A named chair fires; a candidate already seated is refused.
      const named = await post('/api/fire', { candidateId: 'cand_amb_b' });
      expect(named.status).toBe(200);
      const duplicate = await post('/api/activate', { candidateId: 'cand_amb_a' });
      expect(duplicate.status).toBe(409);
      expect(((await duplicate.json()) as { error: string }).error).toMatch(/already holds a roster chair/);
    } finally {
      rt.stop();
    }
  });
});

/**
 * The admission scan is bounded to a few wallets per tick, so it has to advance
 * through the pool: it takes whoever has gone longest without a reading. A
 * head-of-the-list slice re-scans the same rows forever and starves every wallet
 * behind them. The live pool stalled exactly this way, with three no-buy wallets
 * at the head and seventeen eligible ones behind them never looked at.
 */
describe('admission scan rotation', () => {
  it('walks past a head of dead wallets to reach a qualifying one', async () => {
    seedCandidate('cand_rot_a', 'rot_a', 'WalletRotA');
    seedCandidate('cand_rot_b', 'rot_b', 'WalletRotB');
    seedCandidate('cand_rot_c', 'rot_c', 'WalletRotC');
    seedCandidate('cand_rot_good', 'rot_good', 'WalletRotGood');

    // Everything in the pool reads as measured now, so the scan order is exactly
    // the three dead wallets (4 days stale), then the good one (3 days stale).
    const stamp = (candidateId: string, hoursAgo: number) =>
      repo.updateCandidateActivity(handle.db, candidateId, {
        swaps24h: 0,
        lastSwapAt: null,
        lastBuyAt: null,
        buys24h: 0,
        sells24h: 0,
        status: 'ok' as const,
        checkedAt: iso(Date.now() - hoursAgo * HOUR),
      });
    for (const c of repo.listCandidates(handle.db)) stamp(c.candidateId, 0);
    for (const id of ['cand_rot_a', 'cand_rot_b', 'cand_rot_c']) stamp(id, 96);
    stamp('cand_rot_good', 72);

    // The wallet behind the dead head bought three times inside the last day.
    const h = harness(riskConfig());
    const summaries = new Map<string, LeaderTxSummary>();
    const page: Array<{ signature: string; blockTime: number | null }> = [];
    for (const [signature, minutesAgo] of [
      ['rot_buy_1', 120],
      ['rot_buy_2', 90],
      ['rot_buy_3', 30],
    ] as Array<[string, number]>) {
      const summary = swapSummary({
        signature,
        minutesAgo,
        tokens: 6_000_000n,
        usd: 6_000_000n,
        side: 'buy',
      });
      summaries.set(signature, summary);
      page.push({ signature, blockTime: summary.blockTime });
    }
    h.perAddress.set('WalletRotGood', { page, summaries });

    // One admission scan per tick: the three stalest wallets are the dead ones.
    // The good wallet is behind them and stays off the list for three ticks.
    await h.svc.tick();
    await h.svc.tick();
    await h.svc.tick();
    expect(repo.getWatchWallet(handle.db, 'cand_rot_good')).toBeUndefined();

    // The fourth tick has nothing staler than the good wallet, so it is scanned,
    // its reading is recorded, and it is admitted.
    await h.svc.tick();
    expect(repo.getWatchWallet(handle.db, 'cand_rot_good')?.status).toBe('watching');
    expect(repo.getCandidate(handle.db, 'cand_rot_good')?.buys24h).toBe(3);
  });

  it('does not let a recently checked head row consume the only scan slot', async () => {
    seedCandidate('cand_fresh_head', 'fresh_head', 'WalletFreshHead');
    seedCandidate('cand_stale_head', 'stale_head', 'WalletStaleHead');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_fresh_head', {
      swaps24h: 5,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 5,
      sells24h: 0,
      checkedAt: iso(Date.now()),
    });
    setActivity('cand_stale_head', { checkedAt: iso(Date.now() - 96 * HOUR) });

    // The fresh row has priority but is excluded by the SQL freshness cutoff;
    // the stale row takes the only slot instead of being skipped behind it.
    await h.svc.evaluate();
    expect(h.signatureCalls.get('WalletFreshHead')).toBeUndefined();
    expect(h.signatureCalls.get('WalletStaleHead')).toBe(1);
    expect(repo.getCandidate(handle.db, 'cand_stale_head')?.activityCheckStatus).toBe('ok');
  });
});

/**
 * The admission scan must never turn a failed provider read into a successful
 * empty reading: that overwrote good activity columns with zeros and dropped
 * the candidate out of the queue. A successful empty read must still advance.
 */
describe('admission scan fail-closed', () => {
  it('preserves the previous reading when the signature page fails everywhere', async () => {
    seedCandidate('cand_fail_closed', 'fail_closed', 'WalletFailClosed');
    const h = harness(riskConfig(), { heliusPageFailures: ['WalletFailClosed'] });
    // Production shape: the tolerant Helius method returns [] on failure; the
    // strict method used by admission throws, which must mark the check failed.
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_fail_closed', {
      swaps24h: 9,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 4,
      sells24h: 5,
      checkedAt: oldAt,
    });

    const result = await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_fail_closed')!;
    expect(candidate.activityCheckStatus).toBe('failed');
    expect(candidate.swaps24h).toBe(9);
    expect(candidate.buys24h).toBe(4);
    expect(candidate.sells24h).toBe(5);
    expect(candidate.lastBuyAt).toBe(lastBuy);
    expect(candidate.activityCheckedAt).toBe(oldAt);
    expect(repo.getWatchWallet(handle.db, 'cand_fail_closed')).toBeUndefined();
    expect(result.admitted).toBe(0);
    expect(
      repo
        .listAudit(handle.db, 50)
        .some((row) => row.message.includes('admission scan failed for fail_closed')),
    ).toBe(true);
  });

  it('falls back to Helius for the page and details when the public RPC fails', async () => {
    seedCandidate('cand_fallback', 'fallback', 'WalletFallback');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 2, WATCH_LIST_SIZE: 100 }), {
      publicConfigured: true,
      publicPageFails: true,
      publicDetailFails: true,
    });
    stampAllActivity();
    setActivity('cand_fallback', { checkedAt: iso(Date.now() - 96 * HOUR) });

    const page: Array<{ signature: string; blockTime: number | null }> = [];
    const summaries = new Map<string, LeaderTxSummary>();
    for (const [signature, minutesAgo] of [
      ['fallback_buy_1', 120],
      ['fallback_buy_2', 30],
    ] as Array<[string, number]>) {
      const summary = swapSummary({
        signature,
        minutesAgo,
        tokens: 6_000_000n,
        usd: 6_000_000n,
        side: 'buy',
      });
      summaries.set(signature, summary);
      page.push({ signature, blockTime: summary.blockTime });
    }
    h.perAddress.set('WalletFallback', { page, summaries });

    const result = await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_fallback')!;
    expect(candidate.activityCheckStatus).toBe('ok');
    expect(candidate.buys24h).toBe(2);
    expect(candidate.swaps24h).toBe(2);
    expect(candidate.lastBuyAt).not.toBeNull();
    expect(repo.getWatchWallet(handle.db, 'cand_fallback')?.status).toBe('watching');
    expect(result.admitted).toBe(1);
  });

  it('does not record a partial detail scan as an ok reading', async () => {
    seedCandidate('cand_detail_deferred', 'detail_deferred', 'WalletDetailDeferred');
    const h = harness(riskConfig({ WATCH_DETAIL_PER_MINUTE: 2 }), {
      publicConfigured: true,
      publicDetailFails: true,
    });
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_detail_deferred', {
      swaps24h: 7,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 3,
      sells24h: 4,
      checkedAt: oldAt,
    });

    // Three rows with a two-detail per-pass budget: the first two paid reads are
    // allowed, then the third is deferred. The scan must fail rather than
    // return the two completed reads as a complete reading.
    for (let i = 1; i <= 3; i++) {
      h.page.push({ signature: `detail_${i}`, blockTime: NOW_SEC - i * 60 });
    }

    await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_detail_deferred')!;
    expect(candidate.activityCheckStatus).toBe('failed');
    expect(candidate.buys24h).toBe(3);
    expect(candidate.swaps24h).toBe(7);
    expect(candidate.lastBuyAt).toBe(lastBuy);
    expect(candidate.activityCheckedAt).toBe(oldAt);
    expect(repo.getWatchWallet(handle.db, 'cand_detail_deferred')).toBeUndefined();
  });

  it('records a successful empty read as ok and advances the queue', async () => {
    seedCandidate('cand_empty_ok', 'empty_ok', 'WalletEmptyOk');
    const h = harness(riskConfig());
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    setActivity('cand_empty_ok', {
      swaps24h: 5,
      lastSwapAt: iso(Date.now() - HOUR),
      lastBuyAt: iso(Date.now() - HOUR),
      buys24h: 2,
      sells24h: 3,
      checkedAt: oldAt,
    });

    const result = await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_empty_ok')!;
    expect(candidate.activityCheckStatus).toBe('ok');
    expect(candidate.swaps24h).toBe(0);
    expect(candidate.buys24h).toBe(0);
    expect(candidate.sells24h).toBe(0);
    expect(candidate.lastSwapAt).toBeNull();
    expect(candidate.lastBuyAt).toBeNull();
    expect(candidate.activityCheckedAt).not.toBe(oldAt);
    expect(Date.parse(candidate.activityCheckedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(repo.getWatchWallet(handle.db, 'cand_empty_ok')).toBeUndefined();
    expect(result.admitted).toBe(0);
  });

  it('admits a truncated complete window when the newest 12 prove the gate', async () => {
    seedCandidate('cand_trunc_ok', 'trunc_ok', 'WalletTruncOk');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    setActivity('cand_trunc_ok', { checkedAt: iso(Date.now() - 96 * HOUR) });

    // 40 in-window rows: the bounded prefix covers the three buys at 0/5/10.
    const buyIndexes = new Set([0, 5, 10]);
    for (let i = 0; i < 40; i++) {
      const signature = `trunc_ok_${i}`;
      h.page.push({ signature, blockTime: NOW_SEC - (i + 1) * 60 });
      if (buyIndexes.has(i)) {
        h.summaries.set(
          signature,
          swapSummary({
            signature,
            minutesAgo: i + 1,
            tokens: 6_000_000n,
            usd: 6_000_000n,
            side: 'buy',
          }),
        );
      }
    }

    const result = await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_trunc_ok')!;
    expect(candidate.activityCheckStatus).toBe('partial');
    expect(candidate.buys24h).toBe(3);
    expect(repo.getWatchWallet(handle.db, 'cand_trunc_ok')?.status).toBe('watching');
    expect(result.admitted).toBe(1);
    expect(h.heliusDetailCalls.get('WalletTruncOk')).toBe(12);
  });

  it('defers a truncated complete window whose buys fall outside the newest 12', async () => {
    seedCandidate('cand_trunc_defer', 'trunc_defer', 'WalletTruncDefer');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_trunc_defer', {
      swaps24h: 8,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 4,
      sells24h: 4,
      checkedAt: oldAt,
    });

    // The buys are at 20/25/30; the newest-12 prefix cannot see them.
    const buyIndexes = new Set([20, 25, 30]);
    for (let i = 0; i < 40; i++) {
      const signature = `trunc_defer_${i}`;
      h.page.push({ signature, blockTime: NOW_SEC - (i + 1) * 60 });
      if (buyIndexes.has(i)) {
        h.summaries.set(
          signature,
          swapSummary({
            signature,
            minutesAgo: i + 1,
            tokens: 6_000_000n,
            usd: 6_000_000n,
            side: 'buy',
          }),
        );
      }
    }

    await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_trunc_defer')!;
    expect(candidate.activityCheckStatus).toBe('failed');
    expect(candidate.buys24h).toBe(4);
    expect(candidate.swaps24h).toBe(8);
    expect(candidate.lastBuyAt).toBe(lastBuy);
    expect(candidate.activityCheckedAt).toBe(oldAt);
    expect(repo.getWatchWallet(handle.db, 'cand_trunc_defer')).toBeUndefined();
    const deferredUntil = repo.kvGet(handle.db, repo.admissionDeferKey('cand_trunc_defer'));
    expect(deferredUntil).toBeDefined();
    expect(Date.parse(deferredUntil!)).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(h.heliusDetailCalls.get('WalletTruncDefer')).toBe(12);
  });

  it('records a complete window of exactly the detail budget as ok', async () => {
    seedCandidate('cand_exact_12', 'exact_12', 'WalletExact12');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    setActivity('cand_exact_12', { checkedAt: iso(Date.now() - 96 * HOUR) });

    const buyIndexes = new Set([0, 5, 10]);
    for (let i = 0; i < 12; i++) {
      const signature = `exact_12_${i}`;
      h.page.push({ signature, blockTime: NOW_SEC - (i + 1) * 60 });
      if (buyIndexes.has(i)) {
        h.summaries.set(
          signature,
          swapSummary({
            signature,
            minutesAgo: i + 1,
            tokens: 6_000_000n,
            usd: 6_000_000n,
            side: 'buy',
          }),
        );
      }
    }

    const result = await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_exact_12')!;
    expect(candidate.activityCheckStatus).toBe('ok');
    expect(candidate.buys24h).toBe(3);
    expect(repo.getWatchWallet(handle.db, 'cand_exact_12')?.status).toBe('watching');
    expect(result.admitted).toBe(1);
    expect(h.heliusDetailCalls.get('WalletExact12')).toBe(12);
  });

  it('caps a single admission scan at 12 detail reads', async () => {
    seedCandidate('cand_budget_cap', 'budget_cap', 'WalletBudgetCap');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    setActivity('cand_budget_cap', { checkedAt: iso(Date.now() - 96 * HOUR) });
    for (let i = 0; i < 40; i++) {
      h.page.push({ signature: `budget_cap_${i}`, blockTime: NOW_SEC - (i + 1) * 60 });
    }

    await h.svc.evaluate();
    expect(h.heliusDetailCalls.get('WalletBudgetCap')).toBe(12);
    expect(repo.getCandidate(handle.db, 'cand_budget_cap')?.activityCheckStatus).toBe('failed');
  });

  it('admits a busy wallet when its bounded prefix proves the gate', async () => {
    seedCandidate('cand_over_cap', 'over_cap', 'WalletOverCap');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_over_cap', {
      swaps24h: 8,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 4,
      sells24h: 4,
      checkedAt: oldAt,
    });

    // 101 signatures, all inside 24h. The full window no longer has to fit the
    // detail cap: the newest 12 are classified, and three buys there prove the
    // D4 gate. The reading is recorded as `partial`, never as an ok census.
    const buys = new Set([0, 5, 10]);
    for (let i = 0; i < 101; i++) {
      const signature = `over_cap_${i}`;
      h.page.push({ signature, blockTime: NOW_SEC - (i + 1) * 60 });
      if (buys.has(i)) {
        h.summaries.set(
          signature,
          swapSummary({
            signature,
            minutesAgo: i + 1,
            tokens: 6_000_000n,
            usd: 6_000_000n,
            side: 'buy',
          }),
        );
      }
    }

    const result = await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_over_cap')!;
    expect(candidate.activityCheckStatus).toBe('partial');
    expect(candidate.buys24h).toBe(3);
    expect(candidate.activityCheckedAt).not.toBe(oldAt);
    expect(repo.getWatchWallet(handle.db, 'cand_over_cap')?.status).toBe('watching');
    expect(result.admitted).toBe(1);
    expect(repo.kvGet(handle.db, repo.admissionDeferKey('cand_over_cap'))).toBeUndefined();
  });

  it('admits a >300-signature wallet from a prefix without claiming coverage', async () => {
    seedCandidate('cand_hyper', 'hyper', 'WalletHyper');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    setActivity('cand_hyper', { checkedAt: iso(Date.now() - 96 * HOUR) });

    // Three full pages still inside 24h: coverage is unprovable, but the
    // newest prefix is enough to prove the gate.
    for (let i = 0; i < 350; i++) {
      const signature = `hyper_${i}`;
      h.page.push({ signature, blockTime: NOW_SEC - (i + 1) * 30 });
      if (i < 3) {
        h.summaries.set(
          signature,
          swapSummary({
            signature,
            minutesAgo: (i + 1) * 0.5,
            tokens: 6_000_000n,
            usd: 6_000_000n,
            side: 'buy',
          }),
        );
      }
    }

    const result = await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_hyper')!;
    expect(candidate.activityCheckStatus).toBe('partial');
    expect(candidate.buys24h).toBe(3);
    expect(repo.getWatchWallet(handle.db, 'cand_hyper')?.status).toBe('watching');
    expect(result.admitted).toBe(1);
  });

  it('defers a busy wallet whose prefix cannot prove the gate and keeps the old census', async () => {
    seedCandidate('cand_over_cap_neg', 'over_cap_neg', 'WalletOverCapNeg');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_over_cap_neg', {
      swaps24h: 8,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 4,
      sells24h: 4,
      checkedAt: oldAt,
    });
    for (let i = 0; i < 101; i++) {
      h.page.push({ signature: `over_neg_${i}`, blockTime: NOW_SEC - (i + 1) * 60 });
    }

    await h.svc.evaluate();
    const candidate = repo.getCandidate(handle.db, 'cand_over_cap_neg')!;
    expect(candidate.activityCheckStatus).toBe('failed');
    expect(candidate.buys24h).toBe(4);
    expect(candidate.swaps24h).toBe(8);
    expect(candidate.lastBuyAt).toBe(lastBuy);
    expect(candidate.activityCheckedAt).toBe(oldAt);
    expect(repo.getWatchWallet(handle.db, 'cand_over_cap_neg')).toBeUndefined();
    const deferredUntil = repo.kvGet(handle.db, repo.admissionDeferKey('cand_over_cap_neg'));
    expect(deferredUntil).toBeDefined();
    expect(Date.parse(deferredUntil!)).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it('does not rescan a deferred prefix every tick, then retries after the window', async () => {
    seedCandidate('cand_overflow', 'overflow', 'WalletOverflow');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_overflow', {
      swaps24h: 9,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 4,
      sells24h: 5,
      checkedAt: oldAt,
    });
    for (let i = 0; i < 101; i++) {
      h.page.push({ signature: `overflow_${i}`, blockTime: NOW_SEC - (i + 1) * 60 });
    }

    await h.svc.evaluate();
    const firstCalls = h.signatureCalls.get('WalletOverflow') ?? 0;
    expect(firstCalls).toBe(2); // 100 + the one remaining in-window page
    expect(repo.getCandidate(handle.db, 'cand_overflow')?.activityCheckStatus).toBe('failed');
    const auditCount = () =>
      repo.listAudit(handle.db, 200).filter((row) => row.message.includes('admission prefix for overflow'))
        .length;
    expect(auditCount()).toBe(1);

    // The deferral is an eligibility signal, not a reading: the next tick must
    // not spend another page on this candidate or write another audit row.
    await h.svc.evaluate();
    expect(h.signatureCalls.get('WalletOverflow')).toBe(firstCalls);
    expect(auditCount()).toBe(1);

    // Simulate the 30-minute window passing, with a now-successful empty page.
    repo.deferCandidateActivity(handle.db, 'cand_overflow', iso(Date.now() - 1_000), iso(Date.now()));
    h.page.length = 0;
    await h.svc.evaluate();
    const after = repo.getCandidate(handle.db, 'cand_overflow')!;
    expect(after.activityCheckStatus).toBe('ok');
    expect(after.activityCheckedAt).not.toBe(oldAt);
    expect(after.buys24h).toBe(0);
    expect(repo.kvGet(handle.db, repo.admissionDeferKey('cand_overflow'))).toBeUndefined();
    expect(h.signatureCalls.get('WalletOverflow')).toBeGreaterThan(firstCalls);
  });

  it('keeps a transient signature-page failure on the retry-next-tick path', async () => {
    seedCandidate('cand_transient', 'transient', 'WalletTransient');
    const h = harness(riskConfig(), { heliusPageFailures: ['WalletTransient'] });
    stampAllActivity();
    const oldAt = iso(Date.now() - 96 * HOUR);
    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_transient', {
      swaps24h: 6,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 3,
      sells24h: 3,
      checkedAt: oldAt,
    });

    await h.svc.evaluate();
    expect(h.signatureCalls.get('WalletTransient')).toBe(1);
    expect(repo.getCandidate(handle.db, 'cand_transient')?.activityCheckStatus).toBe('failed');
    expect(repo.kvGet(handle.db, repo.admissionDeferKey('cand_transient'))).toBeUndefined();

    await h.svc.evaluate();
    expect(h.signatureCalls.get('WalletTransient')).toBe(2);
    expect(repo.getCandidate(handle.db, 'cand_transient')?.activityCheckStatus).toBe('failed');
  });

  it('defers a spent detail budget briefly so one candidate cannot starve the queue', async () => {
    seedCandidate('cand_ceil1', 'ceil1', 'WalletCeil1');
    seedCandidate('cand_ceil2', 'ceil2', 'WalletCeil2');
    const h = harness(
      riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100, WATCH_DETAIL_PER_MINUTE: 2 }),
    );
    stampAllActivity();
    const lastBuy = iso(Date.now() - HOUR);
    const oldAt = iso(Date.now() - 96 * HOUR);
    for (const candidate of [
      ['cand_ceil1', 'WalletCeil1'],
      ['cand_ceil2', 'WalletCeil2'],
    ] as Array<[string, string]>) {
      setActivity(candidate[0], {
        swaps24h: 5,
        lastSwapAt: lastBuy,
        lastBuyAt: lastBuy,
        buys24h: 5,
        sells24h: 0,
        checkedAt: oldAt,
      });
      h.perAddress.set(candidate[1], {
        page: Array.from({ length: 5 }, (_, i) => ({
          signature: `${candidate[0]}_${i}`,
          blockTime: NOW_SEC - (i + 1) * 60,
        })),
        summaries: new Map(),
      });
    }

    // One candidate per evaluate: the first spends the two-detail budget and
    // defers; the next evaluate scans the other candidate with a fresh budget.
    await h.svc.evaluate();
    await h.svc.evaluate();
    const auditCount = () =>
      repo
        .listAudit(handle.db, 200)
        .filter((row) => row.message.includes('watch detail deferred (admission budget)')).length;
    for (const id of ['cand_ceil1', 'cand_ceil2']) {
      expect(repo.getCandidate(handle.db, id)?.activityCheckStatus).toBe('failed');
      const until = repo.kvGet(handle.db, repo.admissionDeferKey(id));
      expect(until).toBeDefined();
      expect(Date.parse(until!)).toBeGreaterThan(Date.now() + 5 * 60_000);
    }
    expect(auditCount()).toBeGreaterThanOrEqual(2);
    const calls = (h.signatureCalls.get('WalletCeil1') ?? 0) + (h.signatureCalls.get('WalletCeil2') ?? 0);

    // The deferral key keeps both out of the next scan, so the queue advances.
    await h.svc.evaluate();
    expect((h.signatureCalls.get('WalletCeil1') ?? 0) + (h.signatureCalls.get('WalletCeil2') ?? 0)).toBe(
      calls,
    );
  });

  it('advances the next admission candidates after a partial prefix defers', async () => {
    seedCandidate('cand_slot_overflow', 'slot_overflow', 'WalletSlotOverflow');
    seedCandidate('cand_slot_good1', 'slot_good1', 'WalletSlotGood1');
    seedCandidate('cand_slot_good2', 'slot_good2', 'WalletSlotGood2');
    const h = harness(riskConfig({ ADMISSION_MIN_BUYS_24H: 3, WATCH_LIST_SIZE: 100 }));
    stampAllActivity();

    const lastBuy = iso(Date.now() - HOUR);
    setActivity('cand_slot_overflow', {
      swaps24h: 9,
      lastSwapAt: lastBuy,
      lastBuyAt: lastBuy,
      buys24h: 4,
      sells24h: 5,
      checkedAt: iso(Date.now() - 96 * HOUR),
    });
    setActivity('cand_slot_good1', { checkedAt: iso(Date.now() - 95 * HOUR) });
    setActivity('cand_slot_good2', { checkedAt: iso(Date.now() - 94 * HOUR) });

    for (let i = 0; i < 101; i++) {
      h.page.push({ signature: `slot_over_${i}`, blockTime: NOW_SEC - (i + 1) * 60 });
    }
    for (const [candidate, address] of [
      ['cand_slot_good1', 'WalletSlotGood1'],
      ['cand_slot_good2', 'WalletSlotGood2'],
    ] as Array<[string, string]>) {
      const goodPage: Array<{ signature: string; blockTime: number | null }> = [];
      const goodSummaries = new Map<string, LeaderTxSummary>();
      for (let i = 0; i < 3; i++) {
        const signature = `${candidate}_buy_${i}`;
        const summary = swapSummary({
          signature,
          minutesAgo: 120 - i * 30,
          tokens: 6_000_000n,
          usd: 6_000_000n,
          side: 'buy',
        });
        goodSummaries.set(signature, summary);
        goodPage.push({ signature, blockTime: summary.blockTime });
      }
      h.perAddress.set(address, { page: goodPage, summaries: goodSummaries });
    }

    // One candidate per tick: the overflow defers, then the two good wallets
    // take the following ticks with a fresh per-pass budget each.
    let admitted = 0;
    admitted += (await h.svc.evaluate()).admitted;
    admitted += (await h.svc.evaluate()).admitted;
    admitted += (await h.svc.evaluate()).admitted;
    expect(repo.getCandidate(handle.db, 'cand_slot_overflow')?.activityCheckStatus).toBe('failed');
    expect(repo.getWatchWallet(handle.db, 'cand_slot_good1')?.status).toBe('watching');
    expect(repo.getWatchWallet(handle.db, 'cand_slot_good2')?.status).toBe('watching');
    expect(repo.getCandidate(handle.db, 'cand_slot_good1')?.activityCheckStatus).toBe('ok');
    expect(repo.getCandidate(handle.db, 'cand_slot_good2')?.activityCheckStatus).toBe('ok');
    expect(admitted).toBe(2);
  });
});

describe('watch-list detail fallback policy', () => {
  it('keeps an idle watcher public-only when the public detail read fails', async () => {
    seedWatching('cand_valve_idle', 'valve_idle', 'WalletValveIdle');
    const h = harness(riskConfig(), { publicConfigured: true, publicDetailFails: true });
    const page = [{ signature: 'idle_new', blockTime: NOW_SEC - 30 }];
    const summaries = new Map<string, LeaderTxSummary>([
      [
        'idle_new',
        swapSummary({
          signature: 'idle_new',
          minutesAgo: 0.5,
          tokens: 6_000_000n,
          usd: 6_000_000n,
          side: 'buy',
        }),
      ],
    ]);
    h.perAddress.set('WalletValveIdle', { page, summaries });

    await h.svc.tick();
    expect(h.heliusDetailCalls.get('WalletValveIdle') ?? 0).toBe(0);
    expect(repo.listWatchEvents(handle.db, 'cand_valve_idle')).toHaveLength(0);
    expect(repo.getWatchCursor(handle.db, 'WalletValveIdle')?.lastSignature).toBe('');
  });

  it('uses the bounded valve for a wallet with an open shadow position', async () => {
    seedWatching('cand_valve_open', 'valve_open', 'WalletValveOpen');
    repo.openShadowTrade(handle.db, {
      candidateId: 'cand_valve_open',
      mint: 'ValveOpenMint1111111111111111111111111111',
      openedAt: iso(Date.now() - 10 * 60_000),
      entryPriceUsdMicro: '1000000',
      notionalUsdMicro: '5000000',
    });
    const h = harness(riskConfig(), { publicConfigured: true, publicDetailFails: true });
    const summary = swapSummary({
      signature: 'open_new_buy',
      minutesAgo: 0.5,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
      mint: 'ValveNewMint11111111111111111111111111111',
    });
    h.perAddress.set('WalletValveOpen', {
      page: [{ signature: summary.signature, blockTime: summary.blockTime }],
      summaries: new Map([[summary.signature, summary]]),
    });

    await h.svc.tick();
    expect(h.heliusDetailCalls.get('WalletValveOpen')).toBe(1);
    expect(repo.listWatchEvents(handle.db, 'cand_valve_open')).toHaveLength(1);
    expect(repo.getWatchCursor(handle.db, 'WalletValveOpen')?.lastSignature).toBe('open_new_buy');
  });

  it('allows the valve for a recently funded watcher without an open lot', async () => {
    seedWatching('cand_valve_recent', 'valve_recent', 'WalletValveRecent');
    repo.insertWatchEvent(handle.db, {
      candidateId: 'cand_valve_recent',
      address: 'WalletValveRecent',
      signature: 'recent_seed_buy',
      side: 'buy',
      mint: 'ValveSeedMint111111111111111111111111111111',
      tokenAmountBase: '6000000',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: NOW_SEC - 120,
      observedAt: iso(Date.now() - 60_000),
      source: 'test',
    });
    const h = harness(riskConfig(), { publicConfigured: true, publicDetailFails: true });
    const summary = swapSummary({
      signature: 'recent_new_buy',
      minutesAgo: 0.5,
      tokens: 6_000_000n,
      usd: 6_000_000n,
      side: 'buy',
      mint: 'ValveRecentMint1111111111111111111111111111',
    });
    h.perAddress.set('WalletValveRecent', {
      page: [{ signature: summary.signature, blockTime: summary.blockTime }],
      summaries: new Map([[summary.signature, summary]]),
    });

    await h.svc.tick();
    expect(h.heliusDetailCalls.get('WalletValveRecent')).toBe(1);
    expect(repo.getWatchCursor(handle.db, 'WalletValveRecent')?.lastSignature).toBe('recent_new_buy');
  });

  it('caps the paid fallback and leaves the rest of the page for the next tick', async () => {
    seedWatching('cand_valve_cap', 'valve_cap', 'WalletValveCap');
    repo.openShadowTrade(handle.db, {
      candidateId: 'cand_valve_cap',
      mint: 'ValveCapMint111111111111111111111111111111',
      openedAt: iso(Date.now() - 10 * 60_000),
      entryPriceUsdMicro: '1000000',
      notionalUsdMicro: '5000000',
    });
    const h = harness(riskConfig(), { publicConfigured: true, publicDetailFails: true });
    const page: Array<{ signature: string; blockTime: number | null }> = [];
    const summaries = new Map<string, LeaderTxSummary>();
    for (let i = 0; i < 20; i++) {
      const signature = `cap_${i}`;
      const summary = swapSummary({
        signature,
        minutesAgo: i + 1,
        tokens: 6_000_000n,
        usd: 6_000_000n,
        side: 'buy',
        mint: `ValveCapMint${i}11111111111111111111111111111`,
      });
      page.push({ signature, blockTime: summary.blockTime });
      summaries.set(signature, summary);
    }
    h.perAddress.set('WalletValveCap', { page, summaries });

    await h.svc.tick();
    expect(h.heliusDetailCalls.get('WalletValveCap')).toBe(15);
    expect(repo.listWatchEvents(handle.db, 'cand_valve_cap')).toHaveLength(15);
    // Oldest-first processing stops after cap_5; cap_4..cap_0 retry next tick.
    expect(repo.getWatchCursor(handle.db, 'WalletValveCap')?.lastSignature).toBe('cap_5');
  });
});
