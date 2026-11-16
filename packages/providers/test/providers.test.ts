import { describe, expect, it } from 'vitest';
import { parseManualCsv, parseManualJson } from '../src/leaderboard/import.js';
import { parseDisplayedPnl, robotsDisallows } from '../src/leaderboard/fomo-web.js';
import { HeliusProvider, signatureOf, type FetchedLeaderTx } from '../src/solana/helius.js';
import { PublicSolanaProvider } from '../src/solana/publicRpc.js';
import { JupiterProvider } from '../src/solana/jupiter.js';
import { measureCopyableActivity, type LeaderTxSummary } from '@zcode-bot/core';

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

  it('health probe sends a taker so /build does not answer 400', async () => {
    const previous = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          inAmount: '1000000',
          outAmount: '1000000',
          priceImpactPct: '0',
          slippageBps: 100,
          routePlan: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const result = await new JupiterProvider('https://api.jup.ag', '').healthCheck();
      expect(result.ok).toBe(true);
      expect(urls[0]).toContain('taker=11111111111111111111111111111111');
    } finally {
      globalThis.fetch = previous;
    }
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

describe('public RPC wallet activity', () => {
  const leader = 'LeaderWallet1111111111111111111111111111111111';
  const PUBJUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL = 'So11111111111111111111111111111111111111112';
  const MEOW = 'MeowMint111111111111111111111111111111111111111';
  const NOW = Date.parse('2026-10-31T12:00:00Z');

  function summaryOf(raw: object, minutesAgo: number, sig = 'sig'): LeaderTxSummary {
    return HeliusProvider.toLeaderTxSummary(leader, {
      signature: sig,
      slot: 100,
      transactionIndex: 0,
      blockTime: Math.floor((NOW - minutesAgo * 60_000) / 1000),
      err: false,
      raw,
    } as FetchedLeaderTx);
  }

  /** Same fixture through the signer-attributed summarizer (the activity path). */
  function signedOf(raw: object, minutesAgo: number, sig = 'sig'): LeaderTxSummary {
    const clone = structuredClone(raw) as {
      transaction?: { message?: { accountKeys?: Array<string | { pubkey: string; signer?: boolean }> } };
    };
    for (const key of clone.transaction?.message?.accountKeys ?? []) {
      if (typeof key !== 'string' && key.pubkey === leader) key.signer = true;
    }
    const summary = HeliusProvider.toSignerTxSummary(leader, {
      signature: sig,
      slot: 100,
      transactionIndex: 0,
      blockTime: Math.floor((NOW - minutesAgo * 60_000) / 1000),
      err: false,
      raw: clone,
    } as FetchedLeaderTx);
    if (!summary) throw new Error('fixture must be signed by the leader');
    return summary;
  }

  const buyRaw = {
    transaction: {
      signatures: ['buy'],
      message: {
        accountKeys: [{ pubkey: leader }, { pubkey: 'Ata111111111111111111111111111111111111111' }],
        instructions: [{ programId: PUBJUP }],
      },
    },
    meta: {
      err: null,
      preBalances: [1_000_000, 0],
      postBalances: [1_000_000, 0],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: leader, uiTokenAmount: { amount: '20000000', decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: leader, uiTokenAmount: { amount: '8000000', decimals: 6 } },
        { accountIndex: 1, mint: MEOW, owner: leader, uiTokenAmount: { amount: '5000000', decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
  const sellRaw = {
    transaction: {
      signatures: ['sell'],
      message: { accountKeys: [{ pubkey: leader }], instructions: [{ programId: PUBJUP }] },
    },
    meta: {
      err: null,
      preBalances: [0],
      postBalances: [0],
      preTokenBalances: [
        { accountIndex: 0, mint: MEOW, owner: leader, uiTokenAmount: { amount: '5000000', decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint: MEOW, owner: leader, uiTokenAmount: { amount: '1000000', decimals: 6 } },
        { accountIndex: 0, mint: USDC, owner: leader, uiTokenAmount: { amount: '9000000', decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
  const airdropRaw = {
    transaction: {
      signatures: ['drop'],
      message: { accountKeys: [{ pubkey: leader }], instructions: [] },
    },
    meta: {
      err: null,
      preBalances: [0],
      postBalances: [0],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 0, mint: MEOW, owner: leader, uiTokenAmount: { amount: '777', decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
  // Swap-like balances but no known swap program -> SKIPPED_AMBIGUOUS.
  const ambiguousRaw = {
    transaction: {
      signatures: ['amb'],
      message: { accountKeys: [{ pubkey: leader }], instructions: [] },
    },
    meta: {
      err: null,
      preBalances: [0],
      postBalances: [0],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 0, mint: MEOW, owner: leader, uiTokenAmount: { amount: '5000000', decimals: 6 } },
        { accountIndex: 0, mint: USDC, owner: leader, uiTokenAmount: { amount: '5000000', decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
  // WSOL movement only (funding legs, no token leg) -> SKIPPED_STABLE_TO_STABLE.
  const wrapRaw = {
    transaction: {
      signatures: ['wrap'],
      message: { accountKeys: [{ pubkey: leader }], instructions: [{ programId: PUBJUP }] },
    },
    meta: {
      err: null,
      preBalances: [2_000_000],
      postBalances: [2_000_000],
      preTokenBalances: [
        { accountIndex: 0, mint: WSOL, owner: leader, uiTokenAmount: { amount: '1000000000', decimals: 9 } },
      ],
      postTokenBalances: [
        { accountIndex: 0, mint: WSOL, owner: leader, uiTokenAmount: { amount: '2000000000', decimals: 9 } },
      ],
      innerInstructions: [],
    },
  };

  it('measures copyable coin movements, not transactions or buy/sell verdicts', () => {
    // Prices: MEOW at $0.20 (5e6 base @ 6dp = $1.00) and USDC is the funding leg.
    const priceOf = (mint: string) => (mint === MEOW ? 200_000_000n : null);
    const sample = measureCopyableActivity(
      [
        signedOf(airdropRaw, 5, 'drop'),
        signedOf(buyRaw, 30, 'buy'),
        signedOf(sellRaw, 90, 'sell'),
        signedOf(ambiguousRaw, 100, 'amb'),
        signedOf(wrapRaw, 110, 'wrap'),
      ],
      { nowMs: NOW, lookbackHours: 24, minTradeUsdMicro: 1_000_000n, priceOf },
    );
    // buy = MEOW in funded by USDC out (+5e6 MEOW = $1.00) → the one funded buy.
    // sell = MEOW out against USDC in → one funded sell.
    // airdrop = MEOW in (+777 → dust, and no funding leg).
    // ambiguous = MEOW in AND USDC in: two inflows, no funding leg paid — a
    // movement, never a funded buy (the D4 definition).
    // wrap = WSOL only (funding leg).
    expect(sample.entries24h).toBe(1);
    expect(sample.exits24h).toBe(1);
    expect(sample.copyableTrades24h).toBe(3); // buy, sell, ambiguous all moved a coin
    expect(sample.lastEntryAt).toBe(new Date(NOW - 30 * 60_000).toISOString());
    expect(sample.lastTradeAt).toBe(new Date(NOW - 30 * 60_000).toISOString());
    expect(sample.scannedTxs).toBe(5);
  });

  it('stops at the lookback boundary and reports an empty wallet as zeros', () => {
    const sample = measureCopyableActivity([signedOf(buyRaw, 3 * 60, 'buy-old')], {
      nowMs: NOW,
      lookbackHours: 2,
      minTradeUsdMicro: 1_000_000n,
      priceOf: (mint: string) => (mint === MEOW ? 200_000_000n : null),
    });
    expect(sample.copyableTrades24h).toBe(0);
    expect(sample.entries24h).toBe(0);
    expect(sample.lastEntryAt).toBeNull();
    expect(sample.scannedTxs).toBe(0);
    expect(
      measureCopyableActivity([], {
        nowMs: NOW,
        lookbackHours: 24,
        minTradeUsdMicro: 1_000_000n,
        priceOf: () => null,
      }).scannedTxs,
    ).toBe(0);
  });

  it('walletActivity classifies through a stubbed public node', async () => {
    const at = (minutesAgo: number) => Math.floor((NOW - minutesAgo * 60_000) / 1000);
    const signedBody = (raw: object, blockTime: number) => {
      const clone = structuredClone(raw) as {
        transaction?: { message?: { accountKeys?: Array<string | { pubkey: string; signer?: boolean }> } };
      };
      for (const key of clone.transaction?.message?.accountKeys ?? []) {
        if (typeof key !== 'string' && key.pubkey === leader) key.signer = true;
      }
      return { jsonrpc: '2.0', result: { ...clone, slot: 100, transactionIndex: 0, blockTime } };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const { method, params } = JSON.parse(init?.body ?? '{}') as { method: string; params: unknown[] };
      if (method === 'getSignaturesForAddress') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            result: [
              { signature: 'drop', slot: 100, blockTime: at(5), err: null },
              { signature: 'buy', slot: 99, blockTime: at(30), err: null },
            ],
          }),
          { status: 200 },
        );
      }
      if (method === 'getTransaction') {
        const sig = params[0] as string;
        return sig === 'drop'
          ? new Response(JSON.stringify(signedBody(airdropRaw, at(5))), { status: 200 })
          : new Response(JSON.stringify(signedBody(buyRaw, at(30))), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected' } }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = new PublicSolanaProvider('https://public.test', 1);
      const res = await provider.walletActivity(leader, {
        lookbackHours: 24,
        maxTxScans: 10,
        // The stub's block times are anchored to NOW; measuring against the
        // real clock would fall outside the 24h window a day after NOW.
        nowMs: NOW,
        priceOf: async (mint) => (mint === MEOW ? 200_000_000n : null),
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        // Buy = MEOW in (entry); the airdrop's +777 base is $0.0002 → dust.
        expect(res.entries24h).toBe(1);
        expect(res.exits24h).toBe(0);
        expect(res.lastEntryAt).not.toBeNull();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reads a version 1 public transaction instead of treating it as unreadable', async () => {
    const at = (minutesAgo: number) => Math.floor((NOW - minutesAgo * 60_000) / 1000);
    const originalFetch = globalThis.fetch;
    const versions: number[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const { method, params } = JSON.parse(init?.body ?? '{}') as {
        method: string;
        params: [string, { maxSupportedTransactionVersion?: number }?];
      };
      if (method === 'getSignaturesForAddress') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            result: [1, 2, 3].map((n) => ({
              signature: `buy-${n}`,
              slot: 100,
              blockTime: at(n),
              err: null,
            })),
          }),
          { status: 200 },
        );
      }
      const version = params[1]?.maxSupportedTransactionVersion ?? 0;
      versions.push(version);
      // Live public nodes reject version 1 swaps when the client only claims version 0.
      if (version < 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: -32015,
              message:
                'Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1',
            },
          }),
          { status: 200 },
        );
      }
      const body = structuredClone(buyRaw) as {
        transaction?: { message?: { accountKeys?: Array<{ pubkey: string; signer?: boolean }> } };
      };
      for (const key of body.transaction?.message?.accountKeys ?? []) {
        if (key.pubkey === leader) key.signer = true;
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          result: { ...body, slot: 100, transactionIndex: 0, blockTime: at(1), version: 1 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const provider = new PublicSolanaProvider('https://public.test', 1);
      const res = await provider.walletActivity(leader, {
        lookbackHours: 24,
        maxTxScans: 10,
        nowMs: NOW,
        priceOf: async (mint) => (mint === MEOW ? 200_000_000n : null),
      });
      expect(versions.every((version) => version >= 1)).toBe(true);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.copyableTrades24h).toBeGreaterThanOrEqual(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('walletActivity fails open on a broken public node (never throws)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    try {
      const provider = new PublicSolanaProvider('https://public.test', 1);
      await expect(provider.walletActivity(leader)).resolves.toMatchObject({ ok: false });
      await expect(provider.healthCheck()).resolves.toMatchObject({ ok: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('walletActivity fails closed when signatures exist but no transaction is readable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const { method } = JSON.parse(init?.body ?? '{}') as { method: string };
      if (method === 'getSignaturesForAddress') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            result: [
              {
                signature: 'unreadable',
                slot: 1,
                blockTime: Math.floor(NOW / 1000) - 60,
                err: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (method === 'getTransaction') {
        // Pruned / not-yet-indexed reads are null, not "no swap".
        return new Response(JSON.stringify({ jsonrpc: '2.0', result: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected' } }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = new PublicSolanaProvider('https://public.test', 1);
      await expect(provider.walletActivity(leader, { nowMs: NOW })).resolves.toMatchObject({
        ok: false,
        reason: 'all transactions unreadable',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
