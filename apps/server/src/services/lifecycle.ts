import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import { usdToMicro } from '@zcode-bot/core';
import type { CopyEngine } from './engine.js';
import type { HeliusProvider } from '@zcode-bot/providers';

/**
 * Trader lifecycle (D4/plan 05): activation into the roster, atomic firing
 * (pending-intent cancellation + position policy), and the freed chair filled
 * from the promotion queue (`fillRoster`). Fail-closed: an empty bench leaves
 * the chair empty (`NO_REPLACEMENT`) — never an invented trader.
 */

/** Minimum on-chain swaps in the leader wallet's last 24h for a hire. */
export const DAYTRADER_MIN_SWAPS_24H_DEFAULT = 5;
/** Fire the hired trader when his last on-chain swap is older than this (hours). */
export const DAYTRADER_MAX_STALL_HOURS_DEFAULT = 20;
/**
 * How fresh a copyable-activity reading must be for the hire gate to spend it.
 * The top-board refresh runs every 15 minutes, so 30 leaves room for one missed
 * cycle; anything older is a refresh problem and is refused as ACTIVITY_STALE
 * (never silently read as a quiet wallet).
 */
export const ACTIVITY_GATE_FRESH_MS = 30 * 60 * 1000;

export interface ActivityGateInput {
  /** Hours since the wallet's newest copyable coin movement. */
  lastTradeAgeHours: number | null;
  /** Copyable coin movements (entry or exit) in the last 24h. */
  copyableTrades24h: number;
}
export interface ActivityGateConfig {
  maxStallHours: number;
  minTrades24h: number;
}
export interface ActivityGateResult {
  ok: boolean;
  reason?: 'LEADER_STALLED' | 'LOW_ACTIVITY';
  detail?: string;
}

/**
 * Pure day-trader activity gate (unit-tested). "Activity" means copyable coin
 * movements — an entry or exit on a priceable coin — never raw transactions
 * (operator decision, 2026-11-01: fee payouts and dust are not trading).
 */
export function evaluateActivityGate(
  input: ActivityGateInput | null,
  cfg: ActivityGateConfig,
): ActivityGateResult {
  if (!input || input.lastTradeAgeHours === null) {
    return {
      ok: false,
      reason: 'LEADER_STALLED',
      detail: 'no copyable coin movement in the last 24h',
    };
  }
  if (input.lastTradeAgeHours > cfg.maxStallHours) {
    return {
      ok: false,
      reason: 'LEADER_STALLED',
      detail:
        'last copyable trade ' +
        input.lastTradeAgeHours.toFixed(1) +
        'h ago (limit ' +
        cfg.maxStallHours +
        'h)',
    };
  }
  if (input.copyableTrades24h < cfg.minTrades24h) {
    return {
      ok: false,
      reason: 'LOW_ACTIVITY',
      detail:
        'only ' +
        input.copyableTrades24h +
        ' copyable trade(s) in the last 24h (minimum ' +
        cfg.minTrades24h +
        ')',
    };
  }
  return { ok: true };
}

/** Pure stall check for the monitor: has the ACTIVE leader gone quiet too long? */
export function isLeaderStalled(
  lastBlockTimeSec: number | null,
  nowMs: number,
  maxStallHours: number,
): boolean {
  if (lastBlockTimeSec == null) return false;
  return nowMs - lastBlockTimeSec * 1000 >= maxStallHours * 3600000;
}

export type HandoffOutcome =
  | { status: 'ACTIVATED'; candidateId: string; source: string }
  | { status: 'NO_REPLACEMENT'; skipped: Array<{ candidateId: string; reason: string }> }
  | { status: 'SKIPPED_NOT_FLAT'; skipped: [] };

export class TraderLifecycle {
  private helius: HeliusProvider | null = null;

  constructor(
    private db: AppDatabase,
    private risk: RiskConfig,
    private engine: CopyEngine | null,
  ) {}

  setHelius(helius: HeliusProvider): void {
    this.helius = helius;
  }

  setEngine(engine: CopyEngine): void {
    this.engine = engine;
  }

  setRisk(risk: RiskConfig): void {
    this.risk = risk;
  }

  private sqlite(): Database.Database {
    const dbAny = this.db as unknown as { $client?: Database.Database; client?: Database.Database };
    const raw = dbAny.$client ?? dbAny.client;
    if (!raw) throw new Error('could not access the raw better-sqlite3 handle for atomic transactions');
    return raw;
  }

  // --- activation -----------------------------------------------------------

