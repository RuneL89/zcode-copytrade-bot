import {
  DEFAULT_MIN_TRADE_USD_MICRO,
  measureCopyableActivity,
  STABLE_MINTS,
  WRAPPED_SOL_MINT,
  type CopyableActivitySample,
  type LeaderTxSummary,
} from '@zcode-bot/core';
import { HeliusProvider, signatureOf, type FetchedLeaderTx } from './helius.js';

/**
 * Free public Solana JSON-RPC client (default: api.mainnet-beta.solana.com).
 *
 * Two operator decisions shape this file (2026-11-01):
 *
 * 1. Activity is measured as COPYABLE COIN MOVEMENTS, not transactions and not
 *    buy/sell verdicts: any tx the leader signs that moves a priceable,
 *    non-funding mint counts, whatever the quote asset. Attribution is by
 *    signer, so trades routed through program/PDA accounts are still seen —
 *    but only as activity, never as an entry (we cannot attribute their size).
 * 2. A coin only counts if it is copyable (a price/route quote exists) and the
 *    movement clears the $1 floor. That is what stops fee payouts, dust and
 *    spam from looking like a trader.
 *
 * `walletActivity` also bounds every HTTP request with a timeout: a stalled
 * response used to hang the whole refresh indefinitely (observed repeatedly).
 */

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Highest transaction version the public node should return. `0` rejects
 * version 1, which current Jupiter swaps use, and the node answers
 * "Transaction version (1) is not supported". 255 is what this client used
 * before that regression and what the public node accepts.
 */
const MAX_TX_VERSION = 255;
const DEFAULT_MAX_TX_SCANS = 100;
const DEFAULT_MAX_PRICE_MINTS = 5;
const PAGE_SLEEP_MS = 300;
const TX_SLEEP_MS = 120;
/** Wall-clock budget for fetching transactions: a 429 storm must not hang a refresh. */
const DEFAULT_FETCH_BUDGET_MS = 20_000;
/** Stop fetching once this many readable transactions are in hand. */
const EARLY_STOP_SUMMARIES = 40;

export type WalletActivityResult = ({ ok: true } & CopyableActivitySample) | { ok: false; reason?: string };

export interface WalletActivityOptions {
  lookbackHours?: number;
  /** How many of the newest in-window transactions to fetch and inspect. */
  maxTxScans?: number;
  /** How many distinct coins to ask the price source about, per check. */
  maxPriceMints?: number;
  /** Movements worth less than this are dust. */
  minTradeUsdMicro?: bigint;
  /** Micro-USD price of one whole token, or null when the coin is not copyable. */
  priceOf?: (mint: string, decimals: number) => Promise<bigint | null>;
  /** Injectable clock for tests. */
  nowMs?: number;
  /** Wall-clock budget for the transaction-fetch loop (default 20s). */
  fetchBudgetMs?: number;
}

const TRANSIENT_RPC_ERRORS = /long-term storage|too many requests|ledger/i;

