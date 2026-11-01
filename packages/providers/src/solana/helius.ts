import { scanForRecentBuy, type LeaderTxSummary, type TokenDelta } from '@zcode-bot/core';

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

  private async rpc<T>(method: string, params: unknown): Promise<T> {
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
   * Token name + symbol from the Helius metadata index (DAS getAsset).
   * Null when the mint has no metadata or the call fails — callers fall back
   * to the shortened mint address rather than inventing a ticker.
   */
  async tokenMetadata(mint: string): Promise<{ name: string | null; symbol: string | null } | null> {
    try {
      const asset = await this.rpc<{
        content?: { metadata?: { name?: string; symbol?: string } };
      }>('getAsset', { id: mint });
      const metadata = asset?.content?.metadata;
      if (!metadata) return null;
      const symbol = (metadata.symbol ?? '').trim();
      const name = (metadata.name ?? '').trim();
      if (!symbol && !name) return null;
      return { name: name || null, symbol: symbol || null };
    } catch {
      return null;
    }
  }

  /** Newest signatures touching an address, most recent first. */
  async recentSignatures(
    address: string,
    limit = 100,
  ): Promise<Array<{ signature: string; blockTime: number | null }>> {
    try {
      const rows = await this.rpc<Array<{ signature: string; blockTime: number | null }>>(
        'getSignaturesForAddress',
        [address, { limit }],
      );
      return rows ?? [];
    } catch {
      return [];
    }
  }

  /**
   * What one transaction actually cost a wallet in SOL: the network fee plus
   * rent locked into (or released from) SPL token accounts opened or closed by
   * that transaction. Rent comes from the account balances themselves, so
   * Token-2022 accounts with extensions are measured correctly too.
   *
   * Null on any failure — the fee ledger then skips that signature rather than
   * inventing a number.
   */
  async solSpend(
    signature: string,
    owner: string,
  ): Promise<{
    feeLamports: number;
    rentLamports: number;
    accountsOpened: number;
    accountsClosed: number;
    blockTime: number | null;
  } | null> {
    try {
      const tx = await this.rpc<{
        blockTime: number | null;
        meta: {
          fee?: number;
          preBalances?: number[];
          postBalances?: number[];
          preTokenBalances?: Array<{ accountIndex: number; owner?: string }>;
          postTokenBalances?: Array<{ accountIndex: number; owner?: string }>;
        } | null;
      }>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
      ]);
      const meta = tx?.meta;
      if (!meta) return null;

      const pre = new Map<number, string | undefined>();
      for (const b of meta.preTokenBalances ?? []) pre.set(b.accountIndex, b.owner);
      const post = new Map<number, string | undefined>();
      for (const b of meta.postTokenBalances ?? []) post.set(b.accountIndex, b.owner);

      let rentLamports = 0;
      let accountsOpened = 0;
      let accountsClosed = 0;
      for (const [index, accountOwner] of post) {
        if (accountOwner !== owner || pre.has(index)) continue;
        rentLamports += meta.postBalances?.[index] ?? 0;
        accountsOpened++;
      }
      for (const [index, accountOwner] of pre) {
        if (accountOwner !== owner || post.has(index)) continue;
        rentLamports -= meta.preBalances?.[index] ?? 0;
        accountsClosed++;
      }

      return {
        feeLamports: meta.fee ?? 0,
        rentLamports,
        accountsOpened,
        accountsClosed,
        blockTime: tx?.blockTime ?? null,
      };
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
   * Actively-trading check (operator decision, 2026-10-31): walk the address's
   * transactions newest-first and classify each until the most recent BUY is
   * found or the window boundary is crossed. Sells, transfers, failed and
   * ambiguous rows are walked past — only a buy marks the wallet as actively
   * trading. Bounded work: paging stops at the boundary, and a page cap keeps
   * a hyperactive wallet from running away with quota.
   *
   * Fail-open by contract: RPC errors and an exhausted page cap return
   * ok:false (unknown), which callers treat as "not known to be active" and
   * fall back to the merit order.
   */
  /**
   * Newest-first transactions with full parsed bodies, paged. Used by the
   * copyable-activity measure: Helius returns up to `limit` transactions per
   * call, so a 100-transaction sample costs 2-3 requests instead of 100 —
   * which is what makes deep sampling survivable on a rate-limited public node.
   * Throws on transport failure so the caller can decide to fall back.
   */
  async recentTransactions(
    address: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<
    Array<{
      signature: string;
      slot: number;
      transactionIndex: number;
      blockTime: number | null;
      err: boolean;
      raw: Record<string, unknown>;
    }>
  > {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 100);
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
        ...(opts.before ? { before: opts.before } : {}),
      },
    ]);
    return (result?.data ?? [])
      .map((r) => ({
        signature: signatureOf(r),
        slot: r.slot,
        transactionIndex: r.transactionIndex ?? 0,
        blockTime: r.blockTime,
        err: r.err != null,
        raw: r as unknown as Record<string, unknown>,
      }))
      .filter((r) => r.signature.length > 0);
  }

  async lastBuyWithinWindow(
    address: string,
    windowHours: number,
  ): Promise<{ ok: boolean; lastBuyAt: string | null }> {
    const cutoffMs = Date.now() - windowHours * 3600 * 1000;
    const PAGE = 50;
    const MAX_PAGES = 10;
    try {
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
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
            limit: PAGE,
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 1,
            ...(before ? { before } : {}),
          },
        ]);
        const rows = (result?.data ?? [])
          .map((r) => ({
            signature: signatureOf(r),
            slot: r.slot,
            transactionIndex: r.transactionIndex ?? 0,
            blockTime: r.blockTime,
            err: r.err != null,
            raw: r,
          }))
          .filter((r) => r.signature.length > 0);
        if (rows.length === 0) return { ok: true, lastBuyAt: null }; // no history left
        const summaries = rows.map((r) => HeliusProvider.toLeaderTxSummary(address, r));
        const scan = scanForRecentBuy(summaries, cutoffMs);
        if (scan.lastBuyAt !== null) return { ok: true, lastBuyAt: scan.lastBuyAt };
        if (scan.boundaryReached) return { ok: true, lastBuyAt: null };
        before = rows[rows.length - 1]!.signature;
        if (rows.length < PAGE) return { ok: true, lastBuyAt: null }; // history exhausted
      }
      return { ok: false, lastBuyAt: null }; // page cap: unknown, fail open
    } catch {
      return { ok: false, lastBuyAt: null };
    }
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

  /**
   * Signer-attributed summary used by the copyable-activity measure
   * (operator decision, 2026-11-01). Differs from `toLeaderTxSummary` in two
   * deliberate ways:
   *
   *  - returns null unless the wallet actually SIGNED the transaction, because
   *    activity is "anything he authorised", not "anything touching his ATAs";
   *  - additionally reports `foreignTokenMints`: mints that moved on accounts
   *    he does not own (pool vaults, program/PDA accounts). A routed buy shows
   *    up there, which lets it count as activity without ever being claimed as
   *    an attributable entry — its size and direction stay honest unknowns.
   *
   * Deliberately separate from `toLeaderTxSummary`: the live copy engine keeps
   * its stricter owner-scoped semantics until it is migrated on its own.
   */
  static toSignerTxSummary(leaderAddress: string, tx: FetchedLeaderTx): LeaderTxSummary | null {
    const raw = tx.raw as {
      transaction?: {
        message?: {
          accountKeys?: Array<string | { pubkey: string; signer?: boolean }>;
          instructions?: ParsedInstruction[];
        };
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
    const rawKeys = message?.accountKeys ?? [];
    // Signers: jsonParsed responses flag each key ({pubkey, signer}); the
    // enhanced getTransactionsForAddress response returns bare strings plus
    // message.header.numRequiredSignatures. Honour both, or attribution is
    // silently empty on one of the two transports.
    const header = (message as { header?: { numRequiredSignatures?: number } } | undefined)?.header;
    const requiredSigners = Math.min(
      Math.max(header?.numRequiredSignatures ?? 1, 0),
      rawKeys.length,
    );
    const signerKeys = new Set<string>();
    for (let i = 0; i < requiredSigners; i++) {
      const key = rawKeys[i];
      if (key) signerKeys.add(typeof key === 'string' ? key : key.pubkey);
    }
    const signed =
      signerKeys.has(leaderAddress) ||
      rawKeys.some((k) => typeof k !== 'string' && k.pubkey === leaderAddress && k.signer === true);
    if (!signed) return null;

    const staticKeys = rawKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const loaded = meta.loadedAddresses ?? {};
    const accountKeys = [...staticKeys, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];

    const programs = new Set<string>();
    const addPrograms = (instrs?: ParsedInstruction[]) => {
      for (const ins of instrs ?? []) {
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

    let nativeDelta = 0n;
    const leaderIdx = accountKeys.indexOf(leaderAddress);
    if (leaderIdx >= 0 && meta.preBalances && meta.postBalances) {
      nativeDelta = BigInt(meta.postBalances[leaderIdx] ?? 0) - BigInt(meta.preBalances[leaderIdx] ?? 0);
    }

    const owned = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
    const foreign = new Map<string, bigint>();
    const collect = (list: TokenBalance[] | undefined, side: 'pre' | 'post') => {
      for (const tb of list ?? []) {
        const amount = BigInt(tb.uiTokenAmount?.amount ?? '0');
        if (tb.owner === leaderAddress) {
          const cur = owned.get(tb.mint) ?? { pre: 0n, post: 0n, decimals: tb.uiTokenAmount?.decimals ?? 0 };
          cur[side] = cur[side] + amount;
          cur.decimals = tb.uiTokenAmount?.decimals ?? cur.decimals;
          owned.set(tb.mint, cur);
        } else {
          const cur = foreign.get(tb.mint) ?? 0n;
          foreign.set(tb.mint, side === 'pre' ? cur - amount : cur + amount);
        }
      }
    };
    collect(meta.preTokenBalances, 'pre');
    collect(meta.postTokenBalances, 'post');

    const tokenDeltas: TokenDelta[] = [];
    for (const [mint, v] of owned) {
      const delta = v.post - v.pre;
      if (delta !== 0n)
        tokenDeltas.push({ mint, decimals: v.decimals, preBase: v.pre, postBase: v.post, deltaBase: delta });
    }
    const foreignTokenMints = [...foreign.entries()]
      .filter(([mint, delta]) => delta !== 0n && !owned.has(mint))
      .map(([mint]) => mint);

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
      foreignTokenMints,
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
