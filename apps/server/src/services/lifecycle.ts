import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import {
  checkEligibility,
  consumeShortlist,
  rankCandidatesDeterministically,
  type RecommendationPayload,
  type ResearchSnapshot,
  type SanitizedCandidate,
} from '@zcode-bot/core';
import type { CopyEngine } from './engine.js';
import type { HeliusProvider } from '@zcode-bot/providers';
import type { SnapshotService } from './research.js';
import { SCAN_FRESH_MS, type EligibilityContext } from '@zcode-bot/core';

/**
 * Trader lifecycle: activation, atomic firing (with pending-intent
 * cancellation and position policy), and replacement from the ordered ZCode
 * recommendation. Fail-closed: exhausted/absent/stale recommendation leads to
 * PAUSED_WAITING_FOR_ZCODE — never an invented trader, never a silent
 * deterministic fallback.
 */

/** Minimum on-chain swaps in the leader wallet's last 24h for a hire. */
export const DAYTRADER_MIN_SWAPS_24H_DEFAULT = 5;
/** Fire the hired trader when his last on-chain swap is older than this (hours). */
export const DAYTRADER_MAX_STALL_HOURS_DEFAULT = 20;
/**
 * Rotation may act only within this window after a board refresh (the sweep
 * runs every 30 min, so exactly the sweep following a refresh qualifies).
 */
export const ROTATION_WINDOW_MS = 45 * 60 * 1000;
/**
 * Grace on the freshness guard: an ordering written this long before the
 * newest scan is still current (recommendations arrive seconds after a sweep).
 */
export const ORDERING_SCAN_TOLERANCE_MS = 5 * 60 * 1000;

export interface ActivityGateInput {
  lastSwapAgeHours: number | null;
  swaps24h: number;
}
export interface ActivityGateConfig {
  maxStallHours: number;
  minSwaps24h: number;
}
export interface ActivityGateResult {
  ok: boolean;
  reason?: 'LEADER_STALLED' | 'LOW_ACTIVITY';
  detail?: string;
}

