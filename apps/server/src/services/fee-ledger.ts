import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { HeliusProvider } from '@zcode-bot/providers';

/**
 * Real SOL costs, read from the chain instead of estimated.
 *
 * The dashboard used to show a fixed per-trade guess as "fees paid". That
 * guess was never tied to what the wallet actually spent, and it ignored the
 * largest real drain: the rent deposited to open an SPL token account for
 * every new coin (roughly 0.002 SOL each). This ledger prices each wallet
 * transaction once — network fee plus rent locked or released — and keeps the
 * running totals in kv so the aggregate and the per-position rows agree.
 *
 * Steady-state cost is one signature call per refresh: transactions are only
 * fetched when a signature is new.
 */

const KV_KEY = 'fees.ledger';
const MAX_TX_CACHE = 500;
const MAX_NEW_PER_TICK = 25;

export interface TxSpend {
  feeLamports: number;
  rentLamports: number;
  blockTime: number | null;
}

export interface FeeLedgerTotals {
  feeLamports: number;
  rentLamports: number;
  accountsOpened: number;
  accountsClosed: number;
  txs: number;
}

interface LedgerState {
  totals: FeeLedgerTotals;
  tx: Record<string, TxSpend>;
}

function emptyState(): LedgerState {
  return {
    totals: { feeLamports: 0, rentLamports: 0, accountsOpened: 0, accountsClosed: 0, txs: 0 },
    tx: {},
  };
}

export class FeeLedgerService {
  private state: LedgerState;

  constructor(
    private db: AppDatabase,
    private helius: HeliusProvider,
  ) {
    const raw = repo.kvGet(db, KV_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<LedgerState>;
        const base = emptyState();
        this.state = {
          totals: { ...base.totals, ...(parsed.totals ?? {}) },
          tx: parsed.tx && typeof parsed.tx === 'object' ? parsed.tx : {},
        };
        return;
      } catch {
        // Corrupt cache: rebuild from the chain rather than fail the dashboard.
      }
    }
    this.state = emptyState();
  }

  async refresh(address: string | null): Promise<void> {
    if (!address) return;
    const signatures = await this.helius.recentSignatures(address, 100);
    const unseen = signatures.filter((s) => !(s.signature in this.state.tx));
    let changed = false;
    for (const entry of unseen.slice(0, MAX_NEW_PER_TICK)) {
      const spend = await this.helius.solSpend(entry.signature, address);
      if (!spend) continue;
      this.state.tx[entry.signature] = {
        feeLamports: spend.feeLamports,
        rentLamports: spend.rentLamports,
        blockTime: spend.blockTime,
      };
      this.state.totals.feeLamports += spend.feeLamports;
      this.state.totals.rentLamports += spend.rentLamports;
      this.state.totals.accountsOpened += spend.accountsOpened;
      this.state.totals.accountsClosed += spend.accountsClosed;
      this.state.totals.txs += 1;
      changed = true;
    }
    if (!changed) return;
    this.trim();
    repo.kvSet(this.db, KV_KEY, JSON.stringify(this.state));
  }

  private trim(): void {
    const keys = Object.keys(this.state.tx);
    if (keys.length <= MAX_TX_CACHE) return;
    const newestFirst = keys.sort(
      (a, b) => (this.state.tx[b]!.blockTime ?? 0) - (this.state.tx[a]!.blockTime ?? 0),
    );
    const keep = new Set(newestFirst.slice(0, MAX_TX_CACHE));
    for (const key of keys) if (!keep.has(key)) delete this.state.tx[key];
  }

  totals(): FeeLedgerTotals {
    return this.state.totals;
  }

  openTokenAccounts(): number {
    return Math.max(0, this.state.totals.accountsOpened - this.state.totals.accountsClosed);
  }

  lookup(signature: string | null): TxSpend | null {
    if (!signature) return null;
    return this.state.tx[signature] ?? null;
  }

  /** Snapshot handed to the state builder (plain data, no service coupling). */
  snapshot(): { totals: FeeLedgerTotals; tx: Record<string, TxSpend> } {
    return { totals: this.state.totals, tx: this.state.tx };
  }
}
