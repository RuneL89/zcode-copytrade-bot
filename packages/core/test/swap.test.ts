import { describe, expect, it } from 'vitest';
import { classifyFundedSwap } from '../src/swap.js';
import { STABLE_MINTS, WRAPPED_SOL_MINT, type LeaderTxSummary, type TokenDelta } from '../src/tx.js';
import { classifyLeaderEvent } from '../src/events.js';

const USDC = [...STABLE_MINTS][0]!;
const USDT = [...STABLE_MINTS][1]!;
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function leg(mint: string, deltaBase: bigint, decimals = 6): TokenDelta {
  return { mint, decimals, preBase: 0n, postBase: deltaBase, deltaBase };
}

function tx(over: Partial<LeaderTxSummary> = {}): LeaderTxSummary {
  return {
    chain: 'solana',
    leaderAddress: 'LEADER',
    signature: 'sig',
    slot: 1,
    transactionIndex: 0,
    blockTime: 1_800_000_000,
    err: false,
    nativeDeltaBase: 0n,
    tokenDeltas: [],
    programs: [JUP],
    ...over,
  };
}

describe('classifyFundedSwap — the one funded-swap definition (D4)', () => {
  it('a stable-funded buy is a buy', () => {
    const swap = classifyFundedSwap(tx({ tokenDeltas: [leg('TOKEN', 5_000_000n), leg(USDC, -12_000_000n)] }));
    expect(swap).toMatchObject({
      side: 'buy',
      mint: 'TOKEN',
      decimals: 6,
      tokenDeltaBase: 5_000_000n,
      fundingMint: USDC,
      fundingDeltaBase: 12_000_000n,
    });
  });

  it('a native-SOL-funded buy is a buy with the SOL funding leg', () => {
    const swap = classifyFundedSwap(
      tx({ tokenDeltas: [leg('TOKEN', 5_000_000n)], nativeDeltaBase: -250_000_000n }),
    );
    expect(swap).toMatchObject({ side: 'buy', fundingMint: 'SOL', fundingDecimals: 9 });
    expect(swap!.fundingDeltaBase).toBe(250_000_000n);
  });

  it('a sell mirrors the buy', () => {
    const stable = classifyFundedSwap(
      tx({ tokenDeltas: [leg('TOKEN', -5_000_000n), leg(USDT, 9_000_000n)] }),
    );
    expect(stable).toMatchObject({ side: 'sell', fundingMint: USDT, fundingDeltaBase: 9_000_000n });
    expect(stable!.tokenDeltaBase).toBe(-5_000_000n);

    const native = classifyFundedSwap(
      tx({ tokenDeltas: [leg('TOKEN', -5_000_000n)], nativeDeltaBase: 220_000_000n }),
    );
    expect(native).toMatchObject({ side: 'sell', fundingMint: 'SOL' });
  });

  it('a creator-fee distribution is not a buy', () => {
    // Token inflows plus a SOL payout, with no funding leg ever paid.
    const swap = classifyFundedSwap(
      tx({
        tokenDeltas: [leg('TOKEN', 9_000_000n), leg('CHEAP', 2_000n)],
        nativeDeltaBase: 700_000n,
      }),
    );
    expect(swap).toBeNull();
    // …and the copier agrees: never an entry.
    expect(classifyLeaderEvent(tx({ tokenDeltas: [leg('TOKEN', 9_000_000n)] })).kind).toBe('skipped');
  });

  it('an airdrop (inflow with no funding leg) is not a buy', () => {
    expect(classifyFundedSwap(tx({ tokenDeltas: [leg('TOKEN', 5_000_000n)] }))).toBeNull();
  });

  it('a routed buy with no attributable funding leg is not a funded buy', () => {
    expect(
      classifyFundedSwap(tx({ tokenDeltas: [], foreignTokenMints: ['TOKEN'], nativeDeltaBase: 0n })),
    ).toBeNull();
  });

  it('a coin-for-coin rotation is a real trade: side swap, both legs carried', () => {
    // Operator decision 2026-11-22: a real swap counts whoever signed it and
    // whatever the quote asset — one coin out, one different coin in.
    const swap = classifyFundedSwap(
      tx({ tokenDeltas: [leg('TOKEN', 5_000_000n), leg('CHEAP', -2_000_000n)] }),
    );
    expect(swap).not.toBeNull();
    expect(swap).toMatchObject({
      side: 'swap',
      mint: 'TOKEN',
      tokenDeltaBase: 5_000_000n,
      outMint: 'CHEAP',
      outTokenDeltaBase: -2_000_000n,
    });
    // Same coin on both sides (a no-op rewrap) is still not a trade.
    expect(
      classifyFundedSwap(tx({ tokenDeltas: [leg('TOKEN', 5_000_000n), leg('TOKEN', -2_000_000n)] })),
    ).toBeNull();
    // …and the copier sees a rotate event, not an ambiguous skip.
    expect(
      classifyLeaderEvent(tx({ tokenDeltas: [leg('TOKEN', 5_000_000n), leg('CHEAP', -2_000_000n)] })).kind,
    ).toBe('swap_rotate');
  });

  it('a stable-to-stable move is not a funded trade', () => {
    expect(
      classifyFundedSwap(tx({ tokenDeltas: [leg(USDC, -9_000_000n), leg(USDT, 9_000_000n)] })),
    ).toBeNull();
  });

  it('failed transactions, NFT-like legs and empty movements are never trades', () => {
    expect(classifyFundedSwap(tx({ err: true, tokenDeltas: [leg('TOKEN', 5_000_000n)] }))).toBeNull();
    expect(classifyFundedSwap(tx({ tokenDeltas: [leg('NFT', 1n, 0), leg(USDC, -1_000_000n)] }))).toBeNull();
    expect(classifyFundedSwap(tx({}))).toBeNull();
  });

  it('the funding mint is never the traded coin', () => {
    // Paying USDC and receiving wrapped SOL: both legs are funding legs.
    expect(
      classifyFundedSwap(tx({ tokenDeltas: [leg(WRAPPED_SOL_MINT, 1_000_000n, 9), leg(USDC, -2_000_000n)] })),
    ).toBeNull();
  });

  it('the copier delegates to this definition (AC1)', () => {
    const buy = classifyLeaderEvent(tx({ tokenDeltas: [leg('TOKEN', 5_000_000n), leg(USDC, -12_000_000n)] }));
    expect(buy.kind).toBe('swap_buy');
    const sell = classifyLeaderEvent(tx({ tokenDeltas: [leg('TOKEN', -5_000_000n), leg(USDC, 9_000_000n)] }));
    expect(sell.kind).toBe('swap_sell');
  });
});
