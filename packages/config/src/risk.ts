import { z } from 'zod';

export const LIVE_ACK_STRING =
  'I UNDERSTAND LIVE MODE SIGNS AND SUBMITS REAL SOLANA TRANSACTIONS WITH REAL FUNDS';

export const modeSchema = z.enum(['demo', 'paper', 'live']);
export type Mode = z.infer<typeof modeSchema>;

export const lossStreakUnitSchema = z.enum(['fully_closed_position', 'every_partial_close']);
export type LossStreakUnit = z.infer<typeof lossStreakUnitSchema>;

export const firePositionPolicySchema = z.enum(['close_all_before_switch', 'keep_positions']);
export type FirePositionPolicy = z.infer<typeof firePositionPolicySchema>;

const positiveInt = (name: string) =>
  z
    .number({ invalid_type_error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .positive(`${name} must be positive`);

const nonNegativeInt = (name: string) =>
  z
    .number({ invalid_type_error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .nonnegative(`${name} must not be negative`);

const positiveNumber = (name: string) =>
  z.number({ invalid_type_error: `${name} must be a number` }).positive(`${name} must be positive`);

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * Full risk configuration. Monetary limits are in whole USD (converted to
 * micro-USD integers by the core money module before any arithmetic).
 * `MAX_PER_BUY_PCT` and `MAX_OPEN_PER_TRADER_PCT` are percentages of current
 * capital, so the exposure profile holds as the bankroll grows or shrinks.
 */
export const riskConfigSchema = z
  .object({
    COPY_SCALE: z.number().positive().max(1),
    /** Hard floor for one copied buy, absolute USD (fees/router minimum). */
    MIN_PER_BUY_USD: positiveInt('MIN_PER_BUY_USD'),
    /** Ceiling for one copied buy, percent of current capital. */
    MAX_PER_BUY_PCT: z
      .number({ invalid_type_error: 'MAX_PER_BUY_PCT must be a number' })
      .int('MAX_PER_BUY_PCT must be an integer')
      .min(1, 'MAX_PER_BUY_PCT must be at least 1')
      .max(100, 'MAX_PER_BUY_PCT must be at most 100'),
    /** Max open exposure (entries + entry fees) for one hired trader, percent of current capital. */
    MAX_OPEN_PER_TRADER_PCT: z
      .number({ invalid_type_error: 'MAX_OPEN_PER_TRADER_PCT must be a number' })
      .int('MAX_OPEN_PER_TRADER_PCT must be an integer')
      .min(1, 'MAX_OPEN_PER_TRADER_PCT must be at least 1')
      .max(100, 'MAX_OPEN_PER_TRADER_PCT must be at most 100'),
    /** Max share of capital (equity start + realized PnL) allowed in open positions, percent. */
    MAX_DEPLOYED_PCT: z
      .number({ invalid_type_error: 'MAX_DEPLOYED_PCT must be a number' })
      .int('MAX_DEPLOYED_PCT must be an integer')
      .min(1, 'MAX_DEPLOYED_PCT must be at least 1')
      .max(100, 'MAX_DEPLOYED_PCT must be at most 100'),
    /** Day-trader discipline: max hold before the grace window (hours). */
    MAX_POSITION_AGE_HOURS: positiveInt('MAX_POSITION_AGE_HOURS'),
    /** Grace window added on top before the unconditional close (hours). May be fractional. */
    POSITION_GRACE_HOURS: positiveNumber('POSITION_GRACE_HOURS'),
    /** Hard stop, basis points off entry. 2500 = sell at −25%. */
    STOP_LOSS_BPS: positiveInt('STOP_LOSS_BPS'),
    /** Trailing stop arms after this gain, basis points. */
    TRAIL_ARM_BPS: positiveInt('TRAIL_ARM_BPS'),
    /** Trailing stop distance below the peak, basis points. */
    TRAIL_DISTANCE_BPS: positiveInt('TRAIL_DISTANCE_BPS'),
    /** Partial take-profit gain, basis points. */
    PARTIAL_TP_BPS: positiveInt('PARTIAL_TP_BPS'),
    /** During grace, sell after a bounce of this many bps off the low. */
    GRACE_BOUNCE_BPS: positiveInt('GRACE_BOUNCE_BPS'),
    /** Sell as soon as a position is green at max hold or during grace. */
    SELL_ON_GREEN: boolish,
    /** Exit slippage ladder, attempt 0. */
    EXIT_SLIPPAGE_BPS_1: positiveInt('EXIT_SLIPPAGE_BPS_1'),
    EXIT_SLIPPAGE_BPS_2: positiveInt('EXIT_SLIPPAGE_BPS_2'),
    /** Last exit slippage step. Further attempts reuse it. */
    EXIT_SLIPPAGE_BPS_3: positiveInt('EXIT_SLIPPAGE_BPS_3'),
    /**
     * Hours after a firing before the free-chair re-entry path opens. A hire
     * of another trader after the firing lifts the block immediately.
     */
    COOLDOWN_HOURS: positiveInt('COOLDOWN_HOURS'),
    /** Agent hire decisions allowed per local day. */
    MAX_HIRES_PER_DAY: positiveInt('MAX_HIRES_PER_DAY'),
    /** Fire the hire after this many hours with zero open positions. */
    IDLE_FIRE_HOURS: positiveInt('IDLE_FIRE_HOURS'),
    MAX_SLIPPAGE_BPS: positiveInt('MAX_SLIPPAGE_BPS'),
    MAX_PRICE_IMPACT_BPS: positiveInt('MAX_PRICE_IMPACT_BPS'),
    MAX_COPY_EVENT_AGE_SECONDS: positiveInt('MAX_COPY_EVENT_AGE_SECONDS'),
    LEADERBOARD_MAX_AGE_SECONDS: positiveInt('LEADERBOARD_MAX_AGE_SECONDS'),
    /** Fire the active trader when his last on-chain swap is older than this. */
    MAX_LEADER_STALL_HOURS: positiveInt('MAX_LEADER_STALL_HOURS'),
    /** Fire the active trader when his wallet goes silent this long while we hold (stall watcher). */
    LEADER_STALL_FIRE_HOURS: positiveInt('LEADER_STALL_FIRE_HOURS'),
    /** Pre-hire gate: minimum on-chain swaps in the leader wallet's last 24h. */
    MIN_LEADER_SWAPS_24H: positiveInt('MIN_LEADER_SWAPS_24H'),
    /**
     * Actively-trading tier (hire priority, not a gate): a candidate whose most
     * recent on-chain BUY is within this window is hired ahead of the merit
     * order. Sell-only or quiet wallets are not "actively trading"; Helius
     * failures fail open to the merit order.
     */
    ACTIVE_BUY_WINDOW_HOURS: positiveInt('ACTIVE_BUY_WINDOW_HOURS'),
    PRICE_MAX_AGE_SECONDS: positiveInt('PRICE_MAX_AGE_SECONDS'),
    LOSS_STREAK_UNIT: lossStreakUnitSchema,
    FIRE_POSITION_POLICY: firePositionPolicySchema,
    FIRE_AFTER_CONSECUTIVE_LOSSES: z.literal(2).default(2),
    BREAKEVEN_RESETS_STREAK: z.boolean().default(false),

    // --- watch list / shadow ledger / roster (D4/D5, decided 2026-11-01) --------
    /** Admission: funded buys required in the 24h window. */
    ADMISSION_MIN_BUYS_24H: positiveInt('ADMISSION_MIN_BUYS_24H'),
    /** Admission: the last funded buy must be within this many hours. */
    ADMISSION_MAX_LAST_BUY_HOURS: positiveInt('ADMISSION_MAX_LAST_BUY_HOURS'),
    /** Promotion: closed shadow trades required. */
    PROMOTION_MIN_CLOSED: positiveInt('PROMOTION_MIN_CLOSED'),
    /** Promotion: net shadow PnL (USD) the closed trades must beat. Measured on the fixed shadow ruler, not on capital. */
    PROMOTION_MIN_NET_USD: positiveInt('PROMOTION_MIN_NET_USD'),
    /** Promotion: the operator's tighter recency rule — the last funded buy must be this fresh. */
    PROMOTION_MAX_LAST_BUY_HOURS: positiveInt('PROMOTION_MAX_LAST_BUY_HOURS'),
    /** Watched wallets the list holds. */
    WATCH_LIST_SIZE: positiveInt('WATCH_LIST_SIZE'),
    /** Promotable wallets the bench must keep (discovery trigger, D5). */
    BENCH_TARGET: positiveInt('BENCH_TARGET'),
    /** Roster chairs sharing the one budget pool. */
    ROSTER_SIZE: z
      .number({ invalid_type_error: 'ROSTER_SIZE must be a number' })
      .int('ROSTER_SIZE must be an integer')
      .min(1, 'ROSTER_SIZE must be at least 1')
      .max(10, 'ROSTER_SIZE must be at most 10'),
    /** Per-mint exposure cap for a leader; 0 disables the cap (operator decision). */
    PER_MINT_CAP_USD: nonNegativeInt('PER_MINT_CAP_USD'),
    /** Watch list: signature poll per watched wallet. */
    WATCH_POLL_MS: positiveInt('WATCH_POLL_MS').min(60_000, 'WATCH_POLL_MS must be at least 60000'),
    /** Roster: signature poll per hired wallet (a real order follows). */
    ROSTER_POLL_MS: positiveInt('ROSTER_POLL_MS').min(15_000, 'ROSTER_POLL_MS must be at least 15000'),
    /**
     * Helius detail reads allowed per minute on the watch path when the public
     * RPC cannot answer. Admission's bounded prefix is the burst consumer; the
     * daily governor cap remains the hard stop.
     */
    WATCH_DETAIL_PER_MINUTE: positiveInt('WATCH_DETAIL_PER_MINUTE'),
    /**
     * Detail reads ONE admission scan may spend when its newest 12-signature
     * prefix cannot prove the funded-buy gate: the scan deepens in 12-detail
     * batches and stops as soon as the gate is proven. A busy wallet whose
     * newest signatures mix buys and sells can therefore still prove the gate
     * without the scan deferring it forever. One pass never spends more than
     * WATCH_DETAIL_PER_MINUTE.
     */
    ADMISSION_MAX_DETAILS_PER_SCAN: positiveInt('ADMISSION_MAX_DETAILS_PER_SCAN'),
    /** Evict wallets that fail the funded-buy screen for this many days. */
    WATCH_EVICTION_DAYS: positiveInt('WATCH_EVICTION_DAYS'),
    /** Seed the shadow record from the admission scan (observed trades only). */
    SHADOW_BACKFILL_ON_ADMIT: z.boolean().default(true),
    /** Demand-driven discovery rate limit (D5: at most one run per 30–60 min). The fomo credit budget can only slow this down. */
    DISCOVERY_MIN_INTERVAL_MS: positiveInt('DISCOVERY_MIN_INTERVAL_MS').min(
      600_000,
      'DISCOVERY_MIN_INTERVAL_MS must be at least 600000',
    ),
    /**
     * The fomoapi plan's monthly credit allowance. The discovery governor paces
     * runs to spend `credits remaining × 95%` evenly across the rest of the
     * calendar month, so the plan is never exhausted before its reset.
     */
    FOMO_PLAN_CREDITS: positiveInt('FOMO_PLAN_CREDITS'),
  })
  .superRefine((cfg, ctx) => {
    // A single bet cannot be larger than the trader's open cap (D1).
    if (cfg.MAX_OPEN_PER_TRADER_PCT < cfg.MAX_PER_BUY_PCT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAX_OPEN_PER_TRADER_PCT'],
        message:
          `MAX_OPEN_PER_TRADER_PCT (${cfg.MAX_OPEN_PER_TRADER_PCT}) must be >= MAX_PER_BUY_PCT (${cfg.MAX_PER_BUY_PCT}): ` +
          'one trade cannot be larger than the trader open cap',
      });
    }
    if (
      cfg.EXIT_SLIPPAGE_BPS_2 < cfg.EXIT_SLIPPAGE_BPS_1 ||
      cfg.EXIT_SLIPPAGE_BPS_3 < cfg.EXIT_SLIPPAGE_BPS_2
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EXIT_SLIPPAGE_BPS_3'],
        message: 'exit slippage ladder must be non-decreasing',
      });
    }
    // A bench target above the watch-list size can never be reached (D4).
    if (cfg.BENCH_TARGET > cfg.WATCH_LIST_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BENCH_TARGET'],
        message:
          `BENCH_TARGET (${cfg.BENCH_TARGET}) must be <= WATCH_LIST_SIZE (${cfg.WATCH_LIST_SIZE}): ` +
          'the bench is drawn from the watch list',
      });
    }
  });

