import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { evaluateP1Acceptance, liveStartDecision } from '@zcode-bot/core';
import type { JupiterProvider } from '@zcode-bot/providers';
import { generateWalletFile, loadWalletSecret } from '../src/wallet.js';
import { LiveExecutor, type IntentSpec } from '../src/services/executors.js';
import { sendSignedTransaction } from '../src/services/sendPath.js';
import { assembleJupiterBuild, withSenderTip } from '../src/services/txBuild.js';

describe('live start gate', () => {
  it('refuses to sign unless LIVE_TRADING is on and the P1 checks pass', () => {
    expect(
      liveStartDecision({ mode: 'paper', liveTrading: false, acceptanceOk: false, failures: ['x'] }),
    ).toEqual({
      start: true,
      signing: false,
    });
    expect(
      liveStartDecision({ mode: 'live', liveTrading: false, acceptanceOk: false, failures: ['x'] }),
    ).toEqual({
      start: true,
      signing: false,
    });
    const refused = liveStartDecision({
      mode: 'live',
      liveTrading: true,
      acceptanceOk: false,
      failures: ['budget'],
    });
    expect(refused.start).toBe(false);
    if (!refused.start) expect(refused.reason).toContain('budget');
    expect(liveStartDecision({ mode: 'live', liveTrading: true, acceptanceOk: true, failures: [] })).toEqual({
      start: true,
      signing: true,
    });
  });

  // The acceptance replay is CPU-heavy; 15s is flaky when the whole server
  // suite collects in parallel on a loaded desktop.
  it('the shipped P1 checks pass', () => {
    expect(evaluateP1Acceptance().ok).toBe(true);
  }, 45_000);
});

describe('send ladder', () => {
  const body = 'signed';
  function json(result?: string, status = 200, error?: string): Response {
    return new Response(JSON.stringify(error ? { error: { message: error } } : { result }), { status });
  }

  it('stops at Sender when that endpoint returns a signature', async () => {
    const calls: string[] = [];
    const out = await sendSignedTransaction({
      signedBase64: body,
      heliusRpcUrl: 'https://helius.example',
      publicRpcUrl: 'https://public.example',
      apiKey: 'k',
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return json('sender-sig');
      }) as typeof fetch,
    });
    expect(out).toEqual({ kind: 'sent', signature: 'sender-sig', via: 'sender' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('swqos_only=true');
  });

  it('falls through to staked then public only when no signature came back', async () => {
    const calls: string[] = [];
    let staked = 0;
    const out = await sendSignedTransaction({
      signedBase64: body,
      heliusRpcUrl: 'https://helius.example',
      publicRpcUrl: 'https://public.example',
      apiKey: 'k',
      onStakedSend: () => {
        staked++;
      },
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('sender')) return json(undefined, 400, 'missing tip');
        if (String(url).includes('helius')) return json(undefined, 429, 'rate limited');
        return json('public-sig');
      }) as typeof fetch,
    });
    expect(out).toEqual({ kind: 'sent', signature: 'public-sig', via: 'public' });
    expect(staked).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('does not submit a second copy after a transport error', async () => {
    let calls = 0;
    const out = await sendSignedTransaction({
      signedBase64: body,
      heliusRpcUrl: 'https://helius.example',
      publicRpcUrl: 'https://public.example',
      apiKey: '',
      fetchImpl: (async () => {
        calls++;
        throw new Error('socket hang up');
      }) as typeof fetch,
    });
    expect(out.kind).toBe('unknown');
    expect(calls).toBe(1);
  });
});

describe('jupiter build assembly and wallet file', () => {
  it('assembles instructions into a transaction and can add the SWQOS tip', () => {
    const payer = Keypair.generate().publicKey;
    const program = SystemProgram.programId.toBase58();
    const built = assembleJupiterBuild(
      {
        swapInstruction: {
          programId: program,
          accounts: [{ pubkey: payer.toBase58(), isSigner: true, isWritable: true }],
          data: Buffer.from([2, 0, 0, 0]).toString('base64'),
        },
      },
      '11111111111111111111111111111111',
      payer.toBase58(),
    );
    expect(built.length).toBeGreaterThan(10);
    const tipped = withSenderTip(built, payer.toBase58(), '11111111111111111111111111111111');
    expect(tipped).toBeTruthy();
    expect(tipped).not.toBe(built);
  });

  it('skips the staked send when the governor refuses the credit', async () => {
    const calls: string[] = [];
    const out = await sendSignedTransaction({
      signedBase64: 'signed',
      heliusRpcUrl: 'https://helius.example',
      publicRpcUrl: 'https://public.example',
      apiKey: 'k',
      allowStaked: () => false,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('sender')) {
          return new Response(JSON.stringify({ error: { message: 'no tip' } }), { status: 400 });
        }
        return new Response(JSON.stringify({ result: 'public-sig' }), { status: 200 });
      }) as typeof fetch,
    });
    expect(out).toEqual({ kind: 'sent', signature: 'public-sig', via: 'public' });
    expect(calls.some((url) => url.includes('helius.example'))).toBe(false);
  });

  it('signs a /build transaction and hands it to the send ladder', async () => {
    const signer = Keypair.generate();
    const built = assembleJupiterBuild(
      {
        swapInstruction: {
          programId: SystemProgram.programId.toBase58(),
          accounts: [{ pubkey: signer.publicKey.toBase58(), isSigner: true, isWritable: true }],
          data: Buffer.from([2, 0, 0, 0]).toString('base64'),
        },
      },
      '11111111111111111111111111111111',
      signer.publicKey.toBase58(),
    );
    const calls: boolean[] = [];
    const executor = new LiveExecutor(
      {
        quote: async () => ({
          inAmount: '1',
          outAmount: '2',
          priceImpactPct: '0',
          slippageBps: 50,
          routePlan: [],
          swapTransaction: built,
        }),
        buildSwap: async () => {
          throw new Error('buildSwap should not run when /build already returned a transaction');
        },
      } as unknown as JupiterProvider,
      'http://fake',
      signer.secretKey,
      signer.publicKey.toBase58(),
      () => ({
        sendRawTransaction: async () => {
          throw new Error('raw send should not run');
        },
        getLatestBlockhash: async () => ({
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 9,
        }),
        confirmTransaction: async () => ({ value: { err: null } }),
        getParsedTokenAccountsByOwner: async () => ({ value: [] }),
        getBalance: async () => 0,
      }),
      async (args) => {
        calls.push(args.trySender);
        expect(args.path).toBe('exit');
        expect(args.signedBase64.length).toBeGreaterThan(20);
        return { kind: 'sent', signature: 'sig-live', via: 'sender' };
      },
    );
    const spec: IntentSpec = {
      intentId: 'i',
      kind: 'exit',
      inputMint: 'mint',
      outputMint: 'usdc',
      inputAmountBase: '1',
      inputDecimals: 6,
      outputDecimals: 6,
      inputUsdMicro: '1000000',
      slippageBpsCap: 50,
      userPublicKey: null,
    };
    const out = await executor.execute(spec, {} as never);
    expect(out.kind).toBe('filled');
    expect(calls).toEqual([true]);
  });

  it('unlocks WALLET_FILE with COPYDESK_WALLET_PASSPHRASE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copydesk-wallet-'));
    const passphrase = 'a-local-passphrase';
    const created = generateWalletFile(dir, passphrase);
    const secret = loadWalletSecret(dir, passphrase, created.file);
    expect(secret.length).toBe(64);
    expect(PublicKey).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});
