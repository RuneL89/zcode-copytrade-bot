import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@zcode-bot/config';
import * as repo from '@zcode-bot/db/repo.js';
import { StaticPriceProvider } from '@zcode-bot/providers';
import { Runtime } from '../src/runtime.js';

const LEADER = 'LeaderWallet1111111111111111111111111111111111';
const MEOW = 'MeowMint111111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/**
 * A jsonParsed version-1 swap the public node returns when the client claims
 * support for it. Version 0 clients get an RPC error instead of this body.
 */
function version1Buy(blockTime: number) {
  return {
    slot: 100,
    transactionIndex: 0,
    blockTime,
    version: 1,
    transaction: {
      signatures: ['buy'],
      message: {
        accountKeys: [
          { pubkey: LEADER, signer: true },
          { pubkey: 'Ata111111111111111111111111111111111111111', signer: false },
        ],
        instructions: [{ programId: JUP }],
      },
    },
    meta: {
      err: null,
      preBalances: [1_000_000, 0],
      postBalances: [1_000_000, 0],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: LEADER, uiTokenAmount: { amount: '20000000', decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: LEADER, uiTokenAmount: { amount: '8000000', decimals: 6 } },
        { accountIndex: 1, mint: MEOW, owner: LEADER, uiTokenAmount: { amount: '5000000', decimals: 6 } },
      ],
      innerInstructions: [],
    },
  };
}

describe('activity refresh verifies a readable public wallet', () => {
  let dir: string;
  let rt: Runtime;
  let previousFetch: typeof fetch;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'zcode-activity-'));
    const config = loadConfig({
      SESSION_SECRET: 'a'.repeat(48),
      DATA_DIR: dir,
      MODE: 'paper',
      PUBLIC_SOLANA_RPC_URL: 'https://public.test',
    });
    config.env.DATA_DIR = dir;
    rt = new Runtime(config);
    repo.upsertCandidate(rt.db.db, {
      candidateId: 'cand_vocal',
      handle: 'VocalNavalPony',
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: null,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: 'test',
      observedAt: new Date().toISOString(),
    });
    repo.upsertCandidateAddress(rt.db.db, 'cand_vocal', {
      chain: 'solana',
      address: LEADER,
      verification: 'unverified',
    });
    (rt as unknown as { priceProvider: StaticPriceProvider }).priceProvider = new StaticPriceProvider(
      new Map([[MEOW, 200_000_000n]]),
    );
    const nowSec = Math.floor(Date.now() / 1000);
    previousFetch = globalThis.fetch;
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
              blockTime: nowSec - n * 60,
              err: null,
            })),
          }),
          { status: 200 },
        );
      }
      if (method === 'getTransaction') {
        const version = params[1]?.maxSupportedTransactionVersion ?? 0;
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
        return new Response(JSON.stringify({ jsonrpc: '2.0', result: version1Buy(nowSec - 60) }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected ' + method } }), { status: 200 });
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks the address verified when the public node can read the swaps', async () => {
    const result = await rt.activityRefreshNow();
    expect(result).toEqual({ checked: 1, verified: 1, failed: 0 });
    const address = repo.listCandidateAddresses(rt.db.db, 'cand_vocal')[0];
    expect(address?.verification).toBe('verified');
  });
});
