import { describe, expect, it } from 'vitest';
import { scanForRecentBuy, type LeaderTxSummary, STABLE_MINTS } from '../src/events.js';
import { partitionByActivelyTrading } from '../src/shortlist.js';

const USDC = [...STABLE_MINTS][0]!;
const MEOW = 'MeowMint111111111111111111111111111111111111111';
const NOW_SEC = Math.floor(Date.now() / 1000);
const CUTOFF_MS = (NOW_SEC - 4 * 3600) * 1000; // 4h window

let seq = 0;
function txAt(
  ageHours: number,
  kind: 'buy' | 'sell' | 'transfer',
  blockTime: number | null = null,
): LeaderTxSummary {
  const t = blockTime ?? Math.floor(NOW_SEC - ageHours * 3600);
  const tokenDeltas =
    kind === 'buy'
      ? [
          { mint: MEOW, decimals: 6, preBase: 0n, postBase: 5_000_000n, deltaBase: 5_000_000n },
          { mint: USDC, decimals: 6, preBase: 20_000_000n, postBase: 8_000_000n, deltaBase: -12_000_000n },
        ]
      : kind === 'sell'
        ? [
            { mint: MEOW, decimals: 6, preBase: 5_000_000n, postBase: 0n, deltaBase: -5_000_000n },
            { mint: USDC, decimals: 6, preBase: 0n, postBase: 11_000_000n, deltaBase: 11_000_000n },
          ]
        : [{ mint: MEOW, decimals: 6, preBase: 1n, postBase: 2n, deltaBase: 1n }];
  return {
    chain: 'solana',
    leaderAddress: 'LeaderAddr1111111111111111111111111111111111',
    signature: 'sig-' + seq++,
    slot: 1000 + seq,
    transactionIndex: 1,
    blockTime: t,
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas,
    programs: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
  };
}

describe('scanForRecentBuy', () => {
  it('finds a buy within the window', () => {
    const scan = scanForRecentBuy([txAt(1, 'buy')], CUTOFF_MS);
    expect(scan.lastBuyAt).not.toBeNull();
    expect(scan.boundaryReached).toBe(false);
  });

  it('walks past sells and transfers to the most recent buy', () => {
    // Newest-first: sell 0.5h ago, transfer 2h ago, BUY 3h ago -> active.
    const scan = scanForRecentBuy([txAt(0.5, 'sell'), txAt(2, 'transfer'), txAt(3, 'buy')], CUTOFF_MS);
    expect(scan.lastBuyAt).not.toBeNull();
    const ageHours = (Date.now() - Date.parse(scan.lastBuyAt!)) / 3600_000;
    expect(ageHours).toBeGreaterThan(2.5);
    expect(ageHours).toBeLessThan(3.5);
  });

  it('reports sell-only activity as not actively trading', () => {
    const scan = scanForRecentBuy([txAt(0.5, 'sell'), txAt(3, 'sell')], CUTOFF_MS);
    expect(scan.lastBuyAt).toBeNull();
    expect(scan.boundaryReached).toBe(false);
  });

  it('stops at the window boundary', () => {
    const scan = scanForRecentBuy([txAt(5, 'buy')], CUTOFF_MS);
    expect(scan.lastBuyAt).toBeNull();
    expect(scan.boundaryReached).toBe(true);
  });

  it('reports exhausted when rows are inside the window but no buy exists', () => {
    const scan = scanForRecentBuy([txAt(1, 'sell'), txAt(2, 'transfer')], CUTOFF_MS);
    expect(scan.lastBuyAt).toBeNull();
    expect(scan.boundaryReached).toBe(false);
  });

  it('skips rows without a blockTime instead of misreading the boundary', () => {
    const noTime = { ...txAt(1, 'buy'), blockTime: null };
    const scan = scanForRecentBuy([noTime, txAt(2, 'buy')], CUTOFF_MS);
    expect(scan.lastBuyAt).not.toBeNull();
    const ageHours = (Date.now() - Date.parse(scan.lastBuyAt!)) / 3600_000;
    expect(ageHours).toBeGreaterThan(1.5);
  });

  it('handles an empty page', () => {
    expect(scanForRecentBuy([], CUTOFF_MS)).toEqual({ lastBuyAt: null, boundaryReached: false });
  });
});

describe('partitionByActivelyTrading', () => {
  it('puts active entries first while preserving order on both sides', () => {
    const entries = [
      { id: 'a', active: false },
      { id: 'b', active: true },
      { id: 'c', active: false },
      { id: 'd', active: true },
    ];
    const { active, inactive } = partitionByActivelyTrading(entries, (e) => e.active);
    expect(active.map((e) => e.id)).toEqual(['b', 'd']);
    expect(inactive.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('degrades to the full merit order when nobody is active', () => {
    const entries = [{ id: 'a' }, { id: 'b' }];
    const { active, inactive } = partitionByActivelyTrading(entries, () => false);
    expect(active).toEqual([]);
    expect(inactive).toEqual(entries);
  });

  it('keeps everything in the active tier when all are active', () => {
    const entries = [{ id: 'a' }, { id: 'b' }];
    const { active, inactive } = partitionByActivelyTrading(entries, () => true);
    expect(active).toEqual(entries);
    expect(inactive).toEqual([]);
  });
});