export type RiskConfig = z.infer<typeof riskConfigSchema>;

export const DEFAULT_RISK: RiskConfig = {
  COPY_SCALE: 0.25,
  MIN_PER_BUY_USD: 2,
  MAX_PER_BUY_PCT: 10,
  MAX_OPEN_PER_TRADER_PCT: 35,
  MAX_DEPLOYED_PCT: 80,
  // D4's day-trader ceiling: force-close at 8h, +3h grace when the mark is not
  // positive. (D4's 8h+3h working assumption is the shipped default; a saved
  // .env value still wins for an installation that set one.)
  MAX_POSITION_AGE_HOURS: 5,
  POSITION_GRACE_HOURS: 1.5,
  STOP_LOSS_BPS: 2500,
  TRAIL_ARM_BPS: 1500,
  TRAIL_DISTANCE_BPS: 1000,
  PARTIAL_TP_BPS: 4000,
  GRACE_BOUNCE_BPS: 800,
  SELL_ON_GREEN: true,
  EXIT_SLIPPAGE_BPS_1: 300,
  EXIT_SLIPPAGE_BPS_2: 600,
  EXIT_SLIPPAGE_BPS_3: 1000,
  // A fired trader is blocked until another trader is hired after the firing,
  // or until this many hours pass with a roster chair still free.
  COOLDOWN_HOURS: 3,
  MAX_HIRES_PER_DAY: 3,
  // D4's lifecycle rule: the idle clock runs from max(hire, last held position)
  // and fires at 8h.
  IDLE_FIRE_HOURS: 8,
  MAX_SLIPPAGE_BPS: 300,
  MAX_PRICE_IMPACT_BPS: 300,
  MAX_COPY_EVENT_AGE_SECONDS: 90,
  // 12h: the 24h board rotates daily and the sweep re-reads it at least every
  // 4h — a candidate not re-seen within 12h is no longer part of today's game.
  LEADERBOARD_MAX_AGE_SECONDS: 43200,
  MAX_LEADER_STALL_HOURS: 20,
  // Fired when a HIRED leader's wallet goes silent this long while we hold
  // (the pre-hire gate above still uses MAX_LEADER_STALL_HOURS).
  LEADER_STALL_FIRE_HOURS: 8,
  // Copyable coin movements (entries + exits) required in 24h to qualify a
  // candidate (operator decision, 2026-11-01: 3, not 5 — the count now means
  // real coin movements instead of raw transactions).
  MIN_LEADER_SWAPS_24H: 3,
  ACTIVE_BUY_WINDOW_HOURS: 4,
  PRICE_MAX_AGE_SECONDS: 45,
  LOSS_STREAK_UNIT: 'fully_closed_position',
  FIRE_POSITION_POLICY: 'close_all_before_switch',
  FIRE_AFTER_CONSECUTIVE_LOSSES: 2,
  BREAKEVEN_RESETS_STREAK: false,
  // D4 thresholds, decided 2026-11-01 (all configurable in Settings).
  ADMISSION_MIN_BUYS_24H: 3,
  ADMISSION_MAX_LAST_BUY_HOURS: 24,
  PROMOTION_MIN_CLOSED: 8,
  PROMOTION_MIN_NET_USD: 3,
  // The operator's tighter recency rule (D4): a promotable wallet must have bought recently.
  PROMOTION_MAX_LAST_BUY_HOURS: 4,
  WATCH_LIST_SIZE: 20,
  BENCH_TARGET: 10,
  ROSTER_SIZE: 5,
  PER_MINT_CAP_USD: 0, // 0 = disabled (operator decision: no cap for now)
  WATCH_POLL_MS: 300000,
  ROSTER_POLL_MS: 45000,
  // Admission scans one candidate per tick; a busy wallet's scan deepens past
  // the newest 12 up to this many details, stopping at the gate. WATCH_DETAIL_PER_MINUTE
  // stays the hard upper bound for both admission and watch fallback.
  WATCH_DETAIL_PER_MINUTE: 120,
  ADMISSION_MAX_DETAILS_PER_SCAN: 60,
  WATCH_EVICTION_DAYS: 14,
  SHADOW_BACKFILL_ON_ADMIT: true,
  DISCOVERY_MIN_INTERVAL_MS: 1800000,
  FOMO_PLAN_CREDITS: 250000,
};

