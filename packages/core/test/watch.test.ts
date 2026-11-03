import { describe, expect, it } from 'vitest';
import { canPromote, canReenter, ceilingAction, type PromotionConfig } from '../src/watch.js';
import { isIdleOver } from '../src/positionAge.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const config: PromotionConfig = {
  promotionMinClosed: 8,
  promotionMinNetUsdMicro: 3_000_000n,
  promotionMaxLastBuyHours: 4,
};

const passing = {
  aggregates: { closedCount: 8, netPnlUsdMicro: 4_000_000n, lastClosedAt: iso(NOW - HOUR) },
  lastFundedBuyAt: iso(NOW - 2 * HOUR),
  lastFiredAt: null,
  nowMs: NOW,
  config,
  slotsFree: 1,
};

describe('canPromote — the D4 promotion gate (AC6)', () => {
  it('promotes when every condition holds', () => {
    expect(canPromote(passing)).toEqual({ ok: true, reason: null });
  });

  it('blocks with the specific reason for each failing condition', () => {
    expect(canPromote({ ...passing, aggregates: { ...passing.aggregates, closedCount: 7 } }).reason).toBe(
      'FEWER_THAN_K_CLOSED',
    );
    expect(
      canPromote({ ...passing, aggregates: { ...passing.aggregates, netPnlUsdMicro: 3_000_000n } }).reason,
    ).toBe('NET_BELOW_THRESHOLD');
    expect(canPromote({ ...passing, lastFundedBuyAt: iso(NOW - 4 * HOUR - 1) }).reason).toBe(
      'LAST_BUY_TOO_OLD',
    );
    expect(canPromote({ ...passing, lastFundedBuyAt: null }).reason).toBe('LAST_BUY_TOO_OLD');
    expect(
      canPromote({ ...passing, lastFiredAt: iso(NOW - HOUR), lastFundedBuyAt: iso(NOW - 2 * HOUR) }).reason,
    ).toBe('REENTRY_BANNED');
    expect(canPromote({ ...passing, slotsFree: 0 }).reason).toBe('NO_SLOT');
  });

  it('the newest close does not matter: the gates are K, net, recency, re-entry, slot', () => {
    expect(canPromote({ ...passing, aggregates: { ...passing.aggregates, lastClosedAt: null } }).ok).toBe(
      true,
    );
  });

  it('capital headroom is not a gate: a proved wallet is hired, then trades when room frees', () => {
    // Operator decision (2026-11-03): the hire gate judges the wallet, not the
    // bankroll. Zero deployed room must still admit a proved leader.
    expect(canPromote(passing).ok).toBe(true);
    expect(Object.keys(passing)).not.toContain('headroomUsdMicro');
  });

  it('the fomo PnL mark is not an input at all (D4: context only)', () => {
    expect(Object.keys(passing)).not.toContain('pnl24hUsd');
  });
});

describe('canReenter — no timed cooldown, a post-fire buy (AC7)', () => {
  it('never-fired wallets may return', () => {
    expect(canReenter({ lastFiredAt: null, lastFundedBuyAt: null })).toBe(true);
  });

  it('a fired trader with no buy since the fire is banned', () => {
    expect(canReenter({ lastFiredAt: iso(NOW - HOUR), lastFundedBuyAt: null })).toBe(false);
    expect(canReenter({ lastFiredAt: iso(NOW - HOUR), lastFundedBuyAt: iso(NOW - 2 * HOUR) })).toBe(false);
    expect(canReenter({ lastFiredAt: iso(NOW - HOUR), lastFundedBuyAt: iso(NOW - HOUR) })).toBe(false);
  });

  it('a funded buy observed after the fire lifts the ban', () => {
    expect(canReenter({ lastFiredAt: iso(NOW - HOUR), lastFundedBuyAt: iso(NOW - 60_000) })).toBe(true);
  });
});

