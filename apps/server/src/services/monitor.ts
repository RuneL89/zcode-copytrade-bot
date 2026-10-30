import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { HeliusProvider } from '@zcode-bot/providers';
import { HeliusProvider as HeliusStatic } from '@zcode-bot/providers';
import { isIdleOver, timeExitDecision, ACTIVITY_FRESH_MS } from '@zcode-bot/core';
import type { CopyEngine } from './engine.js';
import type { TraderLifecycle } from './lifecycle.js';
import type { RiskConfig } from '@zcode-bot/config';

/**
 * Leader monitor: baseline polling over the documented Helius
 * getTransactionsForAddress method. On first activation the latest confirmed
 * signature becomes the cursor — activity before activation is NEVER copied.
 * After restart, reconciliation resumes forward from the saved cursor.
 *
 * Day-trader discipline sweep (hour-capped, inside the tick):
 * - Time exits: a position older than MAX_POSITION_AGE_HOURS sells when its
 *   unrealized PnL (mark − entry cost, excl. fees) is positive; past
 *   MAX_POSITION_AGE_HOURS + POSITION_GRACE_HOURS it force-closes regardless.
 *   Uses the same full-close path as a leader exit, so lots and the loss
 *   streak are booked identically.
 * - Idle fire: an activation with zero open positions for IDLE_FIRE_HOURS
 *   (measured from the hire or the last held position) is fired — a day
 *   trader who gives us nothing to copy loses the slot.
 * - Stall watcher: a hired leader whose wallet shows no on-chain activity for
 *   LEADER_STALL_FIRE_HOURS while we hold is fired and replaced, even with
 *   open positions. Judged only when the Helius activity stamp is fresh.
 */
