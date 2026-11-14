/**
 * Watch-list / shadow-ledger rules (D4). Pure: every input is supplied by the
 * caller (including the clock), so the same inputs always give the same answer
 * and the operator's scenarios can be pinned with a fake clock.
 */

export interface ShadowAggregates {
  closedCount: number;
  netPnlUsdMicro: bigint;
  lastClosedAt: string | null;
}

export type PromotionBlockReason =
  'FEWER_THAN_K_CLOSED' | 'NET_BELOW_THRESHOLD' | 'LAST_BUY_TOO_OLD' | 'REENTRY_BANNED';

export interface PromotionConfig {
  /** Closed shadow trades required (K). */
  promotionMinClosed: number;
  /** Net shadow PnL the closed trades must beat. */
  promotionMinNetUsdMicro: bigint;
  /** The operator's tighter recency rule: the last funded buy must be within this. */
  promotionMaxLastBuyHours: number;
  /**
   * Minimum hours after a firing before a new funded buy can requalify the
   * wallet. Omitted or 0 keeps the older "buy after the fire is enough" rule.
   */
  cooldownHours?: number;
}

export interface PromotionInput {
  aggregates: ShadowAggregates;
  lastFundedBuyAt: string | null;
  lastFiredAt: string | null;
  nowMs: number;
  config: PromotionConfig;
}

export interface PromotionDecision {
  ok: boolean;
  reason: PromotionBlockReason | null;
}

/**
 * The bench gate. A wallet joins the bench — the ordered list of wallets that
 * would take a chair the moment one frees — when its shadow record qualifies.
 * A chair is NOT part of this decision: the bench pre-builds while the roster
 * is full, exactly like a basketball bench. A bench wallet must keep passing
 * these gates while it waits; the chair check lives in the hire path.
 */
export function canPromote(input: PromotionInput): PromotionDecision {
  if (input.aggregates.closedCount < input.config.promotionMinClosed) {
    return { ok: false, reason: 'FEWER_THAN_K_CLOSED' };
  }
  if (input.aggregates.netPnlUsdMicro <= input.config.promotionMinNetUsdMicro) {
    return { ok: false, reason: 'NET_BELOW_THRESHOLD' };
  }
  const lastBuyMs = input.lastFundedBuyAt === null ? null : Date.parse(input.lastFundedBuyAt);
  const recencyMs = input.config.promotionMaxLastBuyHours * 3_600_000;
  if (lastBuyMs === null || !Number.isFinite(lastBuyMs) || input.nowMs - lastBuyMs > recencyMs) {
    return { ok: false, reason: 'LAST_BUY_TOO_OLD' };
  }
  if (
    !canReenter({
      lastFiredAt: input.lastFiredAt,
      lastFundedBuyAt: input.lastFundedBuyAt,
      nowMs: input.nowMs,
      cooldownHours: input.config.cooldownHours,
    })
  ) {
    return { ok: false, reason: 'REENTRY_BANNED' };
  }
  return { ok: true, reason: null };
}

/**
 * Re-entry: a fired trader needs a funded buy observed after the fire, and,
 * when `cooldownHours` is set, that buy is not enough until the cooldown has
 * elapsed. Timestamps are local ISO strings.
 */
export function canReenter(input: {
  lastFiredAt: string | null;
  lastFundedBuyAt: string | null;
  nowMs?: number;
  cooldownHours?: number;
}): boolean {
  if (input.lastFiredAt === null) return true;
  if (input.lastFundedBuyAt === null) return false;
  if (input.lastFundedBuyAt <= input.lastFiredAt) return false;
  const cooldownMs = (input.cooldownHours ?? 0) * 3_600_000;
  if (cooldownMs > 0) {
    const firedMs = Date.parse(input.lastFiredAt);
    if (!Number.isFinite(firedMs) || input.nowMs === undefined) return false;
    if (input.nowMs - firedMs < cooldownMs) return false;
  }
  return true;
}

/**
 * Fired at least `limit` times inside the window (the firing just recorded
 * counts). Those wallets are archived instead of returning to the bench.
 */
