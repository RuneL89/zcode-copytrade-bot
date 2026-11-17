import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import {
  applyExitAdjustment,
  canPromote,
  usdToMicro,
  validateHireDecision,
  type ExitPlanBounds,
} from '@zcode-bot/core';
import type { CopyEngine } from './engine.js';
import type { TraderLifecycle } from './lifecycle.js';

export interface HireRequest {
  decision?: unknown;
  wallet?: unknown;
  confidence?: unknown;
  reason?: unknown;
  seat?: unknown;
}

function promoteConfig(risk: RiskConfig) {
  return {
    promotionMinClosed: risk.PROMOTION_MIN_CLOSED,
    promotionMinNetUsdMicro: usdToMicro(risk.PROMOTION_MIN_NET_USD),
    promotionMaxLastBuyHours: risk.PROMOTION_MAX_LAST_BUY_HOURS,
    cooldownHours: risk.COOLDOWN_HOURS,
  };
}

function qualified(db: AppDatabase, risk: RiskConfig, candidateId: string, mode: 'paper' | 'live'): boolean {
  const watch = repo.getWatchWallet(db, candidateId);
  if (!watch || (watch.status !== 'bench' && watch.status !== 'watching')) return false;
  const lastFiredAt = repo.lastFiredAt(db, candidateId, mode);
  return canPromote({
    aggregates: repo.shadowAggregates(db, candidateId),
    lastFundedBuyAt: repo.lastFundedBuyAt(db, candidateId),
    lastFiredAt,
    nowMs: Date.now(),
    anotherHiredSinceFire: lastFiredAt !== null && repo.hasHireSince(db, lastFiredAt, candidateId, mode),
    freeChair: repo.activeActivationCount(db, mode) < risk.ROSTER_SIZE,
    config: promoteConfig(risk),
  }).ok;
}

export async function decideHire(
  db: AppDatabase,
  risk: RiskConfig,
  lifecycle: TraderLifecycle,
  body: HireRequest,
  mode: 'paper' | 'live' = 'paper',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const decision = body.decision === 'hire' || body.decision === 'decline' ? body.decision : null;
  if (!decision) return { status: 400, body: { error: 'decision must be hire or decline' } };
  const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : undefined;
  const day = new Date().toISOString().slice(0, 10);
  const hiresToday = Number(repo.kvGet(db, `agent.hires:${day}`) ?? '0') || 0;
  const candidate = wallet ? repo.findCandidateByWallet(db, wallet) : undefined;
  const result = validateHireDecision({
    decision,
    wallet,
    confidence: typeof body.confidence === 'number' ? body.confidence : Number.NaN,
    reason: typeof body.reason === 'string' ? body.reason : '',
    hiresToday,
    maxHiresPerDay: risk.MAX_HIRES_PER_DAY,
    codeQualified:
      decision === 'decline' ? true : candidate ? qualified(db, risk, candidate.candidateId, mode) : false,
    blocked: repo.kvGet(db, `agent.blocked:${wallet ?? ''}`) === '1',
    markedAvoid: repo.kvGet(db, `agent.verdict:${wallet ?? ''}`) === 'avoid',
  });
  const codeOnly =
    repo.listWatchWallets(db, 'bench').find((row) => qualified(db, risk, row.candidateId, mode))
      ?.candidateId ?? null;
  if (!result.ok) return { status: 409, body: { error: result.reason, codeOnlyPick: codeOnly } };
  if (result.decision === 'decline') {
    repo.audit(db, 'agent', 'hire declined', {
      wallet: wallet ?? null,
      reason: body.reason,
      codeOnly,
      seat: body.seat ?? null,
    });
    return { status: 200, body: { ok: true, decision: 'decline', codeOnlyPick: codeOnly } };
  }
  const hired = await lifecycle.hireFromWatch(candidate!.candidateId);
  if (!hired.ok)
    return { status: 409, body: { error: hired.reason ?? 'hire refused', codeOnlyPick: codeOnly } };
  repo.kvSet(db, `agent.hires:${day}`, String(hiresToday + 1));
  repo.audit(db, 'agent', 'hire accepted', {
    wallet,
    reason: body.reason,
    confidence: body.confidence,
    codeOnly,
    activationId: hired.activationId,
  });
  return {
    status: 200,
    body: { ok: true, decision: 'hire', activationId: hired.activationId, codeOnlyPick: codeOnly },
  };
}

