/**
 * In-process serialization for the single trading worker.
 *
 * The worker is the only writer (the worker lock enforces one process), so a
 * promise-chain mutex is sufficient. Locks are keyed by the smallest unit that
 * must not be mutated concurrently:
 *
 * - `activation:<id>` — an entry for a seat must finish before a fire can
 *   enumerate/close its positions, and a fire must finish before a new entry.
 * - `position:<id>` — mirrored, code, retry and manual exits cannot double-sell.
 * - `budget` — cap check + intent reservation is atomic across seats.
 * - `withdraw` — one wallet withdrawal at a time.
 *
 * Lock order is activation -> budget/position. Never take an activation lock
 * while holding a position/budget lock: fire takes activation then position,
 * entries take activation then budget, exits take position only.
 */
export class TradingLocks {
  private chains = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.chains.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === current) this.chains.delete(key);
    }
  }

  activation<T>(activationId: string, fn: () => Promise<T> | T): Promise<T> {
    return this.runExclusive(`activation:${activationId}`, fn);
  }

  position<T>(positionId: string, fn: () => Promise<T> | T): Promise<T> {
    return this.runExclusive(`position:${positionId}`, fn);
  }

  budget<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.runExclusive('budget', fn);
  }

  withdraw<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.runExclusive('withdraw', fn);
  }
}

/** A fresh lock set for one runtime (tests build one per harness). */
export function createTradingLocks(): TradingLocks {
  return new TradingLocks();
}
