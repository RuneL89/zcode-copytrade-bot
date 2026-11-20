/**
 * FOMO credit budget pacing for discovery (the D5 governor).
 *
 * Discovery is paced to spend the fomoapi credits as fast as possible while
 * never exhausting the monthly plan before it resets: the sustainable pace is
 * `credits remaining × margin ÷ time left in the calendar month`, expressed as
 * an interval between runs. The configured `DISCOVERY_MIN_INTERVAL_MS` is the
 * floor (the fastest the desk will ever run); 24h is the ceiling so a nearly
 * empty balance still probes once a day and notices a plan reset or top-up.
 *
 * Pure calendar math — no database, no clock, no network. The server resolves
 * the inputs (remaining credits and the last measured run cost come from kv).
 */

export interface DiscoveryBudgetInput {
  /** Credits the API reported left, from the last real run. Null = no data yet. */
  creditsRemaining: number | null;
  /** The plan's monthly credit allowance (FOMO_PLAN_CREDITS). */
  planCredits: number;
  /** Credits the last real run spent (3 boards + alerts = 875 on the current plan). */
  costPerRun: number;
  /** Fastest cadence allowed (DISCOVERY_MIN_INTERVAL_MS). */
  configuredMinIntervalMs: number;
  /** Ceiling on the computed interval, so a drained balance still probes daily. */
  maxIntervalMs?: number;
  /**
   * Share of the remaining credits the pacer is allowed to spend (95 by
   * default: the 5% headroom absorbs timing jitter so the cap is never crossed).
   */
  marginPct?: number;
  nowMs: number;
}

export interface DiscoveryPacing {
  /** Interval to enforce between discovery runs (rate-limit window). */
  effectiveIntervalMs: number;
  /** Runs per day the budget allows at the effective interval. Null = no data. */
  allowedRunsPerDay: number | null;
  /** Which balance the pacing is based on: the measured remainder or the plan default. */
  basis: 'measured' | 'plan-default';
  /** Days left until the calendar-month reset (fractional, UTC). */
  daysLeftInCycle: number;
}

const DEFAULT_MAX_INTERVAL_MS = 24 * 3_600_000;
const DEFAULT_MARGIN_PCT = 95;
/** Floor on the remaining-time fraction so the final hour cannot divide by ~0. */
const MIN_DAYS_LEFT = 1 / 48; // 30 minutes

/** Milliseconds from `nowMs` until the first of the next UTC month. */
export function msLeftInCycle(nowMs: number): number {
  const at = new Date(nowMs);
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return Math.max(0, next - nowMs);
}

/**
 * Pace discovery against the credit budget. Even pacing spends exactly the
 * remaining credits at the cycle reset; the margin keeps the spend under the
 * cap, the configured interval keeps "as fast as possible" honest, and the
 * 24h ceiling keeps a drained plan probing for its own reset.
 */
export function computeDiscoveryPacing(input: DiscoveryBudgetInput): DiscoveryPacing {
  const maxIntervalMs = input.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const marginPct = input.marginPct ?? DEFAULT_MARGIN_PCT;
  const daysLeft = Math.max(msLeftInCycle(input.nowMs) / 86_400_000, MIN_DAYS_LEFT);

  const cost = Number.isFinite(input.costPerRun) && input.costPerRun > 0 ? input.costPerRun : 1;
  const configured =
    Number.isFinite(input.configuredMinIntervalMs) && input.configuredMinIntervalMs > 0
      ? input.configuredMinIntervalMs
      : 3_600_000;

  const remaining =
    input.creditsRemaining !== null && Number.isFinite(input.creditsRemaining) && input.creditsRemaining > 0
      ? input.creditsRemaining
      : null;
  const basis: DiscoveryPacing['basis'] = remaining === null ? 'plan-default' : 'measured';
  const budgetCredits = remaining ?? input.planCredits;

  const budgeted = budgetCredits * (Math.min(Math.max(marginPct, 1), 100) / 100);
  const allowedRunsPerDay = budgeted / daysLeft / cost;
  const pacedIntervalMs = 86_400_000 / allowedRunsPerDay;
  const effectiveIntervalMs = Math.min(Math.max(pacedIntervalMs, configured), maxIntervalMs);

  return {
    effectiveIntervalMs,
    allowedRunsPerDay,
    basis,
    daysLeftInCycle: daysLeft,
  };
}