  async activate(
    candidateId: string,
    source: 'manual' | 'watch_promotion',
  ): Promise<{ ok: boolean; reason?: string; activationId?: string }> {
    // D4: a ROSTER of ROSTER_SIZE leaders sharing one budget pool. A hire needs
    // a free chair; a REQUIRES_RECONCILIATION activation keeps its own chair
    // (and only its own) occupied.
    if (repo.activeActivationCount(this.db) >= this.risk.ROSTER_SIZE) {
      return { ok: false, reason: 'NO_SLOT: the roster is full' };
    }
    if (!repo.getCandidate(this.db, candidateId)) return { ok: false, reason: 'unknown candidateId' };

    // Day-trader pre-hire gate (operator decision, 2026-11-01): judge the
    // STORED copyable-trade reading, and require it to be fresh. A missing or
    // stale reading is a refresh problem, not a quiet wallet, so it gets its
    // own rejection code — silence here used to leave the bot flat with no
    // visible cause. Single choke point: every activation path (manual from the
    // dashboard, and the D4 promotion queue). A watch-promoted wallet already
    // passed the promotion gate, which replaced these readings — its candidate
    // row normally carries no activity stamp at all, so the gate stands aside.
    const candForGate = repo.getWatchWallet(this.db, candidateId)
      ? null
      : repo.getCandidate(this.db, candidateId);
    // Never measured (null status) is unknown, not "quiet": the boot refresh
    // stamps every wallet within ~2 minutes of startup, so this only covers the
    // window before the first measurement (and test fixtures).
    if (candForGate && candForGate.activityCheckStatus !== null) {
      if (candForGate.activityCheckStatus !== 'ok') {
        repo.recordCandidateRejection(this.db, {
          recommendationId: null,
          candidateId,
          reason: 'ACTIVITY_UNMEASURED',
          detail: 'the last copyable-activity check failed — no fresh measurement to judge',
        });
        return { ok: false, reason: 'ACTIVITY_UNMEASURED: last check failed' };
      }
      const checkedMs = candForGate.activityCheckedAt ? Date.parse(candForGate.activityCheckedAt) : NaN;
      if (!Number.isFinite(checkedMs) || Date.now() - checkedMs > ACTIVITY_GATE_FRESH_MS) {
        const ageMin = Number.isFinite(checkedMs)
          ? ((Date.now() - checkedMs) / 60_000).toFixed(0) + ' min old'
          : 'never checked';
        repo.recordCandidateRejection(this.db, {
          recommendationId: null,
          candidateId,
          reason: 'ACTIVITY_STALE',
          detail: `activity reading is ${ageMin} (limit ${ACTIVITY_GATE_FRESH_MS / 60_000} min) — refresh required`,
        });
        return { ok: false, reason: `ACTIVITY_STALE: reading ${ageMin}` };
      }
      const gate = evaluateActivityGate(
        {
          lastTradeAgeHours: candForGate.lastSwapAt
            ? (Date.now() - Date.parse(candForGate.lastSwapAt)) / 3_600_000
            : null,
          copyableTrades24h: candForGate.swaps24h ?? 0,
        },
        {
          maxStallHours: this.risk.MAX_LEADER_STALL_HOURS,
          minTrades24h: this.risk.MIN_LEADER_SWAPS_24H,
        },
      );
      if (!gate.ok) {
        const reason = gate.reason ?? 'LOW_ACTIVITY';
        const detail = gate.detail ?? 'activity gate rejected the candidate';
        repo.recordCandidateRejection(this.db, {
          recommendationId: null,
          candidateId,
          reason,
          detail,
        });
        return { ok: false, reason: reason + ': ' + detail };
      }
    }

    const activationId = 'act_' + randomUUID();
    repo.createActivation(this.db, {
      activationId,
      candidateId,
      state: 'ACTIVE',
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      lossStreak: 0,
      firedReason: null,
      source,
    });
    repo.audit(this.db, 'activation', `trader activated (${source})`, { activationId, candidateId });
    return { ok: true, activationId };
  }

  /**
   * D4 promotion hand-off: hire a wallet the watch record proved (the promotion
   * gate replaced the research/eligibility path, so no snapshot check runs).
   * The roster shares ONE budget pool, so a hire must leave
   * MIN_HIRE_HEADROOM_USD of room behind it (plan 05).
   */
  async hireFromWatch(candidateId: string): Promise<{ ok: boolean; reason?: string; activationId?: string }> {
    const headroom = this.engine?.headroomUsdMicro?.() ?? null;
    if (headroom !== null && headroom < usdToMicro(this.risk.MIN_HIRE_HEADROOM_USD)) {
      return { ok: false, reason: 'NO_HEADROOM: shared-pool room below MIN_HIRE_HEADROOM_USD' };
    }
    return this.activate(candidateId, 'watch_promotion');
  }

