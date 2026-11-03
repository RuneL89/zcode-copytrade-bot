import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';
import { DEFAULT_RISK, riskConfigSchema, settingsPatchSchema } from '../src/risk.js';

const base = { SESSION_SECRET: 'x'.repeat(40) };

/** D4's decided thresholds (plan 02 table) — defaults must equal these. */
const D4_DEFAULTS = {
  ADMISSION_MIN_BUYS_24H: 3,
  ADMISSION_MAX_LAST_BUY_HOURS: 24,
  PROMOTION_MIN_CLOSED: 8,
  PROMOTION_MIN_NET_USD: 3,
  WATCH_LIST_SIZE: 20,
  BENCH_TARGET: 10,
  ROSTER_SIZE: 5,
  PER_MINT_CAP_USD: 0,
  WATCH_POLL_MS: 300000,
  ROSTER_POLL_MS: 45000,
  COOLING_SCAN_MS: 7200000,
  WATCH_EVICTION_DAYS: 14,
  SHADOW_BACKFILL_ON_ADMIT: true,
  DISCOVERY_MIN_INTERVAL_MS: 1800000,
} as const;

describe('loadConfig', () => {
  it('defaults to paper mode with default risk limits', () => {
    const cfg = loadConfig(base);
    expect(cfg.mode).toBe('paper');
    expect(cfg.risk.COPY_SCALE).toBe(0.25);
    expect(cfg.risk.LOSS_STREAK_UNIT).toBe('fully_closed_position');
    expect(cfg.risk.FIRE_POSITION_POLICY).toBe('close_all_before_switch');
  });

  it('coerces risk numbers from env strings', () => {
    const cfg = loadConfig({ ...base, MIN_PER_BUY_USD: '20', MAX_SLIPPAGE_BPS: '150' });
    expect(cfg.risk.MIN_PER_BUY_USD).toBe(20);
    expect(cfg.risk.MAX_SLIPPAGE_BPS).toBe(150);
  });

  it('rejects bad modes and negative limits', () => {
    expect(() => loadConfig({ ...base, MODE: 'real' })).toThrow();
    expect(() => loadConfig({ ...base, MIN_PER_BUY_USD: '-5' })).toThrow();
  });

  it('rejects short session secrets', () => {
    expect(() => loadConfig({ SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects MAX_PER_BUY_USD below MIN_PER_BUY_USD and accepts equality (AC7)', () => {
    const inverted = riskConfigSchema.safeParse({
      ...DEFAULT_RISK,
      MIN_PER_BUY_USD: 20,
      MAX_PER_BUY_USD: 5,
    });
    expect(inverted.success).toBe(false);
    if (!inverted.success) {
      const issue = inverted.error.issues.find((i) => i.path.join('.') === 'MAX_PER_BUY_USD');
      expect(issue?.message).toMatch(/MAX_PER_BUY_USD \(5\) must be >= MIN_PER_BUY_USD \(20\)/);
    }

    const equal = riskConfigSchema.safeParse({ ...DEFAULT_RISK, MIN_PER_BUY_USD: 5, MAX_PER_BUY_USD: 5 });
    expect(equal.success).toBe(true);

    // The same inverted pair is refused through the env loader end to end.
    expect(() => loadConfig({ ...base, MIN_PER_BUY_USD: '20', MAX_PER_BUY_USD: '5' })).toThrow(
      /must be >= MIN_PER_BUY_USD/,
    );
  });

  it('carries the D4 thresholds with exactly the decided defaults (AC8)', () => {
    const cfg = loadConfig(base);
    const actual = Object.fromEntries(
      Object.keys(D4_DEFAULTS).map((k) => [k, cfg.risk[k as keyof typeof D4_DEFAULTS]]),
    );
    expect(actual).toEqual(D4_DEFAULTS);
    // and the same through the bare default object the Settings API rebases on
    expect(DEFAULT_RISK.BENCH_TARGET).toBe(10);
    expect(DEFAULT_RISK.WATCH_LIST_SIZE).toBe(20);
    expect(DEFAULT_RISK.SHADOW_BACKFILL_ON_ADMIT).toBe(true);
  });

  it('accepts every new field as a patch, including PER_MINT_CAP_USD = 0 (AC9)', () => {
    const patch = {
      ADMISSION_MIN_BUYS_24H: 4,
      ADMISSION_MAX_LAST_BUY_HOURS: 12,
      PROMOTION_MIN_CLOSED: 6,
      PROMOTION_MIN_NET_USD: 5,
      WATCH_LIST_SIZE: 25,
      BENCH_TARGET: 12,
      ROSTER_SIZE: 3,
      PER_MINT_CAP_USD: 0,
      WATCH_POLL_MS: 120000,
      ROSTER_POLL_MS: 20000,
      COOLING_SCAN_MS: 3600000,
      WATCH_EVICTION_DAYS: 7,
      SHADOW_BACKFILL_ON_ADMIT: false,
      DISCOVERY_MIN_INTERVAL_MS: 900000,
    };
    expect(settingsPatchSchema.parse(patch)).toEqual(patch);
    expect(settingsPatchSchema.safeParse({ PER_MINT_CAP_USD: 0 }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ PER_MINT_CAP_USD: 10 }).success).toBe(true);
  });

  it('rejects the invalid values the plan names (AC9)', () => {
    expect(settingsPatchSchema.safeParse({ BENCH_TARGET: 50, WATCH_LIST_SIZE: 20 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ROSTER_SIZE: 0 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ROSTER_SIZE: 11 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ PER_MINT_CAP_USD: -1 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ WATCH_POLL_MS: 59999 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ROSTER_POLL_MS: 10000 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ DISCOVERY_MIN_INTERVAL_MS: 60000 }).success).toBe(false);
    // Whole-config invariants hold through the full schema as well.
    expect(riskConfigSchema.safeParse({ ...DEFAULT_RISK, BENCH_TARGET: 21 }).success).toBe(false);
    expect(
      riskConfigSchema.safeParse({ ...DEFAULT_RISK, WATCH_LIST_SIZE: 20, BENCH_TARGET: 20 }).success,
    ).toBe(true);
  });

  it('the new fields load from env strings and the bench invariant bites there too', () => {
    const cfg = loadConfig({ ...base, WATCH_LIST_SIZE: '25', ROSTER_SIZE: '4', PER_MINT_CAP_USD: '0' });
    expect(cfg.risk.WATCH_LIST_SIZE).toBe(25);
    expect(cfg.risk.ROSTER_SIZE).toBe(4);
    expect(cfg.risk.PER_MINT_CAP_USD).toBe(0);
    expect(() => loadConfig({ ...base, BENCH_TARGET: '30' })).toThrow(/must be <= WATCH_LIST_SIZE/);
  });
});
