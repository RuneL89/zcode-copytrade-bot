import { guardExitMode } from './exitGuard.js';
import {
  CreditGovernor,
  DAILY_HARD_CAP,
  applyPlan,
  assertProjectedMonth,
  nominalDayPlan,
  run429Storm,
} from './budget.js';

export interface LiveStartInput {
  mode: 'demo' | 'paper' | 'live';
  liveTrading: boolean;
  acceptanceOk: boolean;
  failures: string[];
}

export type LiveStartDecision = { start: true; signing: boolean } | { start: false; reason: string };

/**
 * Paper and demo always start, and they never sign. Live signs only when
 * LIVE_TRADING is on and the P1 acceptance checks passed. A failed check
 * refuses the process start rather than booting a signer.
 */
export function liveStartDecision(input: LiveStartInput): LiveStartDecision {
  if (input.mode !== 'live' || !input.liveTrading) return { start: true, signing: false };
  if (!input.acceptanceOk) {
    const detail = input.failures.length > 0 ? input.failures.join('; ') : 'P1 acceptance failed';
    return { start: false, reason: detail };
  }
  return { start: true, signing: true };
}

/** The checks P1 already pins in CI. Live boot runs them again and refuses on any failure. */
export function evaluateP1Acceptance(nowMs = Date.parse('2026-11-14T00:00:00.000Z')): {
  ok: boolean;
  failures: string[];
} {
  const failures: string[] = [];
  try {
    const governor = new CreditGovernor();
    const decisions = applyPlan(governor, nominalDayPlan(), nowMs);
    if (decisions.some((decision) => !decision.ok)) failures.push('nominal day call was rejected');
    const total = governor.snapshot(nowMs).dayTotal;
    if (total > DAILY_HARD_CAP) failures.push(`nominal day ${total} exceeds ${DAILY_HARD_CAP}`);
    assertProjectedMonth(total * 30);
  } catch (error) {
    failures.push((error as Error).message);
  }
  const storm = run429Storm();
  if (storm.chairsFrozen !== 0) failures.push('429 drill froze a chair');
  if (storm.exitsCompleted + storm.exitsQueued !== 5) failures.push('429 drill lost an exit');
  if (guardExitMode('live', 'paper') !== 'refuse') failures.push('paper executor would fill a live position');
  return { ok: failures.length === 0, failures };
}
