import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { HeliusProvider } from '@zcode-bot/providers';

/**
 * Human-readable token symbols for copied positions.
 *
 * A mint address is not a useful label, and the metadata index is the only
 * place a ticker can come from. Resolve once, cache the success in kv, and
 * fall back to the shortened mint when the index has nothing. Misses are
 * remembered in memory only, so a token that gains metadata later is retried
 * after a restart rather than being written off forever.
 */

const KV_KEY = 'token.symbols';
const MAX_CACHE = 500;

export class TokenMetaService {
  private cache: Record<string, string> = {};
  private misses = new Set<string>();

  constructor(
    private db: AppDatabase,
    private helius: HeliusProvider,
  ) {
    const raw = repo.kvGet(db, KV_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, string>;
        if (parsed && typeof parsed === 'object') this.cache = parsed;
      } catch {
        // Corrupt cache: resolve again from the index.
      }
    }
  }

  symbolFor(mint: string): string | null {
    return this.cache[mint] ?? null;
  }

  /** Resolve unknown mints, at most `limit` network calls per pass. */
  async resolve(mints: string[], limit = 3): Promise<number> {
    let resolved = 0;
    for (const mint of mints) {
      if (resolved >= limit) break;
      if (this.cache[mint] || this.misses.has(mint)) continue;
      const meta = await this.helius.tokenMetadata(mint);
      if (!meta?.symbol) {
        this.misses.add(mint);
        continue;
      }
      this.cache[mint] = meta.symbol;
      resolved++;
    }
    if (resolved > 0) this.persist();
    return resolved;
  }

  private persist(): void {
    const keys = Object.keys(this.cache);
    if (keys.length > MAX_CACHE) {
      for (const key of keys.slice(0, keys.length - MAX_CACHE)) delete this.cache[key];
    }
    repo.kvSet(this.db, KV_KEY, JSON.stringify(this.cache));
  }
}
