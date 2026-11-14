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
  hired: string[];
}

function harness(risk: RiskConfig, over: { risk?: RiskConfig } = {}): Harness {
  void over;
  const summaries = new Map<string, LeaderTxSummary>();
  const page: Array<{ signature: string; blockTime: number | null }> = [];
  const perAddress = new Map<
    string,
    { page: Array<{ signature: string; blockTime: number | null }>; summaries: Map<string, LeaderTxSummary> }
  >();
  const prices = new Map<string, bigint>([[TOKEN, 1_000_000n]]); // $1.00 per whole token
  const hired: string[] = [];

  const deps: WatchServiceDeps = {
    db: handle.db,
    risk,
    publicSolana: { configured: false } as unknown as WatchServiceDeps['publicSolana'],
    helius: {
      latestCursor: async () => ({
        lastSignature: '',
        lastSlot: 0,
        lastTransactionIndex: 0,
        lastBlockTime: null,
      }),
      recentSignatures: async (address: string) =>
        (perAddress.get(address)?.page ?? page).map((r) => ({ ...r })),
      transactionSummary: async (address: string, signature: string) =>
        perAddress.get(address)?.summaries.get(signature) ?? summaries.get(signature) ?? null,
    } as unknown as WatchServiceDeps['helius'],
    prices: {
      priceOf: async (mint: string) => {
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
    hired,
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

    // A buy 9h ago: already past MAX_POSITION_AGE_HOURS (8h).
    h.summaries.set(
      'c-b1',
      swapSummary({
        signature: 'c-b1',
        minutesAgo: 9 * 60,
        tokens: 6_000_000n,
        usd: 6_000_000n,
        side: 'buy',
      }),
    );
    h.page.unshift({ signature: 'c-b1', blockTime: NOW_SEC - 9 * 60 * 60 });
    await h.svc.tick();
    expect(repo.listOpenShadowTrades(handle.db, 'cand_ceiling')).toHaveLength(1);

    // Positive mark → closes now at the quote.
    h.prices.set(TOKEN, 2_000_000n);
    await h.svc.tick();
    const aggregates = repo.shadowAggregates(handle.db, 'cand_ceiling');
    expect(aggregates.closedCount).toBe(1);
    expect(aggregates.netPnlUsdMicro).toBe(shadowPnlUsdMicro(5_000_000n, 1_000_000n, 2_000_000n)); // $5 at $1 → $10 at $2
    expect(repo.listWatchEvents(handle.db, 'cand_ceiling').length).toBeGreaterThan(0);
    expect(repo.listAudit(handle.db, 5).some((a) => /ceiling closed at/.test(a.message))).toBe(true);
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

  it('re-entry: an old record cannot return a fired trader; a post-fire buy can (AC7)', async () => {
    seedCandidate('cand_reentry', 'reentry', 'WalletReentry');
    const h = harness(riskConfig());
    await h.svc.admit('cand_reentry', readingFrom([buy('r1', 60), buy('r2', 30), buy('r3', 5)]));
    recordBuys('cand_reentry', 'WalletReentry', 1, 5);
    seedRecord('cand_reentry', 3, 2_000_000n);
    // The last funded buy is 5 minutes old, the firing happened 1 minute ago.
    repo.insertFiringEvent(handle.db, {
      activationId: 'act_old',
      candidateId: 'cand_reentry',
      reason: 'idle',
      lossStreak: 0,
      positionPolicy: 'keep_positions',
      firedAt: iso(Date.now() - 60_000),
      closeCompletedAt: null,
      handoffStatus: 'none',
    });
    expect(h.svc.promotionDecision('cand_reentry').reason).toBe('REENTRY_BANNED');
    expect(repo.listAudit(handle.db, 5).some((a) => /re-entry blocked/.test(a.message))).toBe(false); // audit comes from evaluate()

    // The cooling rotation readmits him once a funded buy lands after the fire
    // AND the cooldown has elapsed. A buy inside the cooldown does not.
    repo.setWatchStatus(handle.db, 'cand_reentry', 'cooling', 'fired');
    expect(await h.svc.coolingTick()).toBe(0);
    repo.insertWatchEvent(handle.db, {
      candidateId: 'cand_reentry',
      address: 'WalletReentry',
      signature: 'post-fire-buy',
      side: 'buy',
      mint: TOKEN,
      tokenAmountBase: '6000000',
      decimals: 6,
      usdMicro: '6000000',
      blockTime: NOW_SEC - 10,
      observedAt: iso(Date.now() - 10_000),
      source: 'test',
    });
    // The buy is after the fire, but the 36h cooldown has not elapsed.
    expect(await h.svc.coolingTick()).toBe(0);
    handle.sqlite
      .prepare('update firing_events set fired_at = ? where candidate_id = ?')
      .run(iso(Date.now() - 37 * HOUR), 'cand_reentry');
    expect(await h.svc.coolingTick()).toBe(1);
    expect(repo.getWatchWallet(handle.db, 'cand_reentry')?.status).toBe('watching');
    expect(h.svc.promotionDecision('cand_reentry').ok).toBe(true);
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

    // Tick 1 scans the three stalest wallets, the dead ones. The good wallet is
    // behind them and stays off the list.
    await h.svc.tick();
    expect(repo.getWatchWallet(handle.db, 'cand_rot_good')).toBeUndefined();

    // Tick 2 has nothing staler than the good wallet, so it is scanned, its
    // reading is recorded, and it is admitted.
    await h.svc.tick();
    expect(repo.getWatchWallet(handle.db, 'cand_rot_good')?.status).toBe('watching');
    expect(repo.getCandidate(handle.db, 'cand_rot_good')?.buys24h).toBe(3);
  });
});
