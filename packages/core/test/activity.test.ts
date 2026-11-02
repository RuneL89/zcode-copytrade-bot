import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_TRADE_USD_MICRO,
  measureCopyableActivity,
  type CopyableActivityOptions,
} from '../src/activity.js';
import { STABLE_MINTS, WRAPPED_SOL_MINT, type LeaderTxSummary, type TokenDelta } from '../src/tx.js';

const USDC = [...STABLE_MINTS][0]!;
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const HOUR = 3_600_000;

function leg(mint: string, deltaBase: bigint, decimals = 6): TokenDelta {
  return { mint, decimals, preBase: 0n, postBase: deltaBase, deltaBase };
}

function tx(over: Partial<LeaderTxSummary> & { agesHours?: number } = {}): LeaderTxSummary {
  const ageMs = (over.agesHours ?? 1) * HOUR;
  const { agesHours: _ignored, ...rest } = over;
  return {
    chain: 'solana',
    leaderAddress: 'LEADER',
    signature: rest.signature ?? 'sig-' + Math.random(),
    slot: 1,
    transactionIndex: 0,
    blockTime: Math.floor((NOW - ageMs) / 1000),
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas: [],
    programs: [],
    ...rest,
  };
}

const PRICES = new Map<string, bigint>([
  ['TOKEN', 200_000_000n], // $200 per whole token
  ['CHEAP', 1_000_000n], // $1 per whole token
]);

function opts(over: Partial<CopyableActivityOptions> = {}): CopyableActivityOptions {
  return {
    nowMs: NOW,
    lookbackHours: 24,
    minTradeUsdMicro: DEFAULT_MIN_TRADE_USD_MICRO,
    priceOf: (mint) => PRICES.get(mint) ?? null,
    ...over,
  };
}

