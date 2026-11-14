import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { HeliusProvider } from '@zcode-bot/providers';
import { isIdleOver, dayTradeExitDecision, isEventTooOld, ACTIVITY_FRESH_MS } from '@zcode-bot/core';
import type { CopyEngine } from './engine.js';
import { remainingCostBasis } from './builder.js';
import type { TraderLifecycle } from './lifecycle.js';
import type { RiskConfig } from '@zcode-bot/config';

/**
 * Leader monitor. Each tick is signature-first: `getSignaturesForAddress`,
 * then `getTransaction` for signatures the cursor has not seen. Full history
 * polling is not used here. On first activation the latest confirmed
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
  /**
   * Last hourly-sweep check PER ACTIVATION. A single timestamp for the whole
   * monitor let one seat consume the hour and starve the others, so a position
   * past its deadline on, say, seat 3 sat open for hours (ANONCOIN: 14h).
   */
  private lastSweepCheckAt = new Map<string, number>();
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

  /**
   * Mark the monitor running. `selfSchedule` false lets the RUNTIME own the
   * clock (its `rosterTimer` calls `tick()`), which keeps the two monitoring
   * timers in one place — the roster every ROSTER_POLL_MS and the watch list
   * every WATCH_POLL_MS (D5/plan 06).
   */
  start(selfSchedule = true): void {
    if (this.timer) return;
    this.running = true;
    if (!selfSchedule) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  /**
   * One pass over the ROSTER (plan 05): every ACTIVE/FIRING/
   * REQUIRES_RECONCILIATION activation is polled and disciplined on its own, and
   * a failure in one (provider error, bad data) is audited without stopping the
   * others. A stuck reconciliation keeps its own chair frozen and nothing else.
   */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.lastError = null;
      let firstError: string | null = null;
      for (const activation of repo.listActiveActivations(this.db)) {
        try {
          await this.tickActivation(activation, now);
        } catch (e) {
          const detail = (e as Error).message;
          firstError ??= detail;
          repo.audit(this.db, 'monitor', `activation ${activation.activationId} tick failed: ${detail}`, {
            activationId: activation.activationId,
            candidateId: activation.candidateId,
          });
          repo.recordProviderHealth(this.db, {
            provider: 'helius',
            status: 'degraded',
            latencyMs: null,
            detail,
            checkedAt: now.toISOString(),
          });
        }
      }
      // A poll failure inside tickActivation records itself; a crash sets the
      // first error. Either way the tick reports the worst thing it saw.
      if (firstError !== null) this.lastError = firstError;
      this.lastTickAt = now.toISOString();
    } finally {
      this.ticking = false;
    }
  }

  /** One activation's half of the tick: idle check, poll, discipline sweep. */
  private async tickActivation(
    activation: { activationId: string; candidateId: string; state: string; startedAt: string },
    now: Date,
  ): Promise<void> {
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
        // Audited AND recorded as health: one chair's provider failure is
        // visible, and the discipline checks below still run for it.
        this.lastError = (e as Error).message;
        repo.audit(
          this.db,
          'monitor',
          `poll failed for activation ${activation.activationId} (continuing): ${this.lastError}`,
          { activationId: activation.activationId, address: solana.address },
        );
        repo.recordProviderHealth(this.db, {
          provider: 'helius',
          status: 'degraded',
          latencyMs: null,
          detail: this.lastError,
          checkedAt: now.toISOString(),
        });
      }
    }
    // Day-trader exits run on every tick. A stuck token must not wait an hour
    // for its stop. Only a plainly ACTIVE activation qualifies.
    if (activation.state === 'ACTIVE') {
      this.lastSweepCheckAt.set(activation.activationId, now.getTime());
      await this.sweep(activation.activationId, now);
    }
  }

  /**
   * Code exits on every tick: stop, trail, partial take-profit, sell-on-green,
   * and the grace deadline. The idle fire is NOT here — it runs on every tick
   * (checkIdle) so it lands when the dashboard countdown reaches zero.
   */
  private async sweep(activationId: string, now: Date): Promise<void> {
    const open = repo.openPositions(this.db).filter((p) => p.activationId === activationId);
    const nowMs = now.getTime();

    for (const p of open) {
      if (p.status === 'requires_reconciliation') continue; // unknown outcome — operator resolves
      const mark = this.peekMark(p.positionId);
      const entry = remainingCostBasis(p);
      const markValue = mark ? mark.valueUsdMicro : null;
      const peakKey = `exit.peak:${p.positionId}`;
      const lowKey = `exit.low:${p.positionId}`;
      const partialKey = `exit.partial:${p.positionId}`;
      const graceKey = `timeexit.grace:${p.positionId}`;
      const storedPeak = repo.kvGet(this.db, peakKey);
      const storedLow = repo.kvGet(this.db, lowKey);
      let peak = storedPeak ? BigInt(storedPeak) : null;
      let low = storedLow ? BigInt(storedLow) : null;
      if (markValue !== null) {
        peak = peak === null || markValue > peak ? markValue : peak;
        repo.kvSet(this.db, peakKey, peak.toString());
        const pastMax = nowMs - Date.parse(p.openedAt) >= this.risk.MAX_POSITION_AGE_HOURS * 3_600_000;
        if (pastMax) {
          low = low === null || markValue < low ? markValue : low;
          repo.kvSet(this.db, lowKey, low.toString());
        }
      }
      const graceEntered = repo.kvGet(this.db, graceKey) === '1';
      const storedPlan = repo.kvGet(this.db, `exit.plan:${p.positionId}`);
      let plan: { stopLossBps?: number; trailDistanceBps?: number; maxHoldHours?: number } = {};
      if (storedPlan) {
        try {
          plan = JSON.parse(storedPlan) as typeof plan;
        } catch {
          plan = {};
        }
      }
      const decision = dayTradeExitDecision({
        openedAtIso: p.openedAt,
        nowMs,
        maxAgeHours: plan.maxHoldHours ?? this.risk.MAX_POSITION_AGE_HOURS,
        graceHours: this.risk.POSITION_GRACE_HOURS,
        entryUsdMicro: entry > 0n ? entry : 1n,
        markUsdMicro: markValue,
        peakUsdMicro: peak,
        lowSinceMaxHoldUsdMicro: low,
        stopLossBps: plan.stopLossBps ?? this.risk.STOP_LOSS_BPS,
        trailArmBps: this.risk.TRAIL_ARM_BPS,
        trailDistanceBps: plan.trailDistanceBps ?? this.risk.TRAIL_DISTANCE_BPS,
        partialTpBps: this.risk.PARTIAL_TP_BPS,
        partialTaken: repo.kvGet(this.db, partialKey) === '1',
        graceBounceBps: this.risk.GRACE_BOUNCE_BPS,
        sellOnGreen: this.risk.SELL_ON_GREEN,
        graceEntered,
      });
      if (decision === 'none') {
        if (
          !this.risk.SELL_ON_GREEN &&
          !graceEntered &&
          nowMs - Date.parse(p.openedAt) >= this.risk.MAX_POSITION_AGE_HOURS * 3_600_000
        ) {
          repo.kvSet(this.db, graceKey, '1');
        }
        continue;
      }
      const ageH = ((nowMs - Date.parse(p.openedAt)) / 3_600_000).toFixed(1);
      repo.audit(this.db, 'monitor', `code exit: ${p.mint} held ${ageH}h (${decision})`, {});
      if (decision === 'partial_take_profit') {
        const result = await this.engine
          .closeShare(p.positionId, 5_000, 'partial_take_profit')
          .catch((e: Error) => {
            repo.audit(this.db, 'monitor', `partial exit failed: ${e.message}`, {});
            return 'failed' as const;
          });
        if (result === 'partial' || result === 'closed') repo.kvSet(this.db, partialKey, '1');
      } else {
        await this.engine.closePosition(p.positionId, 'time_exit').catch((e: Error) => {
          repo.audit(this.db, 'monitor', `code exit failed: ${e.message}`, {});
        });
        repo.kvSet(this.db, graceKey, '');
      }
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
    const cursor = repo.getCursor(this.db, address);
    if (!cursor || cursor.activationId !== activationId) {
      // Activation boundary (AC9): a fresh hire — including a re-hire of the
      // same address after a firing — starts at the latest confirmed signature,
      // so the previous hire's backlog is never copied by the new chair.
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

    const sigs = await this.helius.signaturesSince(address, {
      lastSignature: cursor.lastSignature,
      lastSlot: cursor.lastSlot,
      lastTransactionIndex: cursor.lastTransactionIndex,
      lastBlockTime: cursor.lastBlockTime,
    });

    for (const sig of sigs) {
      if (sig.err) continue;
      // The 5-minute safety poll is a backstop. A buy already outside the copy
      // window is not fetched: that getTransaction cannot become a fill, and
      // the push path is what copies a buy while it is still fresh.
      if (isEventTooOld(sig.blockTime, Date.now(), this.risk.MAX_COPY_EVENT_AGE_SECONDS)) continue;
      const summary = await this.helius.transactionSummary(address, sig.signature);
      if (summary) await this.engine.handleLeaderTx(activationId, candidateId, summary);
    }

    if (sigs.length > 0) {
      const newest = sigs[sigs.length - 1]!;
      repo.setCursor(this.db, {
        address,
        chain: 'solana',
        activationId,
        lastSignature: newest.signature,
        lastSlot: newest.slot,
        lastTransactionIndex: 0,
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