function isFundingMint(mint: string): boolean {
  return STABLE_MINTS.has(mint) || mint === WRAPPED_SOL_MINT;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export class PublicSolanaProvider {
  readonly name = 'public-solana';
  private rpcId = 0;

  constructor(
    private endpoint = 'https://api.mainnet-beta.solana.com',
    private maxAttempts = 4,
    /**
     * Optional Helius-backed transaction reader. When present, transactions are
     * fetched in pages of up to 100 (2-3 requests for a full sample) instead of
     * one getTransaction per signature — the public node rate-limits the latter
     * into an unusable 3-4 transaction sample. Signatures, attribution and
     * counting stay identical either way.
     */
    private txFetcher?: {
      configured: boolean;
      recentTransactions: (
        address: string,
        opts?: { limit?: number; before?: string },
      ) => Promise<
        Array<{
          signature: string;
          slot: number;
          transactionIndex: number;
          blockTime: number | null;
          err: boolean;
          raw: Record<string, unknown>;
        }>
      >;
    },
  ) {}

  get configured(): boolean {
    return this.endpoint.trim().length > 0;
  }

  /** Native SOL balance. Null on any failure so the caller can try a paid fallback. */
  async getBalanceLamports(address: string): Promise<number | null> {
    try {
      const result = await this.rpc<{ value: number }>('getBalance', [address]);
      return typeof result?.value === 'number' ? result.value : null;
    } catch {
      return null;
    }
  }

  /** Sum of token accounts for one mint. Null on failure. */
  async tokenBalanceBase(mint: string, owner: string): Promise<bigint | null> {
    try {
      const result = await this.rpc<{
        value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
      }>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
      let total = 0n;
      for (const account of result?.value ?? []) {
        total += BigInt(account.account.data.parsed.info.tokenAmount.amount);
      }
      return total;
    } catch {
      return null;
    }
  }

  /** JSON-RPC with a hard per-request timeout and bounded retry on transient failures. */
  private async rpc<T>(method: string, params: unknown): Promise<T> {
    if (!this.configured) throw new Error('public-solana: endpoint not configured');
    let lastError: Error = new Error('public-solana: request failed');
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) await sleep(1500 * attempt);
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
          // Without this a stalled connection blocked the whole refresh forever.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        lastError = new Error('public-solana: ' + (e as Error).message);
        continue; // timeout/network: retryable
      }
      if (res.status === 429 || res.status === 503) {
        // A rate limit is not transient for this caller: the free node shares
        // an IP and throttles the whole process. Retrying here burned minutes
        // per wallet and stalled a watch pass; fall back to Helius instead.
        throw new Error(`public-solana: rate limited (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(`public-solana: HTTP ${res.status}`);
      let json: { result?: T; error?: { message: string } };
      try {
        json = (await res.json()) as { result?: T; error?: { message: string } };
      } catch (e) {
        lastError = new Error('public-solana: unreadable response body');
        continue;
      }
      if (json.error) {
        const message = 'public-solana: ' + json.error.message;
        if (TRANSIENT_RPC_ERRORS.test(json.error.message)) {
          lastError = new Error(message);
          continue;
        }
        throw new Error(message);
      }
      return json.result as T;
    }
    throw lastError;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      await this.rpc<{ context: unknown; value: unknown }>('getLatestBlockhash', []);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, detail: (e as Error).message };
    }
  }

  /**
   * Newest-first signature page for one address (the D5 watch-list poll's
   * cheap half: signatures first, details only for what is new). Throws on a
   * transport failure — the caller then falls back to Helius.
   */
  async recentSignatures(
    address: string,
    limit = 25,
  ): Promise<Array<{ signature: string; slot: number; blockTime: number | null }>> {
    const rows = await this.rpc<
      Array<{ signature: string; slot: number; blockTime: number | null; err: null | object }>
    >('getSignaturesForAddress', [address, { limit }]);
    return (rows ?? []).filter((r) => Boolean(r.signature));
  }

  /**
   * One signature's detail, signer-attributed, through the free node. Null
   * when the transaction is unreadable or was not signed by the address.
   */
  async transactionSummary(address: string, signature: string): Promise<LeaderTxSummary | null> {
    const tx = await this.rpc<Record<string, unknown> | null>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' },
    ]);
    if (!tx) return null;
    const meta = tx.meta as { err?: unknown } | undefined;
    return HeliusProvider.toSignerTxSummary(address, {
      signature: signatureOf({
        signature,
        transaction: tx.transaction as { signatures?: string[] },
      }),
      slot: (tx.slot as number) ?? 0,
      transactionIndex: (tx.transactionIndex as number) ?? 0,
      blockTime: (tx.blockTime as number | null) ?? null,
      err: meta?.err != null,
      raw: tx,
    });
  }

  /**
   * Copyable-activity sample for one wallet over the lookback window.
   *
   * 1. Signature walk (newest-first, stops at the window edge) — up to 500 rows.
   * 2. Fetch and signer-attribute at most `maxTxScans` transactions.
   * 3. Price at most `maxPriceMints` of the coins that moved (one quote each).
   * 4. Count entries/exits/trades with `measureCopyableActivity`.
   *
   * Fail-open contract: never throws; transport failure resolves `{ ok: false }`.
   */
  async walletActivity(address: string, opts: WalletActivityOptions = {}): Promise<WalletActivityResult> {
    const lookbackHours = opts.lookbackHours ?? 24;
    const maxTxScans = opts.maxTxScans ?? DEFAULT_MAX_TX_SCANS;
    const maxPriceMints = opts.maxPriceMints ?? DEFAULT_MAX_PRICE_MINTS;
    const minTradeUsdMicro = opts.minTradeUsdMicro ?? DEFAULT_MIN_TRADE_USD_MICRO;
    // One clock for the whole read: the window cutoff must honour the injected
    // clock, or a test that pins `nowMs` silently measures an empty window.
    const nowMs = opts.nowMs ?? Date.now();
    try {
      const cutoffSec = Math.floor(nowMs / 1000) - lookbackHours * 3600;

      // Public signatures and getTransaction only. A Helius full-history page
      // is not a fallback: that call is reserved for one-off vetting.
      void this.txFetcher;
      const signatures: Array<{ signature: string; slot: number; blockTime: number }> = [];
      let before: string | undefined;
      for (let page = 0; page < 5; page++) {
        const rows = await this.rpc<
          Array<{ signature: string; slot: number; blockTime: number | null; err: null | object }>
        >('getSignaturesForAddress', [address, { limit: 100, ...(before ? { before } : {}) }]);
        if (!Array.isArray(rows) || rows.length === 0) break;
        let sawOlder = false;
        for (const row of rows) {
          if (row.blockTime === null || row.blockTime < cutoffSec) {
            sawOlder = true;
            continue;
          }
          if (!row.signature) continue;
          // Failed signatures are kept: they are counted by the sampler as
          // inspected-but-not-a-trade, never as activity.
          signatures.push({ signature: row.signature, slot: row.slot, blockTime: row.blockTime });
        }
        if (sawOlder || rows.length < 100) break;
        before = rows[rows.length - 1]!.signature;
        if (page < 4) await sleep(PAGE_SLEEP_MS);
      }

      if (signatures.length === 0) {
        return {
          ok: true,
          copyableTrades24h: 0,
          entries24h: 0,
          exits24h: 0,
          unattributedTrades24h: 0,
          lastTradeAt: null,
          lastEntryAt: null,
          pricedMints: 0,
          unbuyableMints: 0,
          scannedTxs: 0,
        };
      }

      const summaries: LeaderTxSummary[] = [];
      const decimalsByMint = new Map<string, number>();
      const fetchStartedAt = Date.now();
      const budgetMs = opts.fetchBudgetMs ?? DEFAULT_FETCH_BUDGET_MS;
      let fetched = 0;
      let failedTxs = 0;
      for (const row of signatures.slice(0, maxTxScans)) {
        // Budget guard: under a 429 storm each request can burn several seconds
        // of backoff, and an unbounded loop is exactly what used to hang the
        // whole activity refresh.
        if (Date.now() - fetchStartedAt > budgetMs) break;
        if (summaries.length >= EARLY_STOP_SUMMARIES) break;
        let tx: Record<string, unknown> | null;
        try {
          tx = await this.rpc<Record<string, unknown> | null>('getTransaction', [
            row.signature,
            {
              encoding: 'jsonParsed',
              maxSupportedTransactionVersion: MAX_TX_VERSION,
              commitment: 'confirmed',
            },
          ]);
        } catch {
          failedTxs++;
          continue;
        }
        await sleep(TX_SLEEP_MS);
        if (!tx) continue; // pruned or not yet readable — skip, never guess
        fetched++;
        const meta = tx.meta as { err?: unknown } | undefined;
        const leaderTx: FetchedLeaderTx = {
          signature: signatureOf({
            signature: row.signature,
            transaction: tx.transaction as { signatures?: string[] },
          }),
          slot: (tx.slot as number) ?? row.slot,
          transactionIndex: (tx.transactionIndex as number) ?? 0,
          blockTime: (tx.blockTime as number | null) ?? row.blockTime,
          err: meta?.err != null,
          raw: tx,
        };
        // Signer attribution: only transactions this wallet authorised count.
        const summary = HeliusProvider.toSignerTxSummary(address, leaderTx);
        if (!summary) continue;
        summaries.push(summary);
        const collect = (
          list: Array<{ mint: string; uiTokenAmount?: { decimals?: number } }> | undefined,
        ) => {
          for (const b of list ?? []) {
            if (typeof b.uiTokenAmount?.decimals === 'number')
              decimalsByMint.set(b.mint, b.uiTokenAmount.decimals);
          }
        };
        collect((tx.meta as { preTokenBalances?: [] })?.preTokenBalances);
        collect((tx.meta as { postTokenBalances?: [] })?.postTokenBalances);
      }
      if (fetched === 0 && failedTxs > 0) return { ok: false, reason: 'all transactions unreadable' };
      return this.sample(
        summaries,
        decimalsByMint,
        opts,
        lookbackHours,
        maxPriceMints,
        minTradeUsdMicro,
        maxTxScans,
      );
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /**
   * Shared tail of every activity read: choose the coins worth pricing (most
   * frequently moved, then biggest), price at most opts.maxPriceMints of them,
   * and run the copyable-activity measure. Both the batch and per-transaction
   * fetch paths end here so they can never disagree about counting.
   */
  private async sample(
    summaries: LeaderTxSummary[],
    decimalsByMint: Map<string, number>,
    opts: WalletActivityOptions,
    lookbackHours: number,
    maxPriceMints: number,
    minTradeUsdMicro: bigint,
    maxTxScans: number,
  ): Promise<WalletActivityResult> {
    const weights = new Map<string, { count: number; maxAbs: bigint }>();
    const bump = (mint: string, delta: bigint) => {
      if (isFundingMint(mint)) return;
      const w = weights.get(mint) ?? { count: 0, maxAbs: 0n };
      w.count++;
      if (absBig(delta) > w.maxAbs) w.maxAbs = absBig(delta);
      weights.set(mint, w);
    };
    for (const s of summaries) {
      for (const leg of s.tokenDeltas) if (leg.deltaBase !== 0n) bump(leg.mint, leg.deltaBase);
      for (const mint of s.foreignTokenMints ?? []) bump(mint, 0n);
    }
    const chosen = [...weights.entries()]
      .sort((a, b) => b[1].count - a[1].count || (b[1].maxAbs > a[1].maxAbs ? 1 : -1))
      .slice(0, maxPriceMints)
      .map(([mint]) => mint);

    const prices = new Map<string, bigint>();
    if (opts.priceOf) {
      for (const mint of chosen) {
        try {
          const p = await opts.priceOf(mint, decimalsByMint.get(mint) ?? 6);
          if (p !== null && p > 0n) prices.set(mint, p);
        } catch {
          // Unpriceable coin: not copyable. Counted as unbuyable by the sampler.
        }
      }
    }

    const sample = measureCopyableActivity(summaries, {
      nowMs: opts.nowMs ?? Date.now(),
      lookbackHours,
      minTradeUsdMicro,
      maxTradeScan: maxTxScans,
      priceOf: (mint) => prices.get(mint) ?? null,
    });
    return { ok: true, ...sample };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
