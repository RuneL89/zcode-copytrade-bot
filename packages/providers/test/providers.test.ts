import { describe, expect, it } from 'vitest';
import { parseManualCsv, parseManualJson } from '../src/leaderboard/import.js';
import { parseDisplayedPnl, robotsDisallows } from '../src/leaderboard/fomo-web.js';
import { HeliusProvider, signatureOf, type FetchedLeaderTx } from '../src/solana/helius.js';
import { JupiterProvider } from '../src/solana/jupiter.js';

describe('manual leaderboard import', () => {
  const validAddress = 'Leader1' + '1'.repeat(36); // 43 chars, valid base58 alphabet

  it('parses valid JSON rows and normalizes observedAt', () => {
    const res = parseManualJson(
      JSON.stringify([
        { handle: 'ape_vasco', weeklyRank: 1, displayedPnlUsd: 438.2, solanaAddresses: [validAddress] },
        { handle: 'moonpie_max', weeklyRank: 3, displayedPnlUsd: null },
      ]),
      new Date('2026-10-25T00:00:00Z'),
    );
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toMatchObject({ handle: 'ape_vasco', weeklyRank: 1, enabled: true });
    expect(res.entries[0]!.solanaAddresses).toEqual([validAddress]);
    expect(res.entries[0]!.observedAt).toBe('2026-10-25T00:00:00.000Z');
  });

  it('skips invalid rows with reasons and records warnings', () => {
    const longBad = 'x'.repeat(40).replace('x', 'l0!'); // right length, wrong alphabet
    const res = parseManualJson(
      JSON.stringify([
        { handle: 'ok_trader', weeklyRank: 2 },
        { handle: 'bad_rank', weeklyRank: -3 },
        {},
        { handle: 'bad_addr', solanaAddresses: [longBad] },
      ]),
      new Date(),
    );
    expect(res.entries).toHaveLength(2);
    expect(res.skipped).toHaveLength(2);
    expect(res.entries[1]!.solanaAddresses).toEqual([]);
    expect(res.warnings.join(' ')).toContain('invalid-looking Solana address');
  });

  it('duplicate handles: later row wins with a warning', () => {
    const res = parseManualJson(
      JSON.stringify([
        { handle: 'dup', weeklyRank: 1 },
        { handle: 'dup', weeklyRank: 5 },
      ]),
      new Date(),
    );
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.weeklyRank).toBe(5);
    expect(res.warnings.join(' ')).toContain('duplicate handle');
  });

  it('parses CSV with quoted cells and pipe-separated addresses', () => {
    const csv = [
      'handle,weekly_rank,displayed_pnl_usd,profile_url,avatar_url,solana_addresses,enabled,observed_at',
      '"luna,degen",2,"+$1,204.50",https://x.example/u,https://cdn.example/a.png,AddrA1111111111111111111111111111111111|AddrB1111111111111111111111111111111111,true,2026-10-25T01:02:03Z',
    ].join('\n');
    const res = parseManualCsv(csv);
    expect(res.entries).toHaveLength(1);
    const e = res.entries[0]!;
    expect(e.handle).toBe('luna,degen');
    expect(e.displayedPnlUsd).toBe(1204.5);
    expect(e.solanaAddresses).toHaveLength(2);
  });

  it('rejects non-array JSON and empty CSV', () => {
    expect(() => parseManualJson('{"handle":"x"}')).toThrow(/array/);
    expect(() => parseManualCsv('handle\n')).toThrow(/at least one data row/);
  });
});

describe('fomo-web helpers', () => {
  it('parses displayed PnL but refuses percentages', () => {
    expect(parseDisplayedPnl('+$438.20')).toBe(438.2);
    expect(parseDisplayedPnl('-$12.00')).toBe(-12);
    expect(parseDisplayedPnl('+438%')).toBeNull();
    expect(parseDisplayedPnl(undefined)).toBeNull();
  });

  it('robots.txt evaluation fails closed on disallow', () => {
    const robots = ['User-agent: *', 'Disallow: /private', 'Allow: /'].join('\n');
    expect(robotsDisallows(robots, '/private/leaderboard')).toBe(true);
    expect(robotsDisallows(robots, '/public')).toBe(false);
    expect(robotsDisallows('User-agent: *\nDisallow: /', '/anything')).toBe(true);
    expect(robotsDisallows('User-agent: googlebot\nDisallow: /', '/anything')).toBe(false);
  });
});

