import { describe, expect, it } from 'vitest';
import { classifyLeaderEvent, PARSER_VERSION } from '../src/events.js';
import { STABLE_MINTS, type LeaderTxSummary } from '../src/tx.js';
import { compareClassifiedEvents, eventDedupeKey, isEventTooOld } from '../src/eventOrder.js';
import { canTransitionOrder, transitionOrder, unknownOutcomeTarget } from '../src/orderState.js';
import { canTransitionActivation, transitionActivation, dashboardBadges } from '../src/states.js';
import { evaluateEntryRisk, bankrollHeadroom } from '../src/risk.js';
import { DEFAULT_RISK } from '@zcode-bot/config';
import { usdToMicro } from '../src/money.js';

const USDC = [...STABLE_MINTS][0]!;
const MEOW = 'MeowMint111111111111111111111111111111111111111';

function tx(over: Partial<LeaderTxSummary> = {}): LeaderTxSummary {
  return {
    chain: 'solana',
    leaderAddress: 'LeaderAddr1111111111111111111111111111111111',
    signature: 'sig-' + Math.random().toString(36).slice(2),
    slot: 1000,
    transactionIndex: 1,
    blockTime: Math.floor(Date.now() / 1000),
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas: [],
    programs: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
    ...over,
  };
}

function buy(): LeaderTxSummary {
  return tx({
    tokenDeltas: [
      { mint: MEOW, decimals: 6, preBase: 0n, postBase: 5_000_000n, deltaBase: 5_000_000n },
      { mint: USDC, decimals: 6, preBase: 20_000_000n, postBase: 8_000_000n, deltaBase: -12_000_000n },
    ],
  });
}

describe('leader event classification', () => {
  it('classifies a clear USDC->token buy', () => {
    const e = classifyLeaderEvent(buy());
    expect(e.kind).toBe('swap_buy');
    if (e.kind === 'swap_buy') {
      expect(e.mint).toBe(MEOW);
      expect(e.tokenDeltaBase).toBe(5_000_000n);
      expect(e.fundingMint).toBe(USDC);
      expect(e.fundingDeltaBase).toBe(12_000_000n);
      expect(e.parserVersion).toBe(PARSER_VERSION);
    }
  });

  it('classifies a clear token->USDC sell', () => {
    const e = classifyLeaderEvent(
      tx({
        tokenDeltas: [
          { mint: MEOW, decimals: 6, preBase: 5_000_000n, postBase: 0n, deltaBase: -5_000_000n },
          { mint: USDC, decimals: 6, preBase: 0n, postBase: 11_000_000n, deltaBase: 11_000_000n },
        ],
      }),
    );
    expect(e.kind).toBe('swap_sell');
  });

  it('classifies native SOL funding legs', () => {
    const e = classifyLeaderEvent(
      tx({
        nativeDeltaBase: -2_500_000_000n,
        tokenDeltas: [
          { mint: MEOW, decimals: 6, preBase: 0n, postBase: 9n * 10n ** 6n, deltaBase: 9_000_000n },
        ],
      }),
    );
    expect(e.kind).toBe('swap_buy');
  });

  it('ignores failed transactions', () => {
    expect(classifyLeaderEvent(tx({ err: true })).kind).toBe('skipped');
  });

  it('skips unsupported chains with SKIPPED_UNSUPPORTED_CHAIN', () => {
    const e = classifyLeaderEvent(tx({ chain: 'base' }));
    expect(e).toMatchObject({ kind: 'skipped', reason: 'SKIPPED_UNSUPPORTED_CHAIN' });
  });

  it('skips ordinary transfers and airdrops without swap evidence', () => {
    const out = classifyLeaderEvent(
      tx({
        programs: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        tokenDeltas: [{ mint: MEOW, decimals: 6, preBase: 0n, postBase: 100n, deltaBase: 100n }],
      }),
    );
    expect(out).toMatchObject({ kind: 'skipped', reason: 'SKIPPED_AIRDROP' });
    const away = classifyLeaderEvent(
      tx({
        programs: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        tokenDeltas: [{ mint: MEOW, decimals: 6, preBase: 100n, postBase: 0n, deltaBase: -100n }],
      }),
    );
    expect(away).toMatchObject({ kind: 'skipped', reason: 'SKIPPED_TRANSFER' });
  });

  it('skips NFT activity (zero-decimals tokens)', () => {
    const e = classifyLeaderEvent(
      tx({
        tokenDeltas: [
          {
            mint: 'NftMint11111111111111111111111111111111111111',
            decimals: 0,
            preBase: 0n,
            postBase: 1n,
            deltaBase: 1n,
          },
          { mint: USDC, decimals: 6, preBase: 500_000n, postBase: 0n, deltaBase: -500_000n },
        ],
      }),
    );
    expect(e).toMatchObject({ kind: 'skipped', reason: 'SKIPPED_NFT_ACTIVITY' });
  });

  it('skips stable-to-stable movements', () => {
    const usdt = [...STABLE_MINTS][1]!;
    const e = classifyLeaderEvent(
      tx({
        tokenDeltas: [
          { mint: USDC, decimals: 6, preBase: 1000n, postBase: 0n, deltaBase: -1000n },
          { mint: usdt, decimals: 6, preBase: 0n, postBase: 998n, deltaBase: 998n },
        ],
      }),
    );
    expect(e).toMatchObject({ kind: 'skipped', reason: 'SKIPPED_STABLE_TO_STABLE' });
  });

  it('marks multi-token or unknown-program patterns ambiguous (fail closed)', () => {
    const multiToken = classifyLeaderEvent(
      tx({
        tokenDeltas: [
          { mint: MEOW, decimals: 6, preBase: 0n, postBase: 100n, deltaBase: 100n },
          {
            mint: 'OtherMint11111111111111111111111111111111111',
            decimals: 6,
            preBase: 50n,
            postBase: 0n,
            deltaBase: -50n,
          },
          { mint: USDC, decimals: 6, preBase: 900n, postBase: 800n, deltaBase: -100n },
        ],
      }),
    );
    expect(multiToken).toMatchObject({ kind: 'skipped', reason: 'SKIPPED_AMBIGUOUS' });

    const unknownProgram = classifyLeaderEvent(
      tx({
        programs: ['UnknownProgram11111111111111111111111111111111'],
        tokenDeltas: [
          { mint: MEOW, decimals: 6, preBase: 0n, postBase: 100n, deltaBase: 100n },
          { mint: USDC, decimals: 6, preBase: 500n, postBase: 400n, deltaBase: -100n },
        ],
      }),
    );
    expect(unknownProgram).toMatchObject({ kind: 'skipped', reason: 'SKIPPED_AMBIGUOUS' });
  });
});

