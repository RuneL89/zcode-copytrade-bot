import type { LeaderTxSummary, TokenDelta } from '@zcode-bot/core';

/**
 * Helius Solana monitor.
 *
 * Uses the Helius-exclusive `getTransactionsForAddress` RPC (the currently
 * documented polling method; the legacy Enhanced Transactions API is
 * deprecated and intentionally not used). Polling is the baseline — no paid
 * streaming is required. A webhook adapter can feed the same interface.
 */

export interface LeaderCursor {
  lastSignature: string;
  lastSlot: number;
  lastTransactionIndex: number;
  lastBlockTime: number | null;
}

export interface FetchedLeaderTx {
  signature: string;
  slot: number;
  transactionIndex: number;
  blockTime: number | null;
  err: boolean;
  raw: unknown;
}

/**
 * Extract the transaction signature regardless of which Helius detail mode was
 * requested. Measured 2026-10-28:
 *   transactionDetails: 'signatures' -> row.signature
 *   transactionDetails: 'full'       -> row.transaction.signatures[0]  (NO top-level field)
 * Missing this made every polled swap carry signature undefined, which failed
 * the observed_leader_events NOT NULL constraint and silently stalled copying.
 */
export function signatureOf(row: {
  signature?: string | null;
  transaction?: { signatures?: string[] } | null;
}): string {
  return (row.signature ?? row.transaction?.signatures?.[0] ?? '').trim();
}

export class HeliusProvider {
  readonly name = 'helius';
  private rpcId = 0;