describe('helius transaction normalization', () => {
  const leader = 'LeaderWallet1111111111111111111111111111111111';
  const jup = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const MEOW = 'MeowMint111111111111111111111111111111111111111';

  function fetchedTx(raw: object): FetchedLeaderTx {
    return { signature: 'sig1', slot: 100, transactionIndex: 3, blockTime: 1760000000, err: false, raw };
  }

  it('aggregates leader-owned token deltas by mint (absent pre = 0)', () => {
    const tx = fetchedTx({
      transaction: {
        message: {
          accountKeys: [{ pubkey: leader }, { pubkey: 'AtaMint11111111111111111111111111111111111' }],
          instructions: [{ programId: jup }],
        },
      },
      meta: {
        preBalances: [1_000_000_000, 0],
        postBalances: [1_000_000_000, 0],
        preTokenBalances: [
          { accountIndex: 1, mint: USDC, owner: leader, uiTokenAmount: { amount: '20000000', decimals: 6 } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: USDC, owner: leader, uiTokenAmount: { amount: '8000000', decimals: 6 } },
          { accountIndex: 1, mint: MEOW, owner: leader, uiTokenAmount: { amount: '5000000', decimals: 6 } },
        ],
        innerInstructions: [{ instructions: [{ programId: jup }] }],
      },
    });
    const summary = HeliusProvider.toLeaderTxSummary(leader, tx);
    expect(summary.tokenDeltas).toHaveLength(2);
    const meow = summary.tokenDeltas.find((d) => d.mint === MEOW)!;
    expect(meow.preBase).toBe(0n);
    expect(meow.deltaBase).toBe(5_000_000n);
    expect(summary.programs).toContain(jup);
    expect(summary.nativeDeltaBase).toBe(0n);
  });

  it('ignores token accounts not owned by the leader', () => {
    const tx = fetchedTx({
      transaction: { message: { accountKeys: [{ pubkey: leader }], instructions: [{ programId: jup }] } },
      meta: {
        preBalances: [0],
        postBalances: [0],
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: MEOW,
            owner: 'SomeoneElse11111111111111111111111111111111',
            uiTokenAmount: { amount: '100', decimals: 6 },
          },
        ],
      },
    });
    const summary = HeliusProvider.toLeaderTxSummary(leader, tx);
    expect(summary.tokenDeltas).toHaveLength(0);
  });

  it('computes native SOL delta for the leader', () => {
    const tx = fetchedTx({
      transaction: { message: { accountKeys: [{ pubkey: leader }], instructions: [{ programId: jup }] } },
      meta: {
        preBalances: [5_000_000_000],
        postBalances: [4_000_000_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
    });
    expect(HeliusProvider.toLeaderTxSummary(leader, tx).nativeDeltaBase).toBe(-1_000_000_000n);
  });

  it('provider refuses RPC calls without an API key', async () => {
    const p = new HeliusProvider('');
    await expect(p.healthCheck()).resolves.toMatchObject({ ok: false });
  });
});

describe('jupiter adapter', () => {
  it('price impact bps conversion', () => {
    expect(JupiterProvider.priceImpactBps({ priceImpactPct: '0.0031' } as never)).toBe(31);
    expect(JupiterProvider.priceImpactBps({ priceImpactPct: '0.25' } as never)).toBe(2500);
  });
  it('health check fails closed without network in tests', async () => {
    const p = new JupiterProvider('https://invalid.invalid', '');
    const r = await p.healthCheck();
    expect(r.ok).toBe(false);
  });
});

describe('helius signature extraction', () => {
  it('reads the signature from the signatures-detail shape', () => {
    expect(signatureOf({ signature: 'Abc123' })).toBe('Abc123');
  });

  it('reads the signature from the full-detail shape (no top-level field)', () => {
    // Measured live: getTransactionsForAddress with transactionDetails 'full'
    // returns { transaction: { signatures: [...] } } and NO row.signature.
    expect(signatureOf({ transaction: { signatures: ['Xyz789'] } })).toBe('Xyz789');
  });

  it('returns an empty string when neither shape carries one', () => {
    expect(signatureOf({})).toBe('');
    expect(signatureOf({ signature: null, transaction: { signatures: [] } })).toBe('');
  });
});

describe('leader tx summary program resolution', () => {
  const leader = 'Leader1111111111111111111111111111111111111111';
  const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('resolves raw instructions via programIdIndex against the combined account list', () => {
    // Measured live: getTransactionsForAddress returns non-parsed instructions
    // ({ programIdIndex }) and versioned txs append lookup-table keys.
    const raw = {
      transaction: {
        signatures: ['sigA'],
        message: {
          accountKeys: [leader, 'TokenAcct1111111111111111111111111111111111'],
          instructions: [{ programIdIndex: 2, accounts: [], data: '' }],
        },
      },
      meta: {
        err: null,
        preBalances: [1_000_000_000, 0],
        postBalances: [999_995_000, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC,
            owner: leader,
            uiTokenAmount: { amount: '0', decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC,
            owner: leader,
            uiTokenAmount: { amount: '0', decimals: 6 },
          },
        ],
        loadedAddresses: { writable: [JUP], readonly: [] },
        innerInstructions: [],
      },
    };

    const summary = HeliusProvider.toLeaderTxSummary(leader, {
      signature: signatureOf(raw as never),
      slot: 1,
      transactionIndex: 0,
      blockTime: 1,
      err: false,
      raw,
    } as FetchedLeaderTx);

    expect(summary.signature).toBe('sigA');
    expect(summary.programs).toContain(JUP);
  });

  it('still accepts parsed instructions that already carry programId', () => {
    const raw = {
      transaction: {
        signatures: ['sigB'],
        message: {
          accountKeys: [leader],
          instructions: [{ programId: JUP }],
        },
      },
      meta: { err: null, preBalances: [0], postBalances: [0], innerInstructions: [] },
    };
    const summary = HeliusProvider.toLeaderTxSummary(leader, {
      signature: signatureOf(raw as never),
      slot: 2,
      transactionIndex: 0,
      blockTime: 2,
      err: false,
      raw,
    } as FetchedLeaderTx);
    expect(summary.programs).toContain(JUP);
  });
});
