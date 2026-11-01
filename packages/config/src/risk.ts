import { z } from 'zod';

export const LIVE_ACK_STRING =
  'I UNDERSTAND LIVE MODE SIGNS AND SUBMITS REAL SOLANA TRANSACTIONS WITH REAL FUNDS';

export const modeSchema = z.enum(['demo', 'paper', 'live']);
export type Mode = z.infer<typeof modeSchema>;

export const lossStreakUnitSchema = z.enum(['fully_closed_position', 'every_partial_close']);
export type LossStreakUnit = z.infer<typeof lossStreakUnitSchema>;

export const firePositionPolicySchema = z.enum(['close_all_before_switch', 'keep_positions']);
export type FirePositionPolicy = z.infer<typeof firePositionPolicySchema>;

export const candidateReplacementModeSchema = z.enum(['zcode_shortlist', 'deterministic_fallback']);
export type CandidateReplacementMode = z.infer<typeof candidateReplacementModeSchema>;

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

/**
 * Full risk configuration. Monetary limits are in whole USD (converted to
 * micro-USD integers by the core money module before any arithmetic).
 */
export const riskConfigSchema = z.object({
  COPY_SCALE: z.number().positive().max(1),
  MIN_PER_BUY_USD: positiveInt('MIN_PER_BUY_USD'),
  MAX_PER_BUY_USD: positiveInt('MAX_PER_BUY_USD'),
  /** Max share of capital (equity start + realized PnL) allowed in open positions, percent. */
  MAX_DEPLOYED_PCT: z
    .number({ invalid_type_error: 'MAX_DEPLOYED_PCT must be a number' })
    .int('MAX_DEPLOYED_PCT must be an integer')
    .min(1, 'MAX_DEPLOYED_PCT must be at least 1')
    .max(100, 'MAX_DEPLOYED_PCT must be at most 100'),
  MAX_DAILY_REALIZED_LOSS_USD: positiveInt('MAX_DAILY_REALIZED_LOSS_USD'),
  /** Day-trader discipline: force-close age window (hours). */
  MAX_POSITION_AGE_HOURS: positiveInt('MAX_POSITION_AGE_HOURS'),
  /** Grace window added on top before the unconditional close (hours). */
  POSITION_GRACE_HOURS: positiveInt('POSITION_GRACE_HOURS'),
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
  RECOMMENDATION_TTL_MS: positiveInt('RECOMMENDATION_TTL_MS'),
  LOSS_STREAK_UNIT: lossStreakUnitSchema,
  FIRE_POSITION_POLICY: firePositionPolicySchema,
  CANDIDATE_REPLACEMENT_MODE: candidateReplacementModeSchema,
  FIRE_AFTER_CONSECUTIVE_LOSSES: z.literal(2).default(2),
  BREAKEVEN_RESETS_STREAK: z.boolean().default(false),
});

export type RiskConfig = z.infer<typeof riskConfigSchema>;

export const DEFAULT_RISK: RiskConfig = {
  COPY_SCALE: 0.25,
  MIN_PER_BUY_USD: 10,
  MAX_PER_BUY_USD: 250,
  MAX_DEPLOYED_PCT: 80,
  MAX_DAILY_REALIZED_LOSS_USD: 100,
  MAX_POSITION_AGE_HOURS: 16,
  POSITION_GRACE_HOURS: 3,
  IDLE_FIRE_HOURS: 12,
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
  RECOMMENDATION_TTL_MS: 10800000,
  LOSS_STREAK_UNIT: 'fully_closed_position',
  FIRE_POSITION_POLICY: 'close_all_before_switch',
  CANDIDATE_REPLACEMENT_MODE: 'zcode_shortlist',
  FIRE_AFTER_CONSECUTIVE_LOSSES: 2,
  BREAKEVEN_RESETS_STREAK: false,
};

/** Fields a settings-change request may modify at runtime. */
export const settingsPatchSchema = z
  .object({
    MIN_PER_BUY_USD: z.number().int().positive().optional(),
    MAX_PER_BUY_USD: z.number().int().positive().optional(),
    MAX_DEPLOYED_PCT: z.number().int().min(1).max(100).optional(),
    MAX_DAILY_REALIZED_LOSS_USD: z.number().int().positive().optional(),
    MAX_POSITION_AGE_HOURS: z.number().int().positive().optional(),
    POSITION_GRACE_HOURS: z.number().int().positive().optional(),
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
    RECOMMENDATION_TTL_MS: z.number().int().positive().optional(),
    LOSS_STREAK_UNIT: lossStreakUnitSchema.optional(),
    FIRE_POSITION_POLICY: firePositionPolicySchema.optional(),
    CANDIDATE_REPLACEMENT_MODE: candidateReplacementModeSchema.optional(),
    COPY_SCALE: z.number().positive().max(1).optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