/**
 * Newest usable activity stamp. Promotion hires on the shadow ledger's last
 * funded buy; the activity sample's last trade can be hours older when that
 * sample missed the buy. The stall watcher uses this same later stamp.
 */
export function latestActivityMs(stamps: Array<string | null | undefined>): number | null {
  let best: number | null = null;
  for (const stamp of stamps) {
    if (!stamp) continue;
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

export interface StallInput {
  nowMs: number;
  startedAtIso: string;
  /** Shadow-ledger funded buy. This is the promotion clock. */
  lastFundedBuyAt: string | null;
  /** Activity-sample last copyable trade. */
  lastSwapAt: string | null;
  activityCheckedAt: string | null;
  activityFreshMs: number;
  stallHours: number;
}

/**
 * Fire only after the seat has been held for a full stall window, and only
 * when the shared activity stamp (the newer of the funded buy and the
 * activity sample) is older than that window. A sample that is itself stale
 * is ignored, so an old `lastSwapAt` cannot outvote a fresh funded buy.
 */
export function stallDecision(input: StallInput): { fire: boolean; silentHours: number | null } {
  const startedMs = Date.parse(input.startedAtIso);
  const stallMs = input.stallHours * 3_600_000;
  if (!Number.isFinite(startedMs) || input.nowMs - startedMs < stallMs) {
    return { fire: false, silentHours: null };
  }
  const fundedMs = input.lastFundedBuyAt ? Date.parse(input.lastFundedBuyAt) : NaN;
  const sampledMs = input.lastSwapAt ? Date.parse(input.lastSwapAt) : NaN;
  const fundedOk = Number.isFinite(fundedMs);
  const sampledOk = Number.isFinite(sampledMs);
  const checkedMs = input.activityCheckedAt ? Date.parse(input.activityCheckedAt) : NaN;
  const sampleFresh = Number.isFinite(checkedMs) && input.nowMs - checkedMs <= input.activityFreshMs;
  let activityMs: number | null = null;
  if (fundedOk && sampledOk && sampleFresh) activityMs = Math.max(fundedMs, sampledMs);
  else if (fundedOk) activityMs = fundedMs;
  else if (sampledOk && sampleFresh) activityMs = sampledMs;
  if (activityMs === null) return { fire: false, silentHours: null };
  const silentHours = (input.nowMs - activityMs) / 3_600_000;
  return { fire: input.nowMs - activityMs > stallMs, silentHours };
}

export function isRepeatOffender(
  firedAtMs: readonly number[],
  nowMs: number,
  windowDays = 7,
  limit = 2,
): boolean {
  const cutoff = nowMs - windowDays * 86_400_000;
  let count = 0;
  for (const firedAt of firedAtMs) {
    if (firedAt >= cutoff && firedAt <= nowMs) count++;
  }
  return count >= limit;
}

export type CeilingDecision = 'none' | 'close_now' | 'close_at_grace';

export interface CeilingInput {
  openedAt: string;
  nowMs: number;
  maxAgeHours: number;
  graceHours: number;
  /**
   * Live mark of the held coin (micro-USD per whole token), or null when no
   * quote could be obtained — a null mark never closes a position.
   */
  markUsdMicro: bigint | null;
  /** The lot's entry price (micro-USD per whole token). */
  entryUsdMicro: bigint;
}

/**
 * D4 ceiling rule: at `maxAgeHours` a lot with a positive mark closes at the
 * deadline; a lot whose mark is not positive rides to the grace deadline and
 * closes there regardless. Without a usable quote nothing closes — the caller
 * retries on the next tick rather than inventing a price.
 */
export function ceilingAction(input: CeilingInput): CeilingDecision {
  const openedMs = Date.parse(input.openedAt);
  if (!Number.isFinite(openedMs)) return 'none';
  if (input.markUsdMicro === null) return 'none';
  const ageMs = input.nowMs - openedMs;
  if (ageMs < input.maxAgeHours * 3_600_000) return 'none';
  if (input.markUsdMicro > input.entryUsdMicro) return 'close_now';
  const graceMs = (input.maxAgeHours + input.graceHours) * 3_600_000;
  return ageMs >= graceMs ? 'close_now' : 'close_at_grace';
}