describe('event ordering and dedupe', () => {
  it('orders by slot then index then leg', () => {
    expect(
      compareClassifiedEvents({ slot: 1, transactionIndex: 5 }, { slot: 2, transactionIndex: 0 }),
    ).toBeLessThan(0);
    expect(
      compareClassifiedEvents(
        { slot: 1, transactionIndex: 2, legIndex: 1 },
        { slot: 1, transactionIndex: 2, legIndex: 0 },
      ),
    ).toBeGreaterThan(0);
  });
  it('dedupe key includes chain, leader, signature, leg', () => {
    expect(eventDedupeKey('solana', 'L', 'sig', 0)).not.toBe(eventDedupeKey('solana', 'L', 'sig', 1));
    expect(eventDedupeKey('solana', 'L', 'sig', 0)).not.toBe(eventDedupeKey('solana', 'L2', 'sig', 0));
  });
  it('old or unknown-time events are rejected instead of entering late', () => {
    const now = Date.now();
    expect(isEventTooOld(Math.floor(now / 1000) - 3600, now, 90)).toBe(true);
    expect(isEventTooOld(null, now, 90)).toBe(true);
    expect(isEventTooOld(Math.floor(now / 1000) - 5, now, 90)).toBe(false);
    // A logsSubscribe notification resolved 2s after the leader block is copyable.
    // The same buy first seen by the 300s safety poll is not.
    const block = Math.floor(now / 1000) - 2;
    expect(isEventTooOld(block, block * 1000 + 2_000, 90)).toBe(false);
    expect(Math.round(2_000 / 1000)).toBe(2);
    expect(isEventTooOld(block, block * 1000 + 300_000, 90)).toBe(true);
  });
});

describe('order intent state machine', () => {
  it('forbids blind retry after signing', () => {
    expect(canTransitionOrder('signed', 'pending_quote')).toBe(false);
    expect(canTransitionOrder('submitted', 'pending_quote')).toBe(false);
    expect(canTransitionOrder('submitted', 'quoted')).toBe(false);
    expect(() => transitionOrder('signed', 'pending_quote')).toThrow();
  });
  it('routes unknown outcomes to reconciliation and only evidence resolves them', () => {
    expect(unknownOutcomeTarget()).toBe('requires_reconciliation');
    expect(canTransitionOrder('requires_reconciliation', 'confirmed')).toBe(true);
    expect(canTransitionOrder('requires_reconciliation', 'failed')).toBe(true);
    expect(canTransitionOrder('requires_reconciliation', 'pending_sign')).toBe(false);
  });
});

