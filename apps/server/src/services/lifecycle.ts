import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import { canPromote, isRepeatOffender, usdToMicro } from '@zcode-bot/core';
import type { CopyEngine } from './engine.js';
import type { HeliusProvider } from '@zcode-bot/providers';

/**
 * Trader lifecycle (D4/plan 05): activation into the roster, atomic firing
 * (pending-intent cancellation + position policy), and the freed chair filled
 * from the bench (`fillRoster`). Fail-closed: an empty bench leaves
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
  /** `agent` leaves a freed seat empty until POST /api/agent/hire-decisions. */
  hireApproval: 'auto' | 'agent' = 'auto';
  /** Outbound notice when a seat is left empty. Must not throw into the fire. */
  onSeatOpen: ((event: { activationId: string; candidateId: string; reason: string }) => void) | null = null;

  private async fillOrWait(holdEmpty = false): Promise<{ hired: string[]; reason: string }> {
    // Qualified watchers join the bench before anyone is hired, so a fire can
    // refill from the watching pool. Agent mode still leaves the seat empty.
    this.promoteQualifiedWatchers();
    if (holdEmpty) return { hired: [], reason: 'seat held empty' };
    if (this.hireApproval === 'agent') return { hired: [], reason: 'waiting for agent hire decision' };
    return this.fillRoster();
  }

  /** Move a watching wallet onto the bench when it already passes promotion. */
  private promoteQualifiedWatchers(): void {
    const promotionConfig = {
      promotionMinClosed: this.risk.PROMOTION_MIN_CLOSED,
      promotionMinNetUsdMicro: usdToMicro(this.risk.PROMOTION_MIN_NET_USD),
      promotionMaxLastBuyHours: this.risk.PROMOTION_MAX_LAST_BUY_HOURS,
      cooldownHours: this.risk.COOLDOWN_HOURS,
    };
    for (const wallet of repo.listWatchWallets(this.db, 'watching')) {
      const decision = canPromote({
        aggregates: repo.shadowAggregates(this.db, wallet.candidateId),
        lastFundedBuyAt: repo.lastFundedBuyAt(this.db, wallet.candidateId),
        lastFiredAt: repo.lastFiredAt(this.db, wallet.candidateId),
        nowMs: Date.now(),
        config: promotionConfig,
      });
      if (!decision.ok) continue;
      repo.setWatchStatus(this.db, wallet.candidateId, 'bench', 'bench: record passes');
    }
  }

  private notifySeat(activationId: string, candidateId: string, reason: string, hired: string[]): void {
    if (hired.length > 0 || !this.onSeatOpen) return;
    try {
      this.onSeatOpen({ activationId, candidateId, reason });
    } catch {
      // Delivery is best-effort. The seat stays empty either way.
    }
  }

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
    // One chair per leader. The watch record keeps a hired wallet on the bench
    // (its shadow record stays useful), so every hire path must refuse a
    // candidate that already owns a chair rather than activating it twice.
    if (repo.listActiveActivations(this.db).some((a) => a.candidateId === candidateId)) {
      return { ok: false, reason: 'ALREADY_ACTIVE: the leader already holds a chair' };
    }
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
    // dashboard, and the D4 bench). A benched wallet already passed the
    // bench gate, which replaced these readings — its candidate
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
    // The watch record follows the leader into the chair. A distinct status
    // keeps him off the bench (he is not waiting for anything) while the shadow
    // ledger keeps running; a firing moves him on to cooling.
    if (repo.getWatchWallet(this.db, candidateId)) {
      repo.setWatchStatus(this.db, candidateId, 'hired', 'hired into the roster');
    }
    repo.audit(this.db, 'activation', `trader activated (${source})`, { activationId, candidateId });
    return { ok: true, activationId };
  }

  /**
   * D4 bench hand-off: hire a wallet the watch record proved (the bench gate
   * replaced the research/eligibility path, so no snapshot check runs).
   * Capital headroom is NOT a hire gate (operator decision, 2026-11-03): a
   * proved leader takes a chair and copies once room frees. Individual entries
   * are still capped by the deployed-% limit, so nothing overspends meanwhile.
   */
  async hireFromWatch(candidateId: string): Promise<{ ok: boolean; reason?: string; activationId?: string }> {
    return this.activate(candidateId, 'watch_promotion');
  }

  /**
   * Fill every free roster chair from the bench (plan 05): best shadow record
   * first. Only this step checks for a chair — the bench itself pre-builds.
   * the queue is empty, or the shared pool has no room — an empty chair is an
   * acceptable outcome (D4), never a reason to hire something unproven.
   */
  async fillRoster(): Promise<{ hired: string[]; reason: string }> {
    const hired: string[] = [];
    const promotionConfig = {
      promotionMinClosed: this.risk.PROMOTION_MIN_CLOSED,
      promotionMinNetUsdMicro: usdToMicro(this.risk.PROMOTION_MIN_NET_USD),
      promotionMaxLastBuyHours: this.risk.PROMOTION_MAX_LAST_BUY_HOURS,
      cooldownHours: this.risk.COOLDOWN_HOURS,
    };
    /** A bench row is only a candidate while its record still passes the gates. */
    const recordOk = (candidateId: string): boolean =>
      canPromote({
        aggregates: repo.shadowAggregates(this.db, candidateId),
        lastFundedBuyAt: repo.lastFundedBuyAt(this.db, candidateId),
        lastFiredAt: repo.lastFiredAt(this.db, candidateId),
        nowMs: Date.now(),
        config: promotionConfig,
      }).ok;
    // The bench is the queue; hired leaders keep their shadow rows but are not
    // candidates for a free chair, and a bench wallet is only hired while its
    // record still qualifies (a fired wallet is re-entry banned until a
    // post-fire buy, a stale record is not a hire).
    this.promoteQualifiedWatchers();
    const seated = new Set(repo.listActiveActivations(this.db).map((a) => a.candidateId));
    const ranked = repo
      .listWatchWallets(this.db, 'bench')
      .filter((wallet) => !seated.has(wallet.candidateId) && recordOk(wallet.candidateId))
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
   * 4. fill the freed chair from the bench (fillRoster)
   * Unknown close outcomes -> REQUIRES_RECONCILIATION (no retry, no handoff).
   */
  async fire(
    activationId: string,
    reason: string,
    opts: { requireFlat?: boolean; holdEmpty?: boolean } = {},
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

    // Every firing path ends here (monitor idle/stall, dashboard, loss streak),
    // so the cooling hand-off belongs here too: a fired leader leaves the bench
    // and may only return after a funded buy observed after this firing (D4
    // canReenter). Without this the very fill below could re-hire him.
    if (repo.getWatchWallet(this.db, activation.candidateId)) {
      const windowMs = this.risk.REPEAT_FIRE_WINDOW_DAYS * 86_400_000;
      const since = new Date(Date.now() - windowMs).toISOString();
      const firedAt = repo
        .listFiringEventsSince(this.db, since)
        .filter((row) => row.candidateId === activation.candidateId)
        .map((row) => Date.parse(row.firedAt));
      const repeat = isRepeatOffender(
        firedAt,
        Date.now(),
        this.risk.REPEAT_FIRE_WINDOW_DAYS,
        this.risk.REPEAT_FIRE_LIMIT,
      );
      repo.setWatchStatus(
        this.db,
        activation.candidateId,
        repeat ? 'archived' : 'cooling',
        repeat
          ? `fired ${firedAt.length} times within ${this.risk.REPEAT_FIRE_WINDOW_DAYS}d`
          : `fired: ${reason}`,
      );
      repo.audit(
        this.db,
        'watch',
        repeat ? 'watch archived: repeat firing' : `watch cooling: fired (${reason})`,
        {
          candidateId: activation.candidateId,
        },
      );
    }

    // A fire frees exactly one chair. Auto mode fills it from the bench.
    // Agent mode, and an overrule, leave it empty and post the opening.
    const filled = await this.fillOrWait(opts.holdEmpty === true);
    this.notifySeat(activationId, activation.candidateId, reason, filled.hired);
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
   * the activation becomes FIRED and the chair is filled from the bench
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
   * bench. Refuses when any position or attributable case remains.
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

    const filled = await this.fillOrWait();
    this.notifySeat(activationId, activation.candidateId, 'reconciliation complete', filled.hired);
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
