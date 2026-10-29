import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index.js';

const base = { SESSION_SECRET: 'x'.repeat(40) };

describe('loadConfig', () => {
  it('defaults to paper mode with default risk limits', () => {
    const cfg = loadConfig(base);
    expect(cfg.mode).toBe('paper');
    expect(cfg.risk.COPY_SCALE).toBe(0.25);
    expect(cfg.risk.LOSS_STREAK_UNIT).toBe('fully_closed_position');
    expect(cfg.risk.CANDIDATE_REPLACEMENT_MODE).toBe('zcode_shortlist');
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

  it('rejects deterministic_fallback-only fields only when explicitly set', () => {
    const cfg = loadConfig({ ...base, CANDIDATE_REPLACEMENT_MODE: 'deterministic_fallback' });
    expect(cfg.risk.CANDIDATE_REPLACEMENT_MODE).toBe('deterministic_fallback');
    expect(() => loadConfig({ ...base, CANDIDATE_REPLACEMENT_MODE: 'always' })).toThrow();
  });
});