describe('ceilingAction — D4 8h + 3h ceiling (AC5)', () => {
  const entry = 1_000_000n; // $1.00 per token
  const openedAt = iso(NOW - 8 * HOUR);

  it('does nothing before the deadline', () => {
    expect(
      ceilingAction({
        openedAt: iso(NOW - 7 * HOUR),
        nowMs: NOW,
        maxAgeHours: 8,
        graceHours: 3,
        markUsdMicro: 2_000_000n,
        entryUsdMicro: entry,
      }),
    ).toBe('none');
  });

  it('closes at the deadline when the mark is positive', () => {
    expect(
      ceilingAction({
        openedAt,
        nowMs: NOW,
        maxAgeHours: 8,
        graceHours: 3,
        markUsdMicro: 1_500_000n,
        entryUsdMicro: entry,
      }),
    ).toBe('close_now');
  });

  it('a non-positive mark rides to the grace deadline, then closes', () => {
    const args = {
      openedAt,
      maxAgeHours: 8,
      graceHours: 3,
      markUsdMicro: 800_000n,
      entryUsdMicro: entry,
    };
    expect(ceilingAction({ ...args, nowMs: NOW })).toBe('close_at_grace'); // 8h
    expect(ceilingAction({ ...args, nowMs: NOW + 2.9 * HOUR })).toBe('close_at_grace'); // 10.9h
    expect(ceilingAction({ ...args, nowMs: NOW + 3 * HOUR })).toBe('close_now'); // 11h
  });

  it('a break-even mark is not positive: it rides to grace', () => {
    expect(
      ceilingAction({
        openedAt,
        nowMs: NOW,
        maxAgeHours: 8,
        graceHours: 3,
        markUsdMicro: entry,
        entryUsdMicro: entry,
      }),
    ).toBe('close_at_grace');
  });

  it('never closes without a usable quote — the caller retries next tick', () => {
    expect(
      ceilingAction({
        openedAt,
        nowMs: NOW + 10 * HOUR,
        maxAgeHours: 8,
        graceHours: 3,
        markUsdMicro: null,
        entryUsdMicro: entry,
      }),
    ).toBe('none');
  });
});

/**
 * The operator's scenarios (D4/D5 evidence). The idle clock itself is the
 * pre-existing rule: the baseline is max(hire time, the last time a position
 * was held) and the fire lands IDLE_FIRE_HOURS later.
 */
describe('operator scenarios (8h idle / 14h after a close / no old-record return)', () => {
  it('0 trades: a hire with no positions fires after 8h', () => {
    const hiredAt = NOW;
    const idleFireHours = 8;
    expect(isIdleOver({ baselineIso: iso(hiredAt), nowMs: hiredAt + 7.9 * HOUR, idleFireHours })).toBe(false);
    expect(isIdleOver({ baselineIso: iso(hiredAt), nowMs: hiredAt + 8 * HOUR, idleFireHours })).toBe(true);
  });

  it('one trade closed at 6h: the idle clock restarts and fires at 14h', () => {
    const hiredAt = NOW;
    const lastPositionHeldAt = hiredAt + 6 * HOUR; // the 6h close
    const baselineIso = iso(Math.max(hiredAt, lastPositionHeldAt));
    const idleFireHours = 8;
    expect(isIdleOver({ baselineIso, nowMs: hiredAt + 13.9 * HOUR, idleFireHours })).toBe(false);
    expect(isIdleOver({ baselineIso, nowMs: hiredAt + 14 * HOUR, idleFireHours })).toBe(true);
  });

  it('a fired trader is not re-promoted on the old record', () => {
    const firedAt = iso(NOW - 30 * HOUR);
    // Strong record, but every funded buy predates the fire.
    expect(
      canPromote({
        ...passing,
        aggregates: { closedCount: 12, netPnlUsdMicro: 50_000_000n, lastClosedAt: iso(NOW - 31 * HOUR) },
        lastFiredAt: firedAt,
        lastFundedBuyAt: iso(NOW - 40 * HOUR),
      }),
    ).toMatchObject({ ok: false });
    // …and a buy after the fire brings him back.
    expect(
      canPromote({
        ...passing,
        lastFiredAt: firedAt,
        lastFundedBuyAt: iso(NOW - 2 * HOUR),
      }),
    ).toEqual({ ok: true, reason: null });
  });
});