  /**
   * Fill every free roster chair from the promotion queue (plan 05): the
   * promoted bench, best shadow record first. Stops when the chairs are full,
   * the queue is empty, or the shared pool has no room — an empty chair is an
   * acceptable outcome (D4), never a reason to hire something unproven.
   */
  async fillRoster(): Promise<{ hired: string[]; reason: string }> {
    const hired: string[] = [];
    const ranked = repo
      .listWatchWallets(this.db, 'promoted')
      .map((wallet) => ({ wallet, aggregates: repo.shadowAggregates(this.db, wallet.candidateId) }))
      .sort(
        (a, b) =>
          Number(b.aggregates.netPnlUsdMicro - a.aggregates.netPnlUsdMicro) ||
          a.wallet.admittedAt.localeCompare(b.wallet.admittedAt),
      );
    while (repo.activeActivationCount(this.db) < this.risk.ROSTER_SIZE) {
      const next = ranked.find((r) => !hired.includes(r.wallet.candidateId));
      if (!next) {
        return { hired, reason: hired.length > 0 ? 'roster filled' : 'no promotable wallet' };
      }
      const attempt = await this.hireFromWatch(next.wallet.candidateId);
      if (!attempt.ok) return { hired, reason: attempt.reason ?? 'hire refused' };
      hired.push(next.wallet.candidateId);
    }
    return { hired, reason: 'roster full' };
  }

  // --- firing ---------------------------------------------------------------

  /**
   * Atomic firing sequence:
   * 1. mark FIRING + cancel pending unsigned intents (one SQLite transaction)
   * 2. apply FIRE_POSITION_POLICY
   * 3. finalize FIRED (no cooldown: re-entry needs a funded buy after the
   *    firing — the canReenter rule)
   * 4. fill the freed chair from the promotion queue (fillRoster)
   * Unknown close outcomes -> REQUIRES_RECONCILIATION (no retry, no handoff).
   */
  async fire(
    activationId: string,
    reason: string,
    opts: { requireFlat?: boolean } = {},
  ): Promise<HandoffOutcome> {
    const activation = repo.getActivation(this.db, activationId);
    if (!activation || activation.state === 'FIRED') {
      return { status: 'NO_REPLACEMENT', skipped: [] };
    }
    const nowIso = new Date().toISOString();

    // The flatness check runs INSIDE the mark-FIRING transaction: a leader buy
    // that lands between an outside check and this write would otherwise be
    // orphaned on a FIRING activation.
    let refusedNotFlat = false;
    const atomicMarkAndCancel = this.sqlite().transaction(() => {
      if (opts.requireFlat && !this.isFlatForActivation(activationId)) {
        refusedNotFlat = true;
        return;
      }
      repo.updateActivation(this.db, activationId, { state: 'FIRING', firedReason: reason });
      for (const intent of repo.pendingUnsignedIntentsForActivation(this.db, activationId)) {
        repo.updateIntent(this.db, intent.intentId, { state: 'cancelled', reason: 'cancelled by firing' });
      }
    });
    atomicMarkAndCancel();
    if (refusedNotFlat) {
      repo.audit(this.db, 'firing', 'fire skipped: not flat (open position or in-flight entry)', {
        activationId,
        reason,
      });
      return { status: 'SKIPPED_NOT_FLAT', skipped: [] };
    }

    // Position policy.
    let closeCompletedAt: string | null = null;
    let handoffBlocked = false;
    if (this.risk.FIRE_POSITION_POLICY === 'close_all_before_switch' && this.engine) {
      const result = await this.engine.closeAllForActivation(activationId);
      // A position that survives the retries (unknown OR definitively failed)
      // must block the handoff: marking the trader FIRED with his bags still
      // held would leave them with no owner, because the monitor only manages
      // the ACTIVE trader's positions.
      if (result.unknown > 0 || result.failed > 0) {
        repo.updateActivation(this.db, activationId, { state: 'REQUIRES_RECONCILIATION' });
        repo.insertReconciliationCase(this.db, {
          kind: result.unknown > 0 ? 'unknown_execution' : 'close_failed',
          intentId: null,
          positionId: null,
          signature: null,
          status: 'open',
          detail: `fire close-out incomplete: ${result.closed} closed, ${result.unknown} unknown, ${result.failed} failed after retries`,
          createdAt: nowIso,
          resolvedAt: null,
        });
        repo.audit(this.db, 'firing', 'firing blocked: positions still open after close-out retries', {
          activationId,
          ...result,
        });
        handoffBlocked = true;
      } else {
        closeCompletedAt = new Date().toISOString();
      }
    }

    // No cooldown registration: a fired trader returns only after a funded buy
    // observed AFTER the firing (the canReenter rule, D4) — no timed cooldown
    // exists. A manual activation from the dashboard overrides.

    if (!handoffBlocked) {
      repo.updateActivation(this.db, activationId, {
        state: 'FIRED',
        endedAt: new Date().toISOString(),
        endReason: 'fired',
      });
    }

    repo.insertFiringEvent(this.db, {
      activationId,
      candidateId: activation.candidateId,
      reason,
      lossStreak: this.risk.FIRE_AFTER_CONSECUTIVE_LOSSES,
      positionPolicy: this.risk.FIRE_POSITION_POLICY,
      firedAt: nowIso,
      closeCompletedAt,
      // Legacy column (the handoff machinery is retired): the firing no longer
      // participates in a handoff.
      handoffStatus: 'none',
    });

    if (handoffBlocked) {
      repo.audit(this.db, 'firing', 'firing paused: close-out requires reconciliation', { activationId });
      return { status: 'NO_REPLACEMENT', skipped: [] };
    }

    // A fire frees exactly one chair; the promotion queue fills it immediately
    // (plan 05). The research replacement path is retired with D6.
    const filled = await this.fillRoster();
    const outcome: HandoffOutcome =
      filled.hired.length > 0
        ? { status: 'ACTIVATED', candidateId: filled.hired[0]!, source: 'watch_promotion' }
        : { status: 'NO_REPLACEMENT', skipped: [] };
    if (outcome.status === 'ACTIVATED') {
      repo.audit(this.db, 'firing', `fired ${activation.candidateId}; activated ${outcome.candidateId}`, {
        activationId,
        source: outcome.source,
      });
    } else {
      // An empty chair is the decided outcome (D4): audit it, and the runtime's
      // fire callback asks discovery for a fresh bench.
      repo.audit(this.db, 'firing', 'fired; NO_REPLACEMENT (chair left empty)', {
        activationId,
        skipped: outcome.skipped,
      });
    }
    return outcome;
  }

