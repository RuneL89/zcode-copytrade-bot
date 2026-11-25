import { describe, expect, it } from 'vitest';
import { canPromote, canReenter, ceilingAction, stallDecision, type PromotionConfig } from '../src/watch.js';
import { isIdleOver } from '../src/positionAge.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const config: PromotionConfig = {
  promotionMinClosed: 8,
  promotionMinNetUsdMicro: 3_000_000n,
  promotionMaxLastBuyHours: 4,
  promotionMaxClosesPerHour: 12,
  cooldownHours: 3,
};

const passing = {
  aggregates: {
    closedCount: 8,
    netPnlUsdMicro: 4_000_000n,
    lastClosedAt: iso(NOW - HOUR),
    firstClosedAt: iso(NOW - 8 * HOUR),
  },
  lastFundedBuyAt: iso(NOW - 2 * HOUR),
  lastFiredAt: null,
  nowMs: NOW,
  anotherHiredSinceFire: false,
  freeChair: true,
  config,
};

describe('canPromote — the bench gate (AC6)', () => {
  it('benches a wallet when every record condition holds', () => {
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
  });

  it('rejects a machine-speed sample (incident 2026-11-25: Qwerty54321)', () => {
    // 8 closes inside 20 minutes = 24/hour, over the 12/hour ceiling: however
    // profitable, the copier cannot mirror that rate and observing it blows
    // the credit budget.
    const fast = canPromote({
      ...passing,
      aggregates: { ...passing.aggregates, firstClosedAt: iso(NOW - 20 * 60_000) },
    });
    expect(fast).toEqual({ ok: false, reason: 'SAMPLE_TOO_FAST' });
    // A human-paced sample of the same size passes: 8 closes across 8 hours.
    expect(canPromote(passing).ok).toBe(true);
    // An event machine never escapes the gate by waiting: the span runs to
    // now, and a full sample inside the first minutes is still too fast an
    // hour later only if recent closes kept it fast — a wallet that has been
    // quiet for hours is judged on its whole history.
    const quiet = canPromote({
      ...passing,
      aggregates: { ...passing.aggregates, firstClosedAt: iso(NOW - 30 * HOUR) },
    });
    expect(quiet.ok).toBe(true);
    // Without a first-close timestamp the gate cannot run: the sample passes
    // (fail open for legacy records, never for a refusal reason).
    const noSpan = canPromote({
      ...passing,
      aggregates: { ...passing.aggregates, firstClosedAt: null },
    });
    expect(noSpan).toEqual({ ok: true, reason: null });
  });

  it('a hire of another trader after the firing lifts the re-entry ban', () => {
    expect(
      canPromote({
        ...passing,
        lastFiredAt: iso(NOW - HOUR),
        anotherHiredSinceFire: true,
      }),
    ).toEqual({ ok: true, reason: null });
  });

  it('the newest close does not matter: the gates are K, net, recency, re-entry', () => {
    expect(canPromote({ ...passing, aggregates: { ...passing.aggregates, lastClosedAt: null } }).ok).toBe(
      true,
    );
  });

  it('a chair is not part of the gate: the bench pre-builds while the roster is full', () => {
    // Operator decision (2026-11-03): the bench is the ordered list of wallets
    // that would take a chair when one frees — like a basketball bench. Only
    // the hire checks for a free seat.
    expect(canPromote(passing).ok).toBe(true);
    expect(Object.keys(passing)).not.toContain('slotsFree');
  });

  it('capital headroom is not a gate: a proved wallet is benched, then hired', () => {
    // Operator decision (2026-11-03): the gate judges the wallet, not the
    // bankroll. Zero deployed room must still admit a proved leader.
    expect(canPromote(passing).ok).toBe(true);
    expect(Object.keys(passing)).not.toContain('headroomUsdMicro');
  });

  it('the fomo PnL mark is not an input at all (D4: context only)', () => {
    expect(Object.keys(passing)).not.toContain('pnl24hUsd');
  });
});