describe('activation + dashboard states', () => {
  it('guards activation transitions', () => {
    expect(() => transitionActivation('FIRED', 'ACTIVE')).toThrow();
    expect(transitionActivation('ACTIVE', 'FIRING')).toBe('FIRING');
    expect(transitionActivation('REQUIRES_RECONCILIATION', 'FIRED')).toBe('FIRED');
  });
  it('never shows LIVE unless armed', () => {
    expect(dashboardBadges({ mode: 'live', armed: false, appState: 'RUNNING', dataStale: false })).toContain(
      'PAPER',
    );
    expect(dashboardBadges({ mode: 'live', armed: true, appState: 'RUNNING', dataStale: false })).toContain(
      'LIVE',
    );
    expect(dashboardBadges({ mode: 'demo', armed: false, appState: 'RUNNING', dataStale: false })[0]).toBe(
      'DEMO',
    );
    expect(
      dashboardBadges({ mode: 'paper', armed: false, appState: 'PAUSED_NO_TRADER', dataStale: true }),
    ).toEqual(expect.arrayContaining(['PAPER', 'PAUSED', 'STALE']));
  });
});

describe('entry risk gate', () => {
  const baseInput = {
    entryUsdMicro: usdToMicro(10),
    realizedPnlTodayUsdMicro: 0n,
    eventAgeSeconds: 10,
    priceAgeSeconds: 5,
    leaderboardAgeSeconds: 100,
    quoteSlippageBps: 50,
    quotePriceImpactBps: 40,
  };
  it('allows a clean entry', () => {
    expect(evaluateEntryRisk(DEFAULT_RISK, baseInput).allowed).toBe(true);
  });
  it('rejects each documented limit', () => {
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, entryUsdMicro: usdToMicro(1) }).rule).toBe(
      'MIN_PER_BUY_USD',
    );
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, entryUsdMicro: usdToMicro(2) }).allowed).toBe(
      true,
    );
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, entryUsdMicro: usdToMicro(10) }).allowed).toBe(
      true,
    );
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, entryUsdMicro: usdToMicro(11) }).rule).toBe(
      'MAX_PER_BUY_USD',
    );
    expect(
      evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, realizedPnlTodayUsdMicro: -15_000_000n }).rule,
    ).toBe('MAX_DAILY_REALIZED_LOSS_USD');
    expect(
      evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, realizedPnlTodayUsdMicro: -14_999_999n }).allowed,
    ).toBe(true);
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, eventAgeSeconds: 120 }).rule).toBe(
      'MAX_COPY_EVENT_AGE_SECONDS',
    );
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, priceAgeSeconds: 60 }).rule).toBe(
      'PRICE_MAX_AGE_SECONDS',
    );
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, leaderboardAgeSeconds: 90000 }).rule).toBe(
      'LEADERBOARD_MAX_AGE_SECONDS',
    );
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, quoteSlippageBps: 500 }).rule).toBe(
      'MAX_SLIPPAGE_BPS',
    );
    expect(evaluateEntryRisk(DEFAULT_RISK, { ...baseInput, quotePriceImpactBps: 900 }).rule).toBe(
      'MAX_PRICE_IMPACT_BPS',
    );
  });
});

describe('bankrollHeadroom (fee-aware)', () => {
  it('computes capital, cash, and headroom with fees on open entries', () => {
    // $100 start, 4 x $10 buys at 5 bps paper fee ($0.005 each), no realized.
    const openEntries = usdToMicro(40);
    const openFees = usdToMicro(0.02);
    const s = bankrollHeadroom({
      equityStartUsdMicro: usdToMicro(100),
      openEntriesUsdMicro: openEntries,
      openFeesUsdMicro: openFees,
      realizedNetUsdMicro: 0n,
      maxDeployedPct: 80,
    });
    expect(s.capitalUsdMicro).toBe(usdToMicro(100));
    expect(s.deployedUsdMicro).toBe(usdToMicro(40.02));
    expect(s.cashUsdMicro).toBe(usdToMicro(59.98));
    // 80% of $100 = $80 allowance − $40.02 deployed.
    expect(s.headroomUsdMicro).toBe(usdToMicro(39.98));
  });
  it('includes fee-net realized PnL and floors over-cap headroom at zero', () => {
    const s = bankrollHeadroom({
      equityStartUsdMicro: usdToMicro(100),
      openEntriesUsdMicro: usdToMicro(90),
      openFeesUsdMicro: usdToMicro(1),
      realizedNetUsdMicro: usdToMicro(15), // sold one for +15 net
      maxDeployedPct: 80,
    });
    expect(s.capitalUsdMicro).toBe(usdToMicro(115));
    expect(s.cashUsdMicro).toBe(usdToMicro(24));
    // 80% of 115 = 92 < 91 deployed -> headroom 1
    expect(s.headroomUsdMicro).toBe(usdToMicro(1));
    const over = bankrollHeadroom({
      equityStartUsdMicro: usdToMicro(100),
      openEntriesUsdMicro: usdToMicro(90),
      openFeesUsdMicro: usdToMicro(5),
      realizedNetUsdMicro: usdToMicro(-10),
      maxDeployedPct: 80,
    });
    expect(over.headroomUsdMicro).toBe(0n);
  });
});