  // --- reconciliation retry (signature-less cases only) ----------------------

  /**
   * Retry closes for reconciliation cases whose intent has NO transaction
   * signature. Such an intent provably never reached the chain, so re-running
   * the exit cannot double-sell; the engine sells the wallet's real balance.
   * Cases WITH a signature are never retried (ambiguous outcome).
   *
   * A successful close resolves its case and completes the fire it blocked:
   * the activation becomes FIRED and the chair is filled from the promotion
   * queue, so the bot can leave REQUIRES_RECONCILIATION without a hand edit.
   */
  async retrySignaturelessCloses(reason = 'reconciliation_retry'): Promise<{
    retried: number;
    closed: number;
    failed: number;
    skipped: number;
    handoff: Array<{ activationId: string; status: string }>;
  }> {
    const out: {
      retried: number;
      closed: number;
      failed: number;
      skipped: number;
      handoff: Array<{ activationId: string; status: string }>;
    } = { retried: 0, closed: 0, failed: 0, skipped: 0, handoff: [] };
    if (!this.engine) return out;

    const touched = new Set<string>();
    for (const c of repo.openReconciliationCases(this.db)) {
      if (!c.intentId || !c.positionId) {
        out.skipped++; // summary case: resolved below once nothing is held
        continue;
      }
      const intent = repo.getIntent(this.db, c.intentId);
      if (!intent || intent.txSignature || intent.state !== 'requires_reconciliation') {
        out.skipped++; // has a signature (ambiguous) or already resolved elsewhere
        continue;
      }
      const position = repo.getPosition(this.db, c.positionId);
      if (!position || position.status !== 'requires_reconciliation') {
        out.skipped++;
        continue;
      }
      out.retried++;
      const result = await this.engine.closePosition(c.positionId, reason);
      if (result === 'closed') {
        out.closed++;
        touched.add(position.activationId);
        repo.resolveReconciliationCase(this.db, c.id);
        repo.audit(this.db, 'reconciliation', `retry-close filled; case ${c.id} resolved`, {
          positionId: c.positionId,
          intentId: c.intentId,
          reason,
        });
      } else {
        out.failed++;
        repo.audit(this.db, 'reconciliation', `retry-close ${result}; case ${c.id} stays open`, {
          positionId: c.positionId,
          intentId: c.intentId,
        });
      }
    }

    for (const activationId of touched) {
      const res = await this.completeBlockedFire(activationId);
      out.handoff.push({ activationId, status: res.status });
    }

    // Clear the parent "fire close-out" summary case once no position is held.
    const stillHeld = repo
      .listPositions(this.db, 1000)
      .filter((p) => ['open', 'partially_closed', 'requires_reconciliation'].includes(p.status));
    if (stillHeld.length === 0) {
      for (const c of repo.openReconciliationCases(this.db)) {
        if (!c.intentId && !c.positionId) {
          repo.resolveReconciliationCase(this.db, c.id);
          repo.audit(this.db, 'reconciliation', `summary case ${c.id} resolved: no positions held`, {});
        }
      }
    }
    return out;
  }