/** Pure day-trader activity gate (unit-tested). Null input = no on-chain activity at all. */
export function evaluateActivityGate(
  input: ActivityGateInput | null,
  cfg: ActivityGateConfig,
): ActivityGateResult {
  if (!input || input.lastSwapAgeHours === null) {
    return { ok: false, reason: 'LEADER_STALLED', detail: 'no on-chain activity found in the last 24h' };
  }
  if (input.lastSwapAgeHours > cfg.maxStallHours) {
    return {
      ok: false,
      reason: 'LEADER_STALLED',
      detail:
        'last on-chain swap ' +
        input.lastSwapAgeHours.toFixed(1) +
        'h ago (limit ' +
        cfg.maxStallHours +
        'h)',
    };
  }
  if (input.swaps24h < cfg.minSwaps24h) {
    return {
      ok: false,
      reason: 'LOW_ACTIVITY',
      detail: 'only ' + input.swaps24h + ' swap(s) in the last 24h (minimum ' + cfg.minSwaps24h + ')',
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
  | { status: 'PAUSED_WAITING_FOR_ZCODE'; skipped: Array<{ candidateId: string; reason: string }> }
  | { status: 'SKIPPED_NOT_FLAT'; skipped: [] };

export class TraderLifecycle {
  latestValidRecommendation: {
    payload: {
      recommendationId: string;
      orderedCandidates: Array<{ candidateId: string; rank: number }>;
      expiresAt: string;
    };
  } | null = null;

  private helius: HeliusProvider | null = null;
  /** Recommendation whose rotation request was already handled (idempotency). */
  private lastRotationRecommendationId: string | null = null;

  constructor(
    private db: AppDatabase,
    private risk: RiskConfig,
    private engine: CopyEngine | null,
    private snapshots: SnapshotService,
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

  /**
   * Shared eligibility context. Carries the latest captured board scan so the
   * board-presence hire guard applies to every hire path (replacement walk,
   * cold start, rotation pre-check, manual activation). Fired traders carry no
   * cooldown: if the scan says they are back, they are hireable again.
   */
  private eligibilityCtx(): EligibilityContext {
    const scan = repo.listRecentScans(this.db, 1)[0] ?? null;
    return {
      now: Date.now(),
      leaderboardMaxAgeSeconds: this.risk.LEADERBOARD_MAX_AGE_SECONDS,
      scanFreshSeconds: SCAN_FRESH_MS / 1000,
      latestScan: scan ? { observedAt: scan.observedAt, handles: scan.rows.map((r) => r.handle) } : null,
    };
  }

  // --- activation -----------------------------------------------------------

  async activate(
    candidateId: string,
    source: 'manual' | 'zcode_shortlist' | 'deterministic_fallback',
    runEligibility: boolean,
  ): Promise<{ ok: boolean; reason?: string; activationId?: string }> {
    if (repo.activeActivation(this.db)) {
      return { ok: false, reason: 'another trader is already active' };
    }
    if (runEligibility) {
      const sanitized = this.snapshotCandidate(candidateId);
      if (!sanitized) return { ok: false, reason: 'candidate not present in the current research snapshot' };
      const eligibility = checkEligibility(sanitized, this.eligibilityCtx());
      if (!eligibility.eligible) {
        repo.recordCandidateRejection(this.db, {
          recommendationId: null,
          candidateId,
          reason: eligibility.reason,
          detail: eligibility.detail,
        });
        return { ok: false, reason: `${eligibility.reason}: ${eligibility.detail ?? ''}` };
      }
    } else {
      if (!repo.getCandidate(this.db, candidateId)) return { ok: false, reason: 'unknown candidateId' };
    }

    // Day-trader pre-hire gate: the candidate's wallet must show recent
    // on-chain activity (fresh + frequent enough). Single choke point —
    // covers shortlist replacement, cold-start hire, deterministic
    // fallback and manual dashboard activation. Fail-open only when the
    // Helius provider is not configured (tests).
    if (this.helius?.configured) {
      const solAddress = repo.listCandidateAddresses(this.db, candidateId).find((a) => a.chain === 'solana');
      const activity = solAddress ? await this.helius.walletActivity24h(solAddress.address) : null;
      const gate = evaluateActivityGate(activity ?? null, {
        maxStallHours: this.risk.MAX_LEADER_STALL_HOURS,
        minSwaps24h: this.risk.MIN_LEADER_SWAPS_24H,
      });
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
   * Idle hire: when no trader is active (or a fire is still blocked) and a
   * valid recommendation exists, activate its best eligible candidate. The
   * runtime decides when this may run (paper always; live only while armed).
   * activeActivation() covers ACTIVE/FIRING/REQUIRES_RECONCILIATION, so a hire
   * can never double-book a trader while a fire is stuck in reconciliation.
   */
  async coldStartHire(): Promise<
    { status: 'ACTIVATED'; candidateId: string } | { status: 'IDLE' | 'NO_CANDIDATE' }
  > {
    if (repo.activeActivation(this.db)) return { status: 'IDLE' };
    const latest = this.latestValidRecommendation;
    if (!latest) return { status: 'IDLE' };
    // Never resume from a stale ordering: the bot stays paused until the sweep
    // produces an ordering that postdates the latest board scan.
    const fresh = this.orderingFreshness(latest.payload.recommendationId);
    if (!fresh.ok) {
      repo.audit(this.db, 'activation', 'idle hire deferred: stale ordering, fresh research requested', {
        recommendationId: latest.payload.recommendationId,
        detail: fresh.detail,
      });
      this.requestFreshResearch(fresh.scanObservedAt, fresh.detail);
      return { status: 'NO_CANDIDATE' };
    }
    for (const c of latest.payload.orderedCandidates) {
      const act = await this.activate(c.candidateId, 'zcode_shortlist', true);
      if (act.ok) {
        repo.audit(
          this.db,
          'activation',
          `cold-start hire from recommendation ${latest.payload.recommendationId}`,
          {
            candidateId: c.candidateId,
          },
        );
        return { status: 'ACTIVATED', candidateId: c.candidateId };
      }
    }
    return { status: 'NO_CANDIDATE' };
  }

  // --- firing ---------------------------------------------------------------

  /**
   * Atomic firing sequence:
   * 1. mark FIRING + cancel pending unsigned intents (one SQLite transaction)
   * 2. apply FIRE_POSITION_POLICY
   * 3. cooldown registration
   * 4. finalize FIRED
   * 5. consume the ordered shortlist -> activate next or PAUSED_WAITING_FOR_ZCODE
   * Unknown close outcomes -> REQUIRES_RECONCILIATION (no retry, no handoff).
   */
  async fire(
    activationId: string,
    reason: string,
    opts: { requireFlat?: boolean } = {},
  ): Promise<HandoffOutcome> {
    const activation = repo.getActivation(this.db, activationId);
    if (!activation || activation.state === 'FIRED') {
      return { status: 'PAUSED_WAITING_FOR_ZCODE', skipped: [] };
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

    // No cooldown: a fired trader is rehireable the moment the board and the
    // ordering say he qualifies again (operator decision, 2026-10-30).

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
      handoffStatus: 'pending',
    });

    if (handoffBlocked) {
      repo.audit(this.db, 'firing', 'firing paused: close-out requires reconciliation', { activationId });
      return { status: 'PAUSED_WAITING_FOR_ZCODE', skipped: [] };
    }

    const outcome = await this.resolveReplacement(activation.candidateId);
    this.setFiringHandoffStatus(activationId, outcome.status);
    if (outcome.status === 'ACTIVATED') {
      repo.audit(this.db, 'firing', `fired ${activation.candidateId}; activated ${outcome.candidateId}`, {
        activationId,
        source: outcome.source,
      });
    } else {
      repo.controlEvent(
        this.db,
        'replacement_request',
        'no eligible candidate; use the ZCode scheduled task "Run now" or import a fresh recommendation',
        'worker',
      );
      repo.audit(this.db, 'firing', 'fired; PAUSED_WAITING_FOR_ZCODE', {
        activationId,
        skipped: outcome.skipped,
      });
    }
    return outcome;
  }

  /**
   * Freshness guard for hiring: an ordering may only be spent while it
   * postdates the newest board scan. A recommendation written hours ago ranks
   * traders the board has since replaced; spending it hires the best candidate
   * from hours ago. On refusal the bot pauses and the sweep's research trigger
   * produces a fresh ordering, which the idle-hire path then activates.
   *
   * Stands down when no scan exists or the scan itself is stale, so a broken
   * capture pipeline can never freeze hiring forever.
   */
  private orderingFreshness(recommendationId: string): {
    ok: boolean;
    detail: string;
    scanObservedAt: string | null;
  } {
    const scan = repo.listRecentScans(this.db, 1)[0] ?? null;
    if (!scan) return { ok: true, detail: 'no board scan to compare', scanObservedAt: null };
    const scanMs = Date.parse(scan.observedAt);
    if (!Number.isFinite(scanMs) || Date.now() - scanMs > SCAN_FRESH_MS) {
      return { ok: true, detail: 'board scan stale: guard stands down', scanObservedAt: scan.observedAt };
    }
    const rec = repo.getRecommendation(this.db, recommendationId);
    if (!rec || !Number.isFinite(Date.parse(rec.createdAt))) {
      return { ok: true, detail: 'recommendation timestamp unknown', scanObservedAt: scan.observedAt };
    }
    const recMs = Date.parse(rec.createdAt);
    // Small tolerance: an ordering written just before a scan is still current.
    if (recMs + ORDERING_SCAN_TOLERANCE_MS < scanMs) {
      return {
        ok: false,
        detail: `ordering written ${rec.createdAt} predates the latest scan ${scan.observedAt}`,
        scanObservedAt: scan.observedAt,
      };
    }
    return { ok: true, detail: 'ordering postdates the latest scan', scanObservedAt: scan.observedAt };
  }

  /**
   * Leave a research_request control event the sweep can act on. Throttled to
   * one request per board scan: the idle-hire path runs on every state rebuild
   * while the bot is paused and must not flood control_events.
   */
  private requestFreshResearch(scanObservedAt: string | null, detail: string): void {
    if (scanObservedAt) {
      const alreadyRequested = repo
        .listControlEvents(this.db, 20)
        .some((e) => e.type === 'research_request' && e.createdAt >= scanObservedAt);
      if (alreadyRequested) return;
    }
    repo.controlEvent(this.db, 'research_request', detail, 'worker');
  }

  /** Record how a fire's handoff ended, so the audit trail shows the pause. */
  private setFiringHandoffStatus(activationId: string, outcomeStatus: string): void {
    const event = repo.latestFiringEventForActivation(this.db, activationId);
    if (!event || event.handoffStatus !== 'pending') return;
    repo.updateFiringEvent(this.db, event.id, { handoffStatus: this.handoffStatusFor(outcomeStatus) });
  }

  /** Handoff-status label for a fire: activated, or which kind of pause. */
  private handoffStatusFor(outcomeStatus: string): string {
    if (outcomeStatus === 'ACTIVATED') return 'activated';
    const lastHandoff = repo.listHandoffEvents(this.db, 1)[0];
    return lastHandoff?.status === 'paused_for_fresh_research'
      ? 'paused_for_fresh_research'
      : 'paused_waiting_for_zcode';
  }

  /** Consume the ordered shortlist after firing (zcode mode default). */
  async resolveReplacement(firedCandidateId: string): Promise<HandoffOutcome> {
    const snapshotCandidates = this.snapshots.currentSnapshot()?.candidates ?? [];
    const latest = this.latestValidRecommendation;

    if (this.risk.CANDIDATE_REPLACEMENT_MODE !== 'deterministic_fallback' && latest) {
      const fresh = this.orderingFreshness(latest.payload.recommendationId);
      if (!fresh.ok) {
        repo.audit(this.db, 'firing', 'replacement deferred: stale ordering, fresh research requested', {
          firedCandidateId,
          recommendationId: latest.payload.recommendationId,
          detail: fresh.detail,
        });
        // Persist the pause so the dashboard shows the fired → research →
        // auto-hire state instead of silently keeping the old handoff event.
        repo.insertHandoffEvent(this.db, {
          fromCandidateId: firedCandidateId,
          toCandidateId: null,
          status: 'paused_for_fresh_research',
          recommendationId: latest.payload.recommendationId,
          source: 'zcode_shortlist',
          detail: fresh.detail,
          createdAt: new Date().toISOString(),
        });
        repo.recordChoice(this.db, {
          recommendationId: latest.payload.recommendationId,
          chosenCandidateId: null,
          firedFromCandidateId: firedCandidateId,
          result: 'PAUSED_FOR_FRESH_RESEARCH',
          skippedJson: '[]',
        });
        this.requestFreshResearch(fresh.scanObservedAt, fresh.detail);
        return { status: 'PAUSED_WAITING_FOR_ZCODE', skipped: [] };
      }
    }

    if (this.risk.CANDIDATE_REPLACEMENT_MODE === 'deterministic_fallback') {
      const ranked = rankCandidatesDeterministically(snapshotCandidates, this.eligibilityCtx());
      for (const { candidate, score } of ranked) {
        if (!Number.isFinite(score)) break;
        if (candidate.candidateId === firedCandidateId) continue;
        const act = await this.activate(candidate.candidateId, 'deterministic_fallback', false);
        if (act.ok) {
          repo.insertHandoffEvent(this.db, {
            fromCandidateId: firedCandidateId,
            toCandidateId: candidate.candidateId,
            status: 'activated',
            recommendationId: null,
            source: 'deterministic_fallback',
            detail: 'DETERMINISTIC FALLBACK used (explicitly enabled in config); visibly labeled in UI',
            createdAt: new Date().toISOString(),
          });
          return {
            status: 'ACTIVATED',
            candidateId: candidate.candidateId,
            source: 'deterministic_fallback',
          };
        }
      }
      repo.insertHandoffEvent(this.db, {
        fromCandidateId: firedCandidateId,
        toCandidateId: null,
        status: 'paused_waiting_for_zcode',
        recommendationId: null,
        source: 'deterministic_fallback',
        detail: 'no eligible candidate even under deterministic fallback',
        createdAt: new Date().toISOString(),
      });
      return { status: 'PAUSED_WAITING_FOR_ZCODE', skipped: [] };
    }

    const outcome = consumeShortlist({
      ...this.eligibilityCtx(),
      recommendation: latest
        ? { orderedCandidates: latest.payload.orderedCandidates, expiresAt: latest.payload.expiresAt }
        : null,
      candidatesById: new Map(snapshotCandidates.map((c) => [c.candidateId, c])),
    });

    for (const s of outcome.skipped) {
      repo.recordCandidateRejection(this.db, {
        recommendationId: latest?.payload.recommendationId ?? null,
        candidateId: s.candidateId,
        reason: s.reason,
        detail: `rank ${s.rank} skipped during replacement`,
      });
    }

    // Walk the whole ordering, not just the first eligible candidate: activate()
    // can still reject an eligible candidate (activity gate, missing wallet), and
    // stopping there would strand a firing that ranks 2..N could have covered.
    // The just-fired candidate himself is skipped for THIS handoff only — with
    // no cooldown anywhere, that exclusion is what stops a two-loss fire from
    // instantly re-entering the same trader. The next fire, rotation, or
    // recommendation can hire him again at any time.
    const skipped: Array<{ candidateId: string; reason: string }> = outcome.skipped.map((s) => ({
      candidateId: s.candidateId,
      reason: s.reason,
    }));
    const byId = new Map(snapshotCandidates.map((c) => [c.candidateId, c]));
    const ordered = latest ? [...latest.payload.orderedCandidates].sort((a, b) => a.rank - b.rank) : [];
    for (const entry of ordered) {
      if (entry.candidateId === firedCandidateId) {
        skipped.push({ candidateId: entry.candidateId, reason: 'JUST_FIRED' });
        continue;
      }
      const candidate = byId.get(entry.candidateId);
      if (!candidate) continue;
      const eligibility = checkEligibility(candidate, this.eligibilityCtx());
      if (!eligibility.eligible) continue;
      if (outcome.skipped.some((s) => s.candidateId === entry.candidateId)) continue;
      const act = await this.activate(entry.candidateId, 'zcode_shortlist', true);
      if (!act.ok) {
        skipped.push({ candidateId: entry.candidateId, reason: act.reason ?? 'ACTIVATION_FAILED' });
        continue;
      }
      repo.insertHandoffEvent(this.db, {
        fromCandidateId: firedCandidateId,
        toCandidateId: entry.candidateId,
        status: 'activated',
        recommendationId: latest?.payload.recommendationId ?? null,
        source: 'zcode_shortlist',
        detail: null,
        createdAt: new Date().toISOString(),
      });
      repo.recordChoice(this.db, {
        recommendationId: latest?.payload.recommendationId ?? null,
        chosenCandidateId: entry.candidateId,
        firedFromCandidateId: firedCandidateId,
        result: 'ACTIVATE',
        skippedJson: JSON.stringify(skipped),
      });
      return { status: 'ACTIVATED', candidateId: entry.candidateId, source: 'zcode_shortlist' };
    }

    repo.insertHandoffEvent(this.db, {
      fromCandidateId: firedCandidateId,
      toCandidateId: null,
      status: 'paused_waiting_for_zcode',
      recommendationId: latest?.payload.recommendationId ?? null,
      source: 'zcode_shortlist',
      detail: 'exhausted, stale, or missing recommendation',
      createdAt: new Date().toISOString(),
    });
    repo.recordChoice(this.db, {
      recommendationId: latest?.payload.recommendationId ?? null,
      chosenCandidateId: null,
      firedFromCandidateId: firedCandidateId,
      result: 'PAUSED_WAITING_FOR_ZCODE',
      skippedJson: JSON.stringify(skipped),
    });
    return { status: 'PAUSED_WAITING_FOR_ZCODE', skipped };
  }

  private snapshotCandidate(candidateId: string): SanitizedCandidate | null {
    return this.snapshots.currentSnapshot()?.candidates.find((c) => c.candidateId === candidateId) ?? null;
  }

  // --- reconciliation retry (signature-less cases only) ----------------------

  /**
   * Retry closes for reconciliation cases whose intent has NO transaction
   * signature. Such an intent provably never reached the chain, so re-running
   * the exit cannot double-sell; the engine sells the wallet's real balance.
   * Cases WITH a signature are never retried (ambiguous outcome).
   *
   * A successful close resolves its case and completes the fire it blocked:
   * the activation becomes FIRED and the replacement walk runs, so the bot can
   * leave REQUIRES_RECONCILIATION without a hand edit.
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
   * holds nothing does it become FIRED and hand off to the ordering. Refuses
   * when any position or attributable case remains.
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

    if (!this.latestValidRecommendation) this.refreshRecommendationFromDb();
    repo.updateActivation(this.db, activationId, {
      state: 'FIRED',
      endedAt: new Date().toISOString(),
      endReason: 'fired',
    });
    repo.audit(this.db, 'firing', `blocked fire completed after reconciliation: ${activation.candidateId}`, {
      activationId,
    });

    const outcome = await this.resolveReplacement(activation.candidateId);
    const event = repo.latestFiringEventForActivation(this.db, activationId);
    if (event) {
      repo.updateFiringEvent(this.db, event.id, {
        handoffStatus: this.handoffStatusFor(outcome.status),
        closeCompletedAt: new Date().toISOString(),
      });
    }
    if (outcome.status === 'ACTIVATED') {
      repo.audit(this.db, 'firing', `fired ${activation.candidateId}; activated ${outcome.candidateId}`, {
        activationId,
        source: outcome.source,
      });
    } else {
      repo.controlEvent(
        this.db,
        'replacement_request',
        'no eligible candidate; use the ZCode scheduled task "Run now" or import a fresh recommendation',
        'worker',
      );
      repo.audit(this.db, 'firing', 'fired; PAUSED_WAITING_FOR_ZCODE', {
        activationId,
        skipped: outcome.skipped,
      });
    }
    return { status: outcome.status };
  }

  /** Load the freshest unexpired validated recommendation, when one exists. */
  private refreshRecommendationFromDb(): void {
    const row = repo.latestValidRecommendation(this.db);
    if (!row || Date.parse(row.expiresAt) <= Date.now()) return;
    const entries = repo.listRecommendationCandidates(this.db, row.recommendationId);
    if (entries.length === 0) return;
    this.latestValidRecommendation = {
      payload: {
        recommendationId: row.recommendationId,
        orderedCandidates: entries.map((e) => ({ candidateId: e.candidateId, rank: e.rank })),
        expiresAt: row.expiresAt,
      },
    };
  }

  // --- rotation -------------------------------------------------------------

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

  /**
   * Rotate the active trader after a fresh leaderboard ordering arrives: fire it
   * when it is flat, then hire from that ordering. Two hard guards:
   * - never fire unless a candidate on the new ordering is actually hireable
   *   (fresh stage-0 rows have no wallet, and firing into an empty chair would
   *   strand the bot in PAUSED_WAITING_FOR_ZCODE);
   * - one rotation per recommendationId.
   */
  async rotateIfFlat(recommendation: RecommendationPayload): Promise<{
    rotated: boolean;
    reason: string;
  }> {
    if (recommendation.rotateIfFlat !== true) return { rotated: false, reason: 'no rotation intent' };
    if (this.lastRotationRecommendationId === recommendation.recommendationId) {
      return { rotated: false, reason: 'already handled' };
    }
    const active = repo.activeActivation(this.db);
    if (!active) return { rotated: false, reason: 'no active trader' };
    // Rotation is meaningful only right after a board refresh: the ordering must
    // be built from a snapshot whose freshest observation advanced past the hire.
    const refreshedAt = repo.kvGet(this.db, 'board.refreshed_at');
    const refreshedMs = refreshedAt ? Date.parse(refreshedAt) : NaN;
    if (!Number.isFinite(refreshedMs) || Date.now() - refreshedMs > ROTATION_WINDOW_MS) {
      return { rotated: false, reason: 'no fresh board refresh' };
    }
    // Never rotate off a board the incumbent still tops: while the incumbent
    // sits in the scan's top-3, swapping him for a lower-ranked pick is a pure
    // downgrade. Off-board or past-3 incumbents are rotation (and rank-fire)
    // territory.
    const incumbentHandle = repo.getCandidate(this.db, active.candidateId)?.handle ?? null;
    const latestScan = repo.listRecentScans(this.db, 1)[0] ?? null;
    if (incumbentHandle && latestScan) {
      const scanRank = latestScan.rows.find((r) => r.handle === incumbentHandle)?.rank ?? null;
      if (scanRank !== null && scanRank <= 3) {
        repo.audit(this.db, 'rotation', 'rotation skipped: incumbent in board top-3', {
          activationId: active.activationId,
          recommendationId: recommendation.recommendationId,
          scanRank,
        });
        return { rotated: false, reason: 'incumbent in board top-3' };
      }
    }
    if (!this.isFlatForActivation(active.activationId)) {
      repo.audit(this.db, 'rotation', 'rotation skipped: open positions or in-flight entry', {
        activationId: active.activationId,
        recommendationId: recommendation.recommendationId,
      });
      return { rotated: false, reason: 'not flat' };
    }

    const candidates = this.snapshots.currentSnapshot()?.candidates ?? [];
    const hireable = await this.firstHireable(recommendation, candidates);
    if (!hireable) {
      repo.audit(this.db, 'rotation', 'rotation skipped: no hireable candidate on the fresh roster', {
        activationId: active.activationId,
        recommendationId: recommendation.recommendationId,
      });
      return { rotated: false, reason: 'no hireable candidate' };
    }

    this.lastRotationRecommendationId = recommendation.recommendationId;
    // Resolve the hire from THIS ordering, not from whatever the runtime cached.
    this.latestValidRecommendation = {
      payload: {
        recommendationId: recommendation.recommendationId,
        orderedCandidates: recommendation.orderedCandidates.map((c) => ({
          candidateId: c.candidateId,
          rank: c.rank,
        })),
        expiresAt: recommendation.expiresAt,
      },
    };
    const outcome = await this.fire(active.activationId, 'rotation: leaderboard refreshed while flat', {
      requireFlat: true,
    });
    repo.audit(
      this.db,
      'rotation',
      `rotation ${outcome.status === 'ACTIVATED' ? 'completed' : 'did not hire'}`,
      {
        fromCandidateId: active.candidateId,
        toCandidateId: outcome.status === 'ACTIVATED' ? outcome.candidateId : null,
        recommendationId: recommendation.recommendationId,
        outcome: outcome.status,
      },
    );
    return { rotated: outcome.status === 'ACTIVATED', reason: outcome.status };
  }

  /** First candidate on the ordering that would pass eligibility AND the activity gate. */
  private async firstHireable(
    recommendation: RecommendationPayload,
    candidates: readonly SanitizedCandidate[],
  ): Promise<string | null> {
    const byId = new Map(candidates.map((c) => [c.candidateId, c]));
    const ordered = [...recommendation.orderedCandidates].sort((a, b) => a.rank - b.rank);
    for (const entry of ordered) {
      const candidate = byId.get(entry.candidateId);
      if (!candidate) continue;
      const eligibility = checkEligibility(candidate, this.eligibilityCtx());
      if (!eligibility.eligible) continue;
      if (this.helius?.configured) {
        const sol = repo.listCandidateAddresses(this.db, entry.candidateId).find((a) => a.chain === 'solana');
        const activity = sol ? await this.helius.walletActivity24h(sol.address) : null;
        const gate = evaluateActivityGate(activity ?? null, {
          maxStallHours: this.risk.MAX_LEADER_STALL_HOURS,
          minSwaps24h: this.risk.MIN_LEADER_SWAPS_24H,
        });
        if (!gate.ok) continue;
      }
      return entry.candidateId;
    }
    return null;
  }

  /** Last-six markers for the active trader card. */
  lastSixFor(activationId: string): Array<'W' | 'L' | 'B'> {
    const events = repo.listStreakEvents(this.db, activationId);
    return events.slice(-6).map((e) => (e.result === 'win' ? 'W' : e.result === 'loss' ? 'L' : 'B'));
  }
}