describe('canReenter — another hire, or the cooldown with a free chair (AC7)', () => {
  const base = {
    lastFiredAt: iso(NOW),
    nowMs: NOW,
    cooldownHours: 3,
    anotherHiredSinceFire: false,
    freeChair: true,
  };

  it('never-fired wallets may return', () => {
    expect(canReenter({ ...base, lastFiredAt: null })).toBe(true);
  });

  it('blocks immediately after the firing, even with a free chair', () => {
    expect(canReenter(base)).toBe(false);
    expect(canReenter({ ...base, nowMs: NOW + 3 * HOUR - 1 })).toBe(false);
  });

  it('opens the timed path at the cooldown boundary when a chair is free', () => {
    expect(canReenter({ ...base, nowMs: NOW + 3 * HOUR })).toBe(true);
    expect(canReenter({ ...base, nowMs: NOW + 3 * HOUR, freeChair: false })).toBe(false);
  });

  it('another trader hired after the firing lifts the block immediately', () => {
    expect(canReenter({ ...base, anotherHiredSinceFire: true, nowMs: NOW + 60_000, freeChair: false })).toBe(
      true,
    );
  });

  it('fails closed on an unreadable firing timestamp or clock', () => {
    expect(canReenter({ ...base, lastFiredAt: 'not-a-date' })).toBe(false);
    expect(canReenter({ ...base, nowMs: Number.NaN })).toBe(false);
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

  it('a fired trader keeps his record but waits out the re-entry block', () => {
    const firedAt = iso(NOW - HOUR);
    const strong = {
      ...passing,
      aggregates: { closedCount: 12, netPnlUsdMicro: 50_000_000n, lastClosedAt: iso(NOW - 31 * HOUR) },
      lastFiredAt: firedAt,
      lastFundedBuyAt: iso(NOW - 30 * 60_000),
    };
    // The old record still passes K/net/recency, but the re-entry block holds.
    expect(canPromote(strong)).toMatchObject({ ok: false, reason: 'REENTRY_BANNED' });
    // A hire of another trader after the firing re-opens the same gates.
    expect(canPromote({ ...strong, anotherHiredSinceFire: true })).toEqual({ ok: true, reason: null });
    // Or the 3h path with a free chair.
    expect(canPromote({ ...strong, nowMs: NOW + 3 * HOUR })).toEqual({ ok: true, reason: null });
    expect(canPromote({ ...strong, nowMs: NOW + 3 * HOUR, freeChair: false })).toMatchObject({
      ok: false,
      reason: 'REENTRY_BANNED',
    });
  });
});

describe('stallDecision — the same clock as promotion', () => {
  const fresh = iso(NOW - 30 * 60_000);
  const base = {
    nowMs: NOW,
    activityCheckedAt: fresh,
    activityFreshMs: 6 * HOUR,
    stallHours: 8,
  };

  it('does not fire a seat that has not yet sat for a full stall window', () => {
    expect(
      stallDecision({
        ...base,
        startedAtIso: iso(NOW - 5 * 60_000),
        lastFundedBuyAt: iso(NOW - 45 * 60_000),
        lastSwapAt: iso(NOW - 11 * HOUR),
      }),
    ).toEqual({ fire: false, silentHours: null });
  });

  it('trusts a funded buy that is newer than an old activity sample', () => {
    const decision = stallDecision({
      ...base,
      startedAtIso: iso(NOW - 9 * HOUR),
      lastFundedBuyAt: iso(NOW - 45 * 60_000),
      lastSwapAt: iso(NOW - 11 * HOUR),
    });
    expect(decision.fire).toBe(false);
    expect(decision.silentHours).toBeLessThan(1);
  });

  it('fires once the shared stamp and the seat are both older than the stall window', () => {
    const decision = stallDecision({
      ...base,
      startedAtIso: iso(NOW - 9 * HOUR),
      lastFundedBuyAt: iso(NOW - 10 * HOUR),
      lastSwapAt: iso(NOW - 11 * HOUR),
    });
    expect(decision.fire).toBe(true);
    expect(decision.silentHours).toBeGreaterThan(8);
  });
});