  /**
   * Finish a fire that was blocked by reconciliation: only once the activation
   * holds nothing does it become FIRED and the chair is filled from the
   * promotion queue. Refuses when any position or attributable case remains.
   */
  async completeBlockedFire(activationId: string): Promise<{ status: string }> {
    const activation = repo.getActivation(this.db, activationId);
    if (!activation) return { status: 'NOT_FOUND' };
    if (activation.state !== 'REQUIRES_RECONCILIATION') return { status: 'NOT_BLOCKED' };

    const held = repo
      .listPositions(this.db, 1000)
      .filter(
        (p) =>
          p.activationId === activationId &&
          ['open', 'partially_closed', 'requires_reconciliation'].includes(p.status),
      );
    if (held.length > 0) {
      repo.audit(this.db, 'reconciliation', `fire still blocked: ${held.length} position(s) not closed`, {
        activationId,
      });
      return { status: 'STILL_BLOCKED' };
    }
    const blockingCases = repo.openReconciliationCases(this.db).filter((c) => {
      if (c.positionId) {
        return repo.getPosition(this.db, c.positionId)?.activationId === activationId;
      }
      if (c.intentId) {
        return repo.getIntent(this.db, c.intentId)?.activationId === activationId;
      }
      return false;
    });
    if (blockingCases.length > 0) {
      repo.audit(this.db, 'reconciliation', `fire still blocked: ${blockingCases.length} case(s) open`, {
        activationId,
      });
      return { status: 'STILL_BLOCKED' };
    }

    repo.updateActivation(this.db, activationId, {
      state: 'FIRED',
      endedAt: new Date().toISOString(),
      endReason: 'fired',
    });
    repo.audit(this.db, 'firing', `blocked fire completed after reconciliation: ${activation.candidateId}`, {
      activationId,
    });

    const filled = await this.fillRoster();
    const outcome: HandoffOutcome =
      filled.hired.length > 0
        ? { status: 'ACTIVATED', candidateId: filled.hired[0]!, source: 'watch_promotion' }
        : { status: 'NO_REPLACEMENT', skipped: [] };
    const event = repo.latestFiringEventForActivation(this.db, activationId);
    if (event) {
      repo.updateFiringEvent(this.db, event.id, {
        closeCompletedAt: new Date().toISOString(),
      });
    }
    if (outcome.status === 'ACTIVATED') {
      repo.audit(this.db, 'firing', `fired ${activation.candidateId}; activated ${outcome.candidateId}`, {
        activationId,
        source: outcome.source,
      });
    } else {
      repo.audit(this.db, 'firing', 'fired; NO_REPLACEMENT (chair left empty)', {
        activationId,
        skipped: outcome.skipped,
      });
    }
    return { status: outcome.status };
  }

  /**
   * True when the activation holds nothing that could become a position: no
   * open/partial position, no reconciliation case, and no entry intent in flight.
   * `repo.openPositions()` deliberately excludes `requires_reconciliation`, so
   * that status is checked separately -- a stuck reconciling position must not
   * look flat.
   */
  isFlatForActivation(activationId: string): boolean {
    const open = repo.openPositions(this.db).filter((p) => p.activationId === activationId);
    if (open.length > 0) return false;
    const reconciling = repo
      .listPositions(this.db, 500)
      .filter((p) => p.activationId === activationId && p.status === 'requires_reconciliation');
    if (reconciling.length > 0) return false;
    const inFlight = repo
      .intentsInStates(this.db, ['pending_quote', 'quoted', 'pending_sign', 'submitted', 'confirmed'])
      .filter((i) => i.activationId === activationId && i.kind === 'entry');
    return inFlight.length === 0;
  }

  /** The last six close results (W | L | B), oldest first — the streak strip. */
  lastSixFor(activationId: string): Array<'W' | 'L' | 'B'> {
    const events = repo.listStreakEvents(this.db, activationId);
    return events.slice(-6).map((e) => (e.result === 'win' ? 'W' : e.result === 'loss' ? 'L' : 'B'));
  }
}