export interface ExitRequest {
  positionId?: unknown;
  stopLossBps?: unknown;
  trailDistanceBps?: unknown;
  maxHoldHours?: unknown;
  exitNow?: unknown;
  reason?: unknown;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function defaultPlan(risk: RiskConfig): ExitPlanBounds {
  return {
    stopLossBps: risk.STOP_LOSS_BPS,
    trailDistanceBps: risk.TRAIL_DISTANCE_BPS,
    maxHoldHours: risk.MAX_POSITION_AGE_HOURS,
  };
}

export async function adjustExit(
  db: AppDatabase,
  risk: RiskConfig,
  engine: CopyEngine,
  body: ExitRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const positionId = typeof body.positionId === 'string' ? body.positionId : '';
  const position = positionId ? repo.getPosition(db, positionId) : undefined;
  if (!position || position.status === 'closed')
    return { status: 404, body: { error: 'open position not found' } };
  const stored = repo.kvGet(db, `exit.plan:${positionId}`);
  let overlay: Partial<ExitPlanBounds> = {};
  if (stored) {
    try {
      overlay = JSON.parse(stored) as Partial<ExitPlanBounds>;
    } catch {
      overlay = {};
    }
  }
  const adjusted = applyExitAdjustment(
    { ...defaultPlan(risk), ...overlay },
    {
      stopLossBps: num(body.stopLossBps),
      trailDistanceBps: num(body.trailDistanceBps),
      maxHoldHours: num(body.maxHoldHours),
      exitNow: body.exitNow === true,
      reason: typeof body.reason === 'string' ? body.reason : '',
    },
  );
  if (!adjusted.ok) return { status: 409, body: { error: adjusted.reason } };
  repo.kvSet(db, `exit.plan:${positionId}`, JSON.stringify(adjusted.plan));
  repo.audit(db, 'agent', 'exit plan tightened', { positionId, reason: body.reason, plan: adjusted.plan });
  if (!adjusted.exitNow) return { status: 200, body: { ok: true, plan: adjusted.plan } };
  const closed = await engine.closePosition(positionId, 'agent_exit_now');
  return { status: 200, body: { ok: true, plan: adjusted.plan, close: closed } };
}

export const SEAT_DECISION_MS = 15 * 60_000;

export interface OpenSeat {
  activationId: string;
  candidateId: string;
  reason: string;
  atMs: number;
  pinged: boolean;
}

/** Seats still empty after 15 minutes are pinged again. Nothing is hired. */
export function dueSeatTimeouts(opens: OpenSeat[], nowMs: number, timeoutMs = SEAT_DECISION_MS): OpenSeat[] {
  return opens.filter((seat) => !seat.pinged && nowMs - seat.atMs >= timeoutMs);
}

export async function overruleSeat(
  db: AppDatabase,
  lifecycle: TraderLifecycle,
  body: { activationId?: unknown; action?: unknown; wallet?: unknown; reason?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const activationId = typeof body.activationId === 'string' ? body.activationId : '';
  const action = body.action === 'undo' || body.action === 'replace' ? body.action : null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!activationId || !action)
    return { status: 400, body: { error: 'activationId and action are required' } };
  if (!reason) return { status: 400, body: { error: 'reason is required' } };
  const activation = repo.getActivation(db, activationId);
  if (!activation || activation.state !== 'ACTIVE')
    return { status: 404, body: { error: 'active seat not found' } };
  const fired = await lifecycle.fire(activationId, `overrule: ${reason}`, { holdEmpty: true });
  if (fired.status === 'SKIPPED_NOT_FLAT') {
    return { status: 409, body: { error: 'seat is not flat', status: fired.status } };
  }
  repo.audit(db, 'agent', 'hire overruled', { activationId, action, reason, status: fired.status });
  if (action === 'undo') {
    return { status: 200, body: { ok: true, seat: 'empty', status: fired.status } };
  }
  const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';
  const candidate = wallet ? repo.findCandidateByWallet(db, wallet) : undefined;
  if (!candidate) return { status: 409, body: { error: 'replacement wallet not found', seat: 'empty' } };
  const hired = await lifecycle.hireFromWatch(candidate.candidateId);
  if (!hired.ok)
    return { status: 409, body: { error: hired.reason ?? 'replacement refused', seat: 'empty' } };
  repo.audit(db, 'agent', 'hire replaced', {
    activationId,
    wallet,
    reason,
    activationIdNext: hired.activationId,
  });
  return { status: 200, body: { ok: true, seat: 'replaced', activationId: hired.activationId } };
}

/** Fire-and-forget. A missing URL or a failed post never throws. */
export function deliverSeatOpen(url: string | undefined, event: Record<string, unknown>): void {
  if (!url) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'seat_open', ...event }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}
