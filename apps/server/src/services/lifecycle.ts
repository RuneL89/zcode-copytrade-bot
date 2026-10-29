import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import {
  checkEligibility,
  consumeShortlist,
  rankCandidatesDeterministically,
  type ResearchSnapshot,
  type SanitizedCandidate,
} from '@zcode-bot/core';
import type { CopyEngine } from './engine.js';
import type { HeliusProvider } from '@zcode-bot/providers';
import type { SnapshotService } from './research.js';

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
  | { status: 'PAUSED_WAITING_FOR_ZCODE'; skipped: Array<{ candidateId: string; reason: string }> };

export class TraderLifecycle {
  /** candidateId -> cooldown expiry ms (mirrored from DB at startup). */
  cooldowns = new Map<string, number>();
  latestValidRecommendation: {
    payload: {
      recommendationId: string;
      orderedCandidates: Array<{ candidateId: string; rank: number }>;
      expiresAt: string;
    };
  } | null = null;

  private helius: HeliusProvider | null = null;

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

  loadCooldownsFromDb(): void {
    const since = new Date(Date.now() - this.risk.FIRED_TRADER_COOLDOWN_MS).toISOString();
    this.cooldowns.clear();
    for (const a of repo.listActivations(this.db, 200)) {
      if (a.state === 'FIRED' && a.endedAt && a.endedAt >= since) {
        this.cooldowns.set(a.candidateId, Date.parse(a.endedAt) + this.risk.FIRED_TRADER_COOLDOWN_MS);
      }
    }
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
      const eligibility = checkEligibility(sanitized, {
        now: Date.now(),
        cooldownUntilMs: this.cooldowns,
        leaderboardMaxAgeSeconds: this.risk.LEADERBOARD_MAX_AGE_SECONDS,
      });
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
   * Cold-start hire (paper mode only): when no trader is active and a valid
   * recommendation exists, activate its best eligible candidate. This starts
   * the copy loop without operator input; firing/replacement then sustains
   * it. Live mode always starts through explicit operator activation.
   */
  async coldStartHire(): Promise<
    { status: 'ACTIVATED'; candidateId: string } | { status: 'IDLE' | 'NO_CANDIDATE' }
  > {
    if (repo.activeActivation(this.db)) return { status: 'IDLE' };
    const latest = this.latestValidRecommendation;
    if (!latest) return { status: 'IDLE' };
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
  async fire(activationId: string, reason: string): Promise<HandoffOutcome> {
    const activation = repo.getActivation(this.db, activationId);
    if (!activation || activation.state === 'FIRED') {
      return { status: 'PAUSED_WAITING_FOR_ZCODE', skipped: [] };
    }
    const nowIso = new Date().toISOString();

    const atomicMarkAndCancel = this.sqlite().transaction(() => {
      repo.updateActivation(this.db, activationId, { state: 'FIRING', firedReason: reason });
      for (const intent of repo.pendingUnsignedIntentsForActivation(this.db, activationId)) {
        repo.updateIntent(this.db, intent.intentId, { state: 'cancelled', reason: 'cancelled by firing' });
      }
    });
    atomicMarkAndCancel();

    // Position policy.
    let closeCompletedAt: string | null = null;
    let handoffBlocked = false;
    if (this.risk.FIRE_POSITION_POLICY === 'close_all_before_switch' && this.engine) {
      const result = await this.engine.closeAllForActivation(activationId);
      if (result.unknown > 0) {
        repo.updateActivation(this.db, activationId, { state: 'REQUIRES_RECONCILIATION' });
        repo.insertReconciliationCase(this.db, {
          kind: 'unknown_execution',
          intentId: null,
          positionId: null,
          signature: null,
          status: 'open',
          detail: `fire close-out has ${result.unknown} unknown outcome(s)`,
          createdAt: nowIso,
          resolvedAt: null,
        });
        handoffBlocked = true;
      } else {
        closeCompletedAt = new Date().toISOString();
      }
    }

    // Cooldown registration.
    this.cooldowns.set(activation.candidateId, Date.now() + this.risk.FIRED_TRADER_COOLDOWN_MS);

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

  /** Consume the ordered shortlist after firing (zcode mode default). */
  async resolveReplacement(firedCandidateId: string): Promise<HandoffOutcome> {
    const snapshotCandidates = this.snapshots.currentSnapshot()?.candidates ?? [];
    const latest = this.latestValidRecommendation;

    if (this.risk.CANDIDATE_REPLACEMENT_MODE === 'deterministic_fallback') {
      const ranked = rankCandidatesDeterministically(snapshotCandidates, {
        now: Date.now(),
        cooldownUntilMs: this.cooldowns,
        leaderboardMaxAgeSeconds: this.risk.LEADERBOARD_MAX_AGE_SECONDS,
      });
      for (const { candidate, score } of ranked) {
        if (!Number.isFinite(score)) break;
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
      now: Date.now(),
      cooldownUntilMs: this.cooldowns,
      leaderboardMaxAgeSeconds: this.risk.LEADERBOARD_MAX_AGE_SECONDS,
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

    if (outcome.result === 'ACTIVATE' && outcome.activatedCandidateId) {
      const candidateId = outcome.activatedCandidateId;
      const act = await this.activate(candidateId, 'zcode_shortlist', true);
      repo.insertHandoffEvent(this.db, {
        fromCandidateId: firedCandidateId,
        toCandidateId: candidateId,
        status: 'activated',
        recommendationId: latest?.payload.recommendationId ?? null,
        source: 'zcode_shortlist',
        detail: null,
        createdAt: new Date().toISOString(),
      });
      repo.recordChoice(this.db, {
        recommendationId: latest?.payload.recommendationId ?? null,
        chosenCandidateId: candidateId,
        firedFromCandidateId: firedCandidateId,
        result: 'ACTIVATE',
        skippedJson: JSON.stringify(outcome.skipped),
      });
      if (act.ok) return { status: 'ACTIVATED', candidateId, source: 'zcode_shortlist' };
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
      skippedJson: JSON.stringify(outcome.skipped),
    });
    return { status: 'PAUSED_WAITING_FOR_ZCODE', skipped: outcome.skipped };
  }

  private snapshotCandidate(candidateId: string): SanitizedCandidate | null {
    return this.snapshots.currentSnapshot()?.candidates.find((c) => c.candidateId === candidateId) ?? null;
  }

  /** Last-six markers for the active trader card. */
  lastSixFor(activationId: string): Array<'W' | 'L' | 'B'> {
    const events = repo.listStreakEvents(this.db, activationId);
    return events.slice(-6).map((e) => (e.result === 'win' ? 'W' : e.result === 'loss' ? 'L' : 'B'));
  }
}
