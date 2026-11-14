/**
 * Agent hooks that stay outside the order path. The worker re-checks every
 * decision here before a seat changes or an exit plan moves.
 */

export interface HireDecisionInput {
  decision: 'hire' | 'decline';
  wallet?: string;
  confidence: number;
  reason: string;
  hiresToday: number;
  maxHiresPerDay: number;
  /** False when the wallet is not on the code-qualified bench. */
  codeQualified: boolean;
  blocked: boolean;
  markedAvoid: boolean;
}

export type HireDecisionResult = { ok: true; decision: 'hire' | 'decline' } | { ok: false; reason: string };

export function validateHireDecision(input: HireDecisionInput): HireDecisionResult {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'reason is required' };
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    return { ok: false, reason: 'confidence must be between 0 and 1' };
  }
  if (input.decision === 'decline') return { ok: true, decision: 'decline' };
  if (!input.wallet || !input.wallet.trim()) return { ok: false, reason: 'hire requires a wallet' };
  if (input.hiresToday >= input.maxHiresPerDay) return { ok: false, reason: 'daily hire cap' };
  if (input.blocked) return { ok: false, reason: 'blocked by operator' };
  if (input.markedAvoid) return { ok: false, reason: 'marked avoid' };
  if (!input.codeQualified) return { ok: false, reason: 'not code-qualified' };
  return { ok: true, decision: 'hire' };
}

export interface ExitPlanBounds {
  stopLossBps: number;
  trailDistanceBps: number;
  maxHoldHours: number;
}

export interface ExitAdjustmentInput {
  stopLossBps?: number;
  trailDistanceBps?: number;
  maxHoldHours?: number;
  exitNow?: boolean;
  reason: string;
}

export type ExitAdjustmentResult =
  { ok: true; plan: ExitPlanBounds; exitNow: boolean } | { ok: false; reason: string };

/**
 * An agent may only tighten a plan: a smaller stop, a tighter trail, a shorter
 * hold, or an immediate exit. Any looser field rejects the whole request.
 */
export function applyExitAdjustment(
  current: ExitPlanBounds,
  input: ExitAdjustmentInput,
): ExitAdjustmentResult {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'reason is required' };
  const next: ExitPlanBounds = { ...current };
  if (input.stopLossBps !== undefined) {
    if (!Number.isFinite(input.stopLossBps) || input.stopLossBps <= 0 || input.stopLossBps > 10_000) {
      return { ok: false, reason: 'stopLossBps out of range' };
    }
    if (input.stopLossBps > current.stopLossBps) return { ok: false, reason: 'stop would loosen' };
    next.stopLossBps = input.stopLossBps;
  }
  if (input.trailDistanceBps !== undefined) {
    if (
      !Number.isFinite(input.trailDistanceBps) ||
      input.trailDistanceBps <= 0 ||
      input.trailDistanceBps > 10_000
    ) {
      return { ok: false, reason: 'trailDistanceBps out of range' };
    }
    if (input.trailDistanceBps > current.trailDistanceBps) return { ok: false, reason: 'trail would loosen' };
    next.trailDistanceBps = input.trailDistanceBps;
  }
  if (input.maxHoldHours !== undefined) {
    if (!Number.isFinite(input.maxHoldHours) || input.maxHoldHours <= 0) {
      return { ok: false, reason: 'maxHoldHours out of range' };
    }
    if (input.maxHoldHours > current.maxHoldHours) return { ok: false, reason: 'hold would lengthen' };
    next.maxHoldHours = input.maxHoldHours;
  }
  const changed =
    next.stopLossBps !== current.stopLossBps ||
    next.trailDistanceBps !== current.trailDistanceBps ||
    next.maxHoldHours !== current.maxHoldHours ||
    input.exitNow === true;
  if (!changed) return { ok: false, reason: 'nothing to tighten' };
  return { ok: true, plan: next, exitNow: input.exitNow === true };
}
