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
  'FEWER_THAN_K_CLOSED' | 'NET_BELOW_THRESHOLD' | 'LAST_BUY_TOO_OLD' | 'REENTRY_BANNED' | 'NO_SLOT';

export interface PromotionConfig {
  /** Closed shadow trades required (K). */
  promotionMinClosed: number;
  /** Net shadow PnL the closed trades must beat. */
  promotionMinNetUsdMicro: bigint;
  /** The operator's tighter recency rule: the last funded buy must be within this. */
  promotionMaxLastBuyHours: number;
}

export interface PromotionInput {
  aggregates: ShadowAggregates;
  lastFundedBuyAt: string | null;
  lastFiredAt: string | null;
  nowMs: number;
  config: PromotionConfig;
  /** Free roster chairs. */
  slotsFree: number;
}

/** The record gates alone: everything a promotion needs except a free chair. */
export type PromotionRecordInput = Omit<PromotionInput, 'slotsFree'>;

export interface PromotionDecision {
  ok: boolean;
  reason: PromotionBlockReason | null;
}

/**
 * The wallet's own gates (sample, net, recency, re-entry), ignoring chairs.
 * A bench wallet must keep passing these while it waits: a promoted record is
 * not a permanent pass.
 */
export function promotionRecordDecision(input: PromotionRecordInput): PromotionDecision {
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
  if (!canReenter({ lastFiredAt: input.lastFiredAt, lastFundedBuyAt: input.lastFundedBuyAt })) {
    return { ok: false, reason: 'REENTRY_BANNED' };
  }
  return { ok: true, reason: null };
}

/**
 * D4 promotion gate. Every condition is checked in the order the decision
 * lists them, so the reported reason is the first thing that blocks.
 */
export function canPromote(input: PromotionInput): PromotionDecision {
  const record = promotionRecordDecision(input);
  if (!record.ok) return record;
  if (input.slotsFree <= 0) {
    return { ok: false, reason: 'NO_SLOT' };
  }
  return { ok: true, reason: null };
}

/**
 * D4 re-entry: a fired trader may only return once a funded buy was observed
 * after the fire. There is no timed cooldown. Both timestamps are local
 * (`firing_events.fired_at` and `watch_events.observed_at`), so comparing them
 * as strings needs no clock-skew handling.
 */
export function canReenter(input: { lastFiredAt: string | null; lastFundedBuyAt: string | null }): boolean {
  if (input.lastFiredAt === null) return true;
  if (input.lastFundedBuyAt === null) return false;
  return input.lastFundedBuyAt > input.lastFiredAt;
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