/** Fields a settings-change request may modify at runtime. */
const settingsPatchObjectSchema = z
  .object({
    MIN_PER_BUY_USD: z.number().int().positive().optional(),
    MAX_PER_BUY_PCT: z.number().int().min(1).max(100).optional(),
    MAX_OPEN_PER_TRADER_PCT: z.number().int().min(1).max(100).optional(),
    MAX_DEPLOYED_PCT: z.number().int().min(1).max(100).optional(),
    MAX_POSITION_AGE_HOURS: z.number().int().positive().optional(),
    POSITION_GRACE_HOURS: z.number().positive().optional(),
    STOP_LOSS_BPS: z.number().int().positive().optional(),
    TRAIL_ARM_BPS: z.number().int().positive().optional(),
    TRAIL_DISTANCE_BPS: z.number().int().positive().optional(),
    PARTIAL_TP_BPS: z.number().int().positive().optional(),
    GRACE_BOUNCE_BPS: z.number().int().positive().optional(),
    SELL_ON_GREEN: boolish.optional(),
    EXIT_SLIPPAGE_BPS_1: z.number().int().positive().optional(),
    EXIT_SLIPPAGE_BPS_2: z.number().int().positive().optional(),
    EXIT_SLIPPAGE_BPS_3: z.number().int().positive().optional(),
    COOLDOWN_HOURS: z.number().int().positive().optional(),
    MAX_HIRES_PER_DAY: z.number().int().positive().optional(),
    IDLE_FIRE_HOURS: z.number().int().positive().optional(),
    MAX_SLIPPAGE_BPS: z.number().int().positive().optional(),
    MAX_PRICE_IMPACT_BPS: z.number().int().positive().optional(),
    MAX_COPY_EVENT_AGE_SECONDS: z.number().int().positive().optional(),
    LEADERBOARD_MAX_AGE_SECONDS: z.number().int().positive().optional(),
    MAX_LEADER_STALL_HOURS: z.number().int().positive().optional(),
    LEADER_STALL_FIRE_HOURS: z.number().int().positive().optional(),
    MIN_LEADER_SWAPS_24H: z.number().int().positive().optional(),
    ACTIVE_BUY_WINDOW_HOURS: z.number().int().positive().optional(),
    PRICE_MAX_AGE_SECONDS: z.number().int().positive().optional(),
    LOSS_STREAK_UNIT: lossStreakUnitSchema.optional(),
    FIRE_POSITION_POLICY: firePositionPolicySchema.optional(),
    COPY_SCALE: z.number().positive().max(1).optional(),
    ADMISSION_MIN_BUYS_24H: z.number().int().positive().optional(),
    ADMISSION_MAX_LAST_BUY_HOURS: z.number().int().positive().optional(),
    PROMOTION_MIN_CLOSED: z.number().int().positive().optional(),
    PROMOTION_MIN_NET_USD: z.number().int().positive().optional(),
    PROMOTION_MAX_LAST_BUY_HOURS: z.number().int().positive().optional(),
    WATCH_LIST_SIZE: z.number().int().positive().optional(),
    BENCH_TARGET: z.number().int().positive().optional(),
    ROSTER_SIZE: z.number().int().min(1).max(10).optional(),
    // 0 is a legal value: it disables the per-mint cap.
    PER_MINT_CAP_USD: z.number().int().nonnegative().optional(),
    WATCH_POLL_MS: z.number().int().min(60_000).optional(),
    ROSTER_POLL_MS: z.number().int().min(15_000).optional(),
    WATCH_DETAIL_PER_MINUTE: z.number().int().positive().optional(),
    ADMISSION_MAX_DETAILS_PER_SCAN: z.number().int().positive().optional(),
    WATCH_EVICTION_DAYS: z.number().int().positive().optional(),
    SHADOW_BACKFILL_ON_ADMIT: z.boolean().optional(),
    DISCOVERY_MIN_INTERVAL_MS: z.number().int().min(600_000).optional(),
    FOMO_PLAN_CREDITS: z.number().int().positive().optional(),
  })
  .strict();

export const settingsPatchSchema = settingsPatchObjectSchema.superRefine((patch, ctx) => {
  // Only when the patch itself carries both sides of the pair. A patch that
  // touches one of them is judged against the merged config at the API
  // boundary (riskConfigSchema), which sees the stored value of the other.
  if (
    patch.BENCH_TARGET !== undefined &&
    patch.WATCH_LIST_SIZE !== undefined &&
    patch.BENCH_TARGET > patch.WATCH_LIST_SIZE
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BENCH_TARGET'],
      message:
        `BENCH_TARGET (${patch.BENCH_TARGET}) must be <= WATCH_LIST_SIZE (${patch.WATCH_LIST_SIZE}): ` +
        'the bench is drawn from the watch list',
    });
  }
});

/**
 * The field names a settings patch may carry. The runtime uses this to filter
 * a stored full-config blob down to a patch (the exported schema is refined,
 * so its `.shape` is not reachable through it).
 */
export const SETTINGS_PATCH_KEYS = Object.keys(settingsPatchObjectSchema.shape) as Array<
  keyof z.infer<typeof settingsPatchObjectSchema>
>;

export type SettingsPatch = z.infer<typeof settingsPatchObjectSchema>;