describe('measureCopyableActivity', () => {
  it('counts a funded buy as one entry (D4 definition)', () => {
    // 5,000 base @ 6 decimals = 0.005 token × $200 = $1.00, paid with 1 USDC.
    const s = measureCopyableActivity(
      [tx({ tokenDeltas: [leg('TOKEN', 5_000n), leg(USDC, -1_000_000n)] })],
      opts(),
    );
    expect(s.copyableTrades24h).toBe(1);
    expect(s.entries24h).toBe(1);
    expect(s.exits24h).toBe(0);
    expect(s.lastEntryAt).toBe(new Date(NOW - HOUR).toISOString());
    expect(s.lastTradeAt).toBe(s.lastEntryAt);
  });

  it('counts a funded sell as an exit, not an entry', () => {
    const s = measureCopyableActivity(
      [tx({ tokenDeltas: [leg('TOKEN', -5_000n), leg(USDC, 1_000_000n)] })],
      opts(),
    );
    expect(s.copyableTrades24h).toBe(1);
    expect(s.exits24h).toBe(1);
    expect(s.entries24h).toBe(0);
    expect(s.lastEntryAt).toBeNull();
  });

  it('counts a funded buy paid with SOL (native funding leg)', () => {
    const s = measureCopyableActivity(
      [tx({ tokenDeltas: [leg('TOKEN', 5_000n)], nativeDeltaBase: -1_000_000n })],
      opts(),
    );
    expect(s.entries24h).toBe(1);
  });

  it('a token-for-token swap is a movement, never a funded buy or sell', () => {
    const s = measureCopyableActivity(
      [tx({ tokenDeltas: [leg('TOKEN', 5_000n), leg('CHEAP', -2_000_000n)] })],
      opts(),
    );
    expect(s.copyableTrades24h).toBe(1); // the coins moved
    expect(s.entries24h).toBe(0); // but no funding leg was paid
    expect(s.exits24h).toBe(0);
  });

  it('ignores a fee payout with no coin movement', () => {
    const s = measureCopyableActivity([tx({ nativeDeltaBase: 6_700_000n })], opts());
    expect(s.copyableTrades24h).toBe(0);
    expect(s.lastTradeAt).toBeNull();
  });

  it('ignores an empty token-account creation', () => {
    const s = measureCopyableActivity([tx({ tokenDeltas: [leg('TOKEN', 0n)] })], opts());
    expect(s.copyableTrades24h).toBe(0);
  });

  it('counts a routed buy with no attributable delta as activity but never as an entry', () => {
    const s = measureCopyableActivity([tx({ foreignTokenMints: ['TOKEN'] })], opts());
    expect(s.copyableTrades24h).toBe(1);
    expect(s.entries24h).toBe(0);
    expect(s.unattributedTrades24h).toBe(1);
    expect(s.lastEntryAt).toBeNull();
  });

  it('an airdrop above the floor is a movement but never an entry (D4)', () => {
    const s = measureCopyableActivity([tx({ tokenDeltas: [leg('TOKEN', 5_000n)] })], opts());
    expect(s.copyableTrades24h).toBe(1);
    expect(s.entries24h).toBe(0);
    expect(s.lastEntryAt).toBeNull();
  });

  it('a creator-fee distribution is never an entry anywhere', () => {
    // Two fee inflows and a native payout: no funding leg was ever paid.
    const s = measureCopyableActivity(
      [tx({ tokenDeltas: [leg('TOKEN', 9_000_000n), leg('CHEAP', 2_000n)], nativeDeltaBase: 700_000n })],
      opts(),
    );
    expect(s.entries24h).toBe(0);
    expect(s.lastEntryAt).toBeNull();
  });

  it('ignores dust below the $1 floor', () => {
    // 1,000 base @ 6 decimals = 0.001 token × $1 = $0.001
    const s = measureCopyableActivity([tx({ tokenDeltas: [leg('CHEAP', 1_000n)] })], opts());
    expect(s.copyableTrades24h).toBe(0);
  });

  it('ignores coins that are not copyable (no price/route)', () => {
    const s = measureCopyableActivity([tx({ tokenDeltas: [leg('NO_ROUTE', 9_000_000n)] })], opts());
    expect(s.copyableTrades24h).toBe(0);
    expect(s.unbuyableMints).toBe(1);
  });

  it('never treats a funding mint as the copied coin', () => {
    const s = measureCopyableActivity([tx({ tokenDeltas: [leg(USDC, 9_000_000n)] })], opts());
    expect(s.copyableTrades24h).toBe(0);
    const s2 = measureCopyableActivity([tx({ tokenDeltas: [leg(WRAPPED_SOL_MINT, 9_000_000n, 9)] })], opts());
    expect(s2.copyableTrades24h).toBe(0);
  });

  it('skips failed transactions', () => {
    const s = measureCopyableActivity([tx({ err: true, tokenDeltas: [leg('TOKEN', 5_000n)] })], opts());
    expect(s.copyableTrades24h).toBe(0);
  });

  it('stops at the lookback edge (newest-first input)', () => {
    const funded = [leg('TOKEN', 5_000n), leg(USDC, -1_000_000n)];
    const s = measureCopyableActivity(
      [tx({ agesHours: 1, tokenDeltas: funded }), tx({ agesHours: 30, tokenDeltas: funded })],
      opts(),
    );
    expect(s.copyableTrades24h).toBe(1);
    expect(s.scannedTxs).toBe(1);
  });

  it('reports the newest funded buy and newest trade independently', () => {
    const s = measureCopyableActivity(
      [
        tx({ agesHours: 1, tokenDeltas: [leg('TOKEN', -5_000n), leg(USDC, 1_000_000n)] }), // exit 1h ago
        tx({ agesHours: 3, tokenDeltas: [leg('TOKEN', 5_000n), leg(USDC, -1_000_000n)] }), // buy 3h ago
      ],
      opts(),
    );
    expect(s.copyableTrades24h).toBe(2);
    expect(s.entries24h).toBe(1);
    expect(s.exits24h).toBe(1);
    expect(s.lastTradeAt).toBe(new Date(NOW - HOUR).toISOString());
    expect(s.lastEntryAt).toBe(new Date(NOW - 3 * HOUR).toISOString());
  });

  it('respects the scan cap', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      tx({
        agesHours: i + 1,
        tokenDeltas: [leg('TOKEN', 5_000n), leg(USDC, -1_000_000n)],
      }),
    );
    const s = measureCopyableActivity(many, opts({ maxTradeScan: 2 }));
    expect(s.copyableTrades24h).toBe(2);
    expect(s.scannedTxs).toBe(2);
  });
});