export class LeaderMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastSweepCheckAt = 0;
  lastTickAt: string | null = null;
  lastError: string | null = null;
  running = false;

  constructor(
    private db: AppDatabase,
    private helius: HeliusProvider,
    private engine: CopyEngine,
    private risk: RiskConfig,
    private lifecycle: TraderLifecycle,
    private onStateChange: () => void,
    private pollIntervalMs: number,
    private peekMark: (positionId: string) => { valueUsdMicro: bigint; observedAt: number } | null = () =>
      null,
  ) {}

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const activation = repo.activeActivation(this.db);
      if (activation) {
        // Idle fire runs FIRST and on EVERY tick: the dashboard countdown hits
        // zero to the minute, so the fire that follows it must not wait for the
        // hourly sweep — nor be blocked by a provider failure in the poll
        // below. Pure local DB math.
        if (activation.state === 'ACTIVE') {
          const idleFired = await this.checkIdle(activation.activationId, activation.startedAt, now);
          if (idleFired) {
            this.lastTickAt = now.toISOString();
            this.lastError = null;
            return;
          }
        }
        const addresses = repo.listCandidateAddresses(this.db, activation.candidateId);
        const solana = addresses.find((a) => a.chain === 'solana');
        if (solana) {
          // Provider failure is recorded but never skips the discipline checks.
          try {
            await this.pollAddress(solana.address, activation.activationId, activation.candidateId);
          } catch (e) {
            this.lastError = (e as Error).message;
            repo.recordProviderHealth(this.db, {
              provider: 'helius',
              status: 'degraded',
              latencyMs: null,
              detail: this.lastError,
              checkedAt: now.toISOString(),
            });
          }
        }
        // Day-trader discipline sweep, at most hourly: time exits + stall watcher.
        // Only a plainly ACTIVE activation qualifies (FIRING/reconciliation
        // are in progress and close their own positions).
        if (activation.state === 'ACTIVE' && now.getTime() - this.lastSweepCheckAt >= 3600_000) {
          this.lastSweepCheckAt = now.getTime();
          await this.sweep(activation.activationId, now);
        }
      }
      this.lastTickAt = now.toISOString();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      repo.recordProviderHealth(this.db, {
        provider: 'helius',
        status: 'degraded',
        latencyMs: null,
        detail: this.lastError,
        checkedAt: now.toISOString(),
      });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Day-trader discipline, at most hourly: (a) force-close positions past
   * their time window — positive PnL (excl. fees) sells at
   * MAX_POSITION_AGE_HOURS, everything still open at MAX_POSITION_AGE_HOURS +
   * POSITION_GRACE_HOURS sells regardless; (b) the stall watcher. The idle
   * fire is NOT here — it runs on every tick (checkIdle) so it lands when the
   * dashboard countdown reaches zero.
   */
  private async sweep(activationId: string, now: Date): Promise<void> {
    const open = repo.openPositions(this.db).filter((p) => p.activationId === activationId);
    const nowMs = now.getTime();

    for (const p of open) {
      if (p.status === 'requires_reconciliation') continue; // unknown outcome — operator resolves
      const mark = this.peekMark(p.positionId);
      const unrealized = mark ? mark.valueUsdMicro - BigInt(p.inputUsdMicro) : null;
      const graceKey = `timeexit.grace:${p.positionId}`;
      const graceEntered = repo.kvGet(this.db, graceKey) === '1';
      const decision = timeExitDecision({
        openedAtIso: p.openedAt,
        nowMs,
        maxAgeHours: this.risk.MAX_POSITION_AGE_HOURS,
        graceHours: this.risk.POSITION_GRACE_HOURS,
        unrealizedExclFeesUsdMicro: unrealized,
        graceEntered,
      });
      if (decision === 'none') {
        // Crossed maxAge with non-positive PnL -> ride grace to the deadline.
        if (!graceEntered && nowMs - Date.parse(p.openedAt) >= this.risk.MAX_POSITION_AGE_HOURS * 3_600_000) {
          repo.kvSet(this.db, graceKey, '1');
        }
        continue;
      }
      const ageH = ((nowMs - Date.parse(p.openedAt)) / 3_600_000).toFixed(1);
      repo.audit(this.db, 'monitor', `time exit: ${p.mint} held ${ageH}h (${decision}) — closing`, {});
      await this.engine.closePosition(p.positionId, 'time_exit').catch((e: Error) => {
        repo.audit(this.db, 'monitor', `time exit failed: ${e.message}`, {});
      });
      repo.kvSet(this.db, graceKey, ''); // cleanup
      this.onStateChange();
    }

    // Stall watcher: a hired leader whose wallet goes silent for
    // LEADER_STALL_FIRE_HOURS while we hold is fired and replaced — regardless
    // of open-position winners. Judged only on fresh evidence: if the last
    // Helius check itself is stale, we do not know the leader stalled.
    const activation = repo.getActivation(this.db, activationId);
    const candidate = activation ? repo.getCandidate(this.db, activation.candidateId) : null;
    if (
      candidate?.activityCheckedAt &&
      candidate.lastSwapAt &&
      nowMs - Date.parse(candidate.activityCheckedAt) <= ACTIVITY_FRESH_MS
    ) {
      const silentMs = nowMs - Date.parse(candidate.lastSwapAt);
      const fireMs = this.risk.LEADER_STALL_FIRE_HOURS * 3_600_000;
      if (silentMs > fireMs) {
        const hours = (silentMs / 3_600_000).toFixed(1);
        repo.audit(this.db, 'monitor', `stall watcher: leader wallet silent ${hours}h — firing`, {
          activationId,
          candidateId: candidate.candidateId,
        });
        await this.lifecycle
          .fire(activationId, `stall: leader inactive ${hours}h`)
          .then(() => this.onStateChange())
          .catch((e: Error) => {
            repo.audit(this.db, 'monitor', `stall fire failed: ${e.message}`, {});
          });
        return;
      }
    }

    const lastOpenKey = `monitor.lastOpenAt:${activationId}`;
    const stillOpen = repo.openPositions(this.db).filter((p) => p.activationId === activationId);
    if (stillOpen.length > 0) {
      repo.kvSet(this.db, lastOpenKey, now.toISOString());
    }
  }

  /**
   * Idle fire: an ACTIVE hire that has held zero positions for IDLE_FIRE_HOURS
   * (measured from the hire or the last held position) loses the slot. Runs on
   * every tick so the fire lands when the dashboard countdown reaches zero;
   * the hourly sweep no longer owns it. Returns true when a fire was issued.
   */
  private async checkIdle(activationId: string, startedAt: string, now: Date): Promise<boolean> {
    const lastOpenKey = `monitor.lastOpenAt:${activationId}`;
    const open = repo.openPositions(this.db).filter((p) => p.activationId === activationId);
    if (open.length > 0) {
      repo.kvSet(this.db, lastOpenKey, now.toISOString());
      return false;
    }
    const lastOpenAt = repo.kvGet(this.db, lastOpenKey);
    const baselineMs = Math.max(Date.parse(startedAt), lastOpenAt ? Date.parse(lastOpenAt) : 0);
    const baselineIso = new Date(
      Number.isFinite(baselineMs) && baselineMs > 0 ? baselineMs : Date.parse(startedAt),
    ).toISOString();
    if (!isIdleOver({ baselineIso, nowMs: now.getTime(), idleFireHours: this.risk.IDLE_FIRE_HOURS })) {
      return false;
    }
    const hours = ((now.getTime() - baselineMs) / 3_600_000).toFixed(1);
    repo.audit(this.db, 'monitor', `idle watcher: no open positions for ${hours}h — firing`, {});
    await this.lifecycle
      .fire(activationId, `idle: no open positions for ${hours}h`)
      .then(() => this.onStateChange())
      .catch((e: Error) => {
        repo.audit(this.db, 'monitor', `idle fire failed: ${e.message}`, {});
      });
    return true;
  }

  private async pollAddress(address: string, activationId: string, candidateId: string): Promise<void> {
    let cursor = repo.getCursor(this.db, address);
    if (!cursor) {
      // Activation boundary: initialize to the latest confirmed signature.
      const latest = await this.helius.latestCursor(address);
      repo.setCursor(this.db, {
        address,
        chain: 'solana',
        activationId,
        lastSignature: latest.lastSignature,
        lastSlot: latest.lastSlot,
        lastTransactionIndex: 0,
        lastBlockTime: latest.lastBlockTime,
      });
      repo.audit(this.db, 'monitor', 'leader cursor initialized at activation', {
        address,
        signature: latest.lastSignature,
        slot: latest.lastSlot,
      });
      return;
    }

    const txs = await this.helius.transactionsSince(
      address,
      {
        lastSignature: cursor.lastSignature,
        lastSlot: cursor.lastSlot,
        lastTransactionIndex: cursor.lastTransactionIndex,
        lastBlockTime: cursor.lastBlockTime,
      },
      25,
    );

    for (const tx of txs) {
      const summary = HeliusStatic.toLeaderTxSummary(address, tx);
      await this.engine.handleLeaderTx(activationId, candidateId, summary);
    }

    if (txs.length > 0) {
      const newest = txs[txs.length - 1]!;
      repo.setCursor(this.db, {
        address,
        chain: 'solana',
        activationId,
        lastSignature: newest.signature,
        lastSlot: newest.slot,
        lastTransactionIndex: newest.transactionIndex,
        lastBlockTime: newest.blockTime,
      });
    }
  }
}

/** Startup reconciliation of ambiguous intents. */
export function reconcileOpenIntents(db: AppDatabase): { opened: number; resolved: number } {
  const open = repo.openReconciliationCases(db);
  let resolved = 0;
  for (const c of open) {
    if (!c.intentId) continue;
    const intent = repo.getIntent(db, c.intentId);
    // Resolution requires evidence: a confirmed fill or explicit failure.
    if (intent?.state === 'confirmed') {
      repo.resolveReconciliationCase(db, c.id);
      resolved++;
    }
    // Everything else stays open; an operator resolves via the Runbook.
  }
  const stillOpen = repo.openReconciliationCases(db).length;
  if (stillOpen > 0) {
    repo.audit(db, 'reconciliation', `${stillOpen} case(s) require manual reconciliation`, {});
  }
  return { opened: open.length, resolved };
}