  constructor(
    private apiKey: string,
    private baseUrl = 'https://mainnet.helius-rpc.com',
  ) {}

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  get configured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  private url(): string {
    return `${this.baseUrl}/?api-key=${encodeURIComponent(this.apiKey)}`;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (!this.configured) throw new Error('helius: API key not configured');
    const res = await fetch(this.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    });
    if (res.status === 429) throw new Error('helius: rate limited (429); backing off');
    if (!res.ok) throw new Error(`helius: HTTP ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: { message: string } };
    if (json.error) throw new Error(`helius: ${json.error.message}`);
    return json.result as T;
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
   * Native SOL balance of an address in lamports (fees are paid in SOL, so
   * the dashboard shows the fee wallet's runway). Null on any failure —
   * callers keep the previous value.
   */
  async solBalanceLamports(address: string): Promise<number | null> {
    try {
      const result = await this.rpc<{ context: unknown; value: number }>('getBalance', [address]);
      return result.value;
    } catch {
      return null;
    }
  }

  /**
   * Total base-unit balance of one SPL mint held by an address (sums duplicate
   * token accounts). Null on any failure — withdrawal caps then fail closed.
   */
  async tokenBalanceBase(mint: string, owner: string): Promise<bigint | null> {
    try {
      const result = await this.rpc<{
        context: unknown;
        value: Array<{
          account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } };
        }>;
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

  /** On first activation: store the latest confirmed signature as the cursor. */
  async latestCursor(address: string): Promise<LeaderCursor> {
    const result = await this.rpc<{
      data: Array<{ signature: string; slot: number; blockTime: number | null }>;
    }>('getTransactionsForAddress', [
      address,
      { transactionDetails: 'signatures', sortOrder: 'desc', limit: 1, commitment: 'confirmed' },
    ]);
    const latest = result?.data?.[0];
    if (!latest) {
      return { lastSignature: '', lastSlot: 0, lastTransactionIndex: 0, lastBlockTime: null };
    }
    return {
      lastSignature: latest.signature,
      lastSlot: latest.slot,
      lastTransactionIndex: 0,
      lastBlockTime: latest.blockTime ?? null,
    };
  }

  /**
   * Reconcile forward from the saved cursor. Returns full transactions NEWER
   * than the cursor in ascending (slot, transactionIndex) order. Never
   * returns activity from before the cursor.
   */
  async transactionsSince(address: string, cursor: LeaderCursor, limit = 25): Promise<FetchedLeaderTx[]> {
    const result = await this.rpc<{
      data: Array<{
        signature?: string | null;
        slot: number;
        transactionIndex?: number;
        blockTime: number | null;
        err: unknown;
        transaction?: { signatures?: string[] } | null;
        meta?: unknown;
      }>;
    }>('getTransactionsForAddress', [
      address,
      {
        transactionDetails: 'full',
        sortOrder: 'desc',
        limit,
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 1,
      },
    ]);
    const rows = result?.data ?? [];
    const fresh = rows
      .filter(
        (r) =>
          r.slot > cursor.lastSlot ||
          (r.slot === cursor.lastSlot && (r.transactionIndex ?? 0) > cursor.lastTransactionIndex),
      )
      .map((r) => ({
        signature: signatureOf(r),
        slot: r.slot,
        transactionIndex: r.transactionIndex ?? 0,
        blockTime: r.blockTime,
        err: r.err != null,
        raw: r,
      }))
      // A transaction without a signature cannot be deduped or persisted.
      .filter((r) => r.signature.length > 0);
    fresh.sort((a, b) => a.slot - b.slot || a.transactionIndex - b.transactionIndex);
    return fresh;
  }

  /**
   * Walk an address's recent signatures backwards until the 24h cutoff and
   * return: swap-count in the window + hours since the most recent one.
   * Used by the day-trader pre-hire gate. Page-capped so a hyperactive
   * wallet cannot run away with quota (1000 sigs is far beyond any day
   * trader; the cap bounds the *stalled* case, which exits on first page).
   */
  async walletActivity24h(address: string): Promise<{ swaps24h: number; lastSwapAgeHours: number | null }> {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let before: string | undefined;
    let swaps24h = 0;
    let newestBlockTime: number | null = null;
    let pages = 0;
    while (pages < 5) {
      pages++;
      // Standard Solana RPC returns a bare array; Helius' custom
      // getTransactionsForAddress wraps results in { data }. Accept both.
      const result = await this.rpc<
        | Array<{ signature: string; slot: number; blockTime: number | null }>
        | { data: Array<{ signature: string; slot: number; blockTime: number | null }> }
      >('getSignaturesForAddress', [
        address,
        { limit: 1000, ...(before ? { before } : {}), commitment: 'confirmed' },
      ]);
      const sigs = Array.isArray(result) ? result : (result?.data ?? []);
      if (sigs.length === 0) break;
      for (const s of sigs) {
        if (s.blockTime == null) continue;
        const t = s.blockTime * 1000;
        if (t < cutoff) {
          return {
            swaps24h,
            lastSwapAgeHours: newestBlockTime === null ? null : (Date.now() - newestBlockTime) / 3600000,
          };
        }
        swaps24h++;
        if (newestBlockTime === null || t > newestBlockTime) newestBlockTime = t;
      }
      if (sigs.length < 1000) break;
      const last = sigs[sigs.length - 1];
      if (!last) break;
      before = last.signature;
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      swaps24h,
      lastSwapAgeHours: newestBlockTime === null ? null : (Date.now() - newestBlockTime) / 3600000,
    };
  }

  /**
   * Convert a full jsonParsed transaction into the leader-scoped summary the
   * core classifier consumes. Balance evidence only — never guesses.
   */
  static toLeaderTxSummary(leaderAddress: string, tx: FetchedLeaderTx): LeaderTxSummary {
    const raw = tx.raw as {
      transaction?: {
        message?: { accountKeys?: Array<string | { pubkey: string }>; instructions?: ParsedInstruction[] };
      };
      meta?: {
        err?: unknown;
        preBalances?: number[];
        postBalances?: number[];
        preTokenBalances?: TokenBalance[];
        postTokenBalances?: TokenBalance[];
        innerInstructions?: Array<{ instructions?: ParsedInstruction[] }>;
        loadedAddresses?: { writable?: string[]; readonly?: string[] };
      };
    };
    const meta = raw.meta ?? {};
    const message = raw.transaction?.message;
    // Versioned transactions: account keys are static keys, then writable
    // lookup-table keys, then readonly ones. Balance indices and instruction
    // programIdIndex values both address THIS combined list.
    const staticKeys = (message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
    const loaded = meta.loadedAddresses ?? {};
    const accountKeys = [...staticKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];

    // Programs invoked: outer + inner instruction program ids.
    const programs = new Set<string>();
    const addPrograms = (instrs?: ParsedInstruction[]) => {
      for (const ins of instrs ?? []) {
        // Parsed responses carry programId; raw (non-jsonParsed) responses carry
        // only programIdIndex. Reading just programId left 'programs' empty, so
        // every real swap failed the classifier's known-swap check.
        if (ins.programId) {
          programs.add(ins.programId);
          continue;
        }
        const idx = ins.programIdIndex;
        if (typeof idx === 'number') {
          const pid = accountKeys[idx];
          if (pid) programs.add(pid);
        }
      }
    };
    addPrograms(message?.instructions);
    for (const inner of meta.innerInstructions ?? []) addPrograms(inner.instructions);

    // Native SOL delta for the leader's own system account.
    let nativeDelta = 0n;
    const leaderIdx = accountKeys.indexOf(leaderAddress);
    if (leaderIdx >= 0 && meta.preBalances && meta.postBalances) {
      nativeDelta = BigInt(meta.postBalances[leaderIdx] ?? 0) - BigInt(meta.preBalances[leaderIdx] ?? 0);
    }

    // Aggregate SPL deltas by mint for token accounts owned by the leader.
    // Absence from pre/post lists means a zero balance on that side.
    const byMint = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
    const collect = (list: TokenBalance[] | undefined, side: 'pre' | 'post') => {
      for (const tb of list ?? []) {
        if (tb.owner !== leaderAddress) continue;
        const amount = BigInt(tb.uiTokenAmount?.amount ?? '0');
        const cur = byMint.get(tb.mint) ?? { pre: 0n, post: 0n, decimals: tb.uiTokenAmount?.decimals ?? 0 };
        cur[side] = cur[side] + amount;
        cur.decimals = tb.uiTokenAmount?.decimals ?? cur.decimals;
        byMint.set(tb.mint, cur);
      }
    };
    collect(meta.preTokenBalances, 'pre');
    collect(meta.postTokenBalances, 'post');

    const tokenDeltas: TokenDelta[] = [];
    for (const [mint, v] of byMint) {
      const delta = v.post - v.pre;
      if (delta !== 0n)
        tokenDeltas.push({ mint, decimals: v.decimals, preBase: v.pre, postBase: v.post, deltaBase: delta });
    }

    return {
      chain: 'solana',
      leaderAddress,
      signature: tx.signature,
      slot: tx.slot,
      transactionIndex: tx.transactionIndex,
      blockTime: tx.blockTime,
      err: tx.err,
      nativeDeltaBase: nativeDelta,
      tokenDeltas,
      programs: [...programs],
    };
  }
}

interface ParsedInstruction {
  programId?: string;
  programIdIndex?: number;
  program?: string;
  parsed?: { type?: string };
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount: string; decimals: number };
}
