import { describe, expect, it } from 'vitest';
import {
  CreditGovernor,
  DAILY_HARD_CAP,
  EXPECTED_DAILY,
  FREE_PLAN_CREDITS,
  GovernedSpendError,
  HEALTH_INTERVAL_MS,
  JupiterScheduler,
  MONTH_AMBER,
  MONTH_DAYS,
  MONTH_EXITS_ONLY,
  MONTH_RED,
  MONTH_ROSTER_ONLY,
  PATH_BUDGETS,
  RateLanes,
  WatchListCap,
  WatchListFullError,
  applyPlan,
  assertProjectedMonth,
  governedCall,
  healthSamplesPerDay,
  nominalDayPlan,
  planCredits,
  reconcileUsage,
  run429Storm,
  streamOutagePlan,
  summedDailyCap,
  summedExpected,
} from '../src/budget.js';
import { guardExitMode } from '../src/exitGuard.js';
import { assertTimersAvoidFullHistory, findFullHistoryInTimers } from '../src/callPattern.js';

const T0 = Date.parse('2026-11-14T12:00:00.000Z');

describe('budget table', () => {
  it('locks the free-plan numbers the acceptance bar is written against', () => {
    expect(summedDailyCap(false)).toBe(DAILY_HARD_CAP);
    expect(DAILY_HARD_CAP).toBe(13_600);
    expect(summedExpected()).toBe(EXPECTED_DAILY);
    expect(EXPECTED_DAILY).toBe(5_796);
    expect(PATH_BUDGETS.outage.capPerDay).toBe(6_000);
    expect(PATH_BUDGETS.roster.exempt).toBe(true);
    expect(PATH_BUDGETS.exit.exempt).toBe(true);
    expect(PATH_BUDGETS.outage.exempt).toBe(true);
    // A month of hard-cap days plus a full outage overdraft every day still
    // sits under the 60% ceiling: (13600 + 6000) * 30 = 588000.
    const worstMonth = (DAILY_HARD_CAP + PATH_BUDGETS.outage.capPerDay) * MONTH_DAYS;
    expect(worstMonth).toBe(588_000);
    expect(worstMonth).toBeLessThanOrEqual(MONTH_ROSTER_ONLY);
    expect(MONTH_ROSTER_ONLY / FREE_PLAN_CREDITS).toBe(0.6);
  });

  it('fails CI when a projected month exceeds 600,000', () => {
    expect(() => assertProjectedMonth(EXPECTED_DAILY * MONTH_DAYS)).not.toThrow();
    expect(() => assertProjectedMonth(MONTH_ROSTER_ONLY)).not.toThrow();
    expect(() => assertProjectedMonth(MONTH_ROSTER_ONLY + 1)).toThrow(/exceeds the 600000 ceiling/);
    // The postmortem's roster loop alone: 96,000/day.
    expect(() => assertProjectedMonth(96_000 * MONTH_DAYS)).toThrow(/exceeds the 600000 ceiling/);
  });
});

describe('nominal day call pattern', () => {
  it('spends the expected 5,796 and stays inside every path cap', () => {
    expect(planCredits(nominalDayPlan())).toBe(EXPECTED_DAILY);
    expect(healthSamplesPerDay()).toBe(96);
    expect(healthSamplesPerDay(60_000)).toBe(1_440);

    const governor = new CreditGovernor();
    const decisions = applyPlan(governor, nominalDayPlan(), T0);
    expect(decisions.every((decision) => decision.ok)).toBe(true);

    const snap = governor.snapshot(T0);
    expect(snap.dayTotal).toBe(EXPECTED_DAILY);
    expect(snap.byPath.roster).toBe(PATH_BUDGETS.roster.expectedPerDay);
    expect(snap.byPath.exit).toBe(300);
    expect(snap.byPath.wallet).toBe(300);
    expect(snap.byPath.watch).toBe(800);
    expect(snap.byPath.vetting).toBe(1_500);
    expect(snap.byPath.agent).toBe(600);
    expect(snap.byPath.token).toBe(200);
    expect(snap.byPath.health).toBe(96);
    expect(snap.byPath.outage).toBe(0);
    for (const [path, budget] of Object.entries(PATH_BUDGETS)) {
      expect(snap.byPath[path as keyof typeof snap.byPath]).toBeLessThanOrEqual(budget.capPerDay);
    }
    expect(snap.dayTotal).toBeLessThanOrEqual(DAILY_HARD_CAP);
    assertProjectedMonth(snap.dayTotal * MONTH_DAYS);

    const methods = new Set(snap.ledger.map((row) => row.method));
    expect(methods.has('getTransactionsForAddress')).toBe(true);
    const fullHistoryPaths = new Set(
      snap.ledger.filter((row) => row.method === 'getTransactionsForAddress').map((row) => row.path),
    );
    expect(fullHistoryPaths).toEqual(new Set(['vetting', 'agent']));
  });

  it('rejects a 60-second health loop once the health cap is spent', () => {
    const governor = new CreditGovernor();
    const samples = healthSamplesPerDay(60_000);
    let accepted = 0;
    for (let i = 0; i < samples; i++) {
      const decision = governor.spend({ path: 'health', method: 'getSlot', atMs: T0 });
      if (decision.ok) accepted++;
    }
    expect(samples).toBeGreaterThan(PATH_BUDGETS.health.capPerDay);
    expect(accepted).toBe(PATH_BUDGETS.health.capPerDay);
    expect(HEALTH_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});

describe('signature-first outage fallback', () => {
  it('never records getTransactionsForAddress and stops at the 6,000 overdraft', () => {
    const plan = streamOutagePlan(24);
    expect(plan.every((item) => item.method !== 'getTransactionsForAddress')).toBe(true);
    expect(planCredits(plan)).toBeGreaterThan(PATH_BUDGETS.outage.capPerDay);

    const governor = new CreditGovernor();
    const decisions = applyPlan(governor, plan, T0);
    const snap = governor.snapshot(T0);
    expect(snap.byPath.outage).toBe(PATH_BUDGETS.outage.capPerDay);
    expect(snap.byPath.roster).toBe(0);
    expect(decisions.some((decision) => !decision.ok && decision.reason === 'path_cap')).toBe(true);
    const methods = new Set(snap.ledger.map((row) => row.method));
    expect(methods).toEqual(new Set(['getSignaturesForAddress', 'getTransaction']));
  });

  it('bans full-history polling on the roster path even when the bucket has room', () => {
    const governor = new CreditGovernor();
    const decision = governor.spend({
      path: 'roster',
      method: 'getTransactionsForAddress',
      atMs: T0,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('banned_method');
    expect(decision.credits).toBe(0);
    expect(governor.snapshot(T0).dayTotal).toBe(0);
    // The same method is legal on the vetting path.
    const allowed = governor.spend({
      path: 'vetting',
      method: 'getTransactionsForAddress',
      atMs: T0,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.credits).toBe(10);
  });
});

describe('ring-fence, throttle storm, and the degrade ladder', () => {
  it('stops watch fallback when the bucket cannot fit the call, without touching roster', () => {
    const governor = new CreditGovernor();
    // Stay under the 75% amber line, then ask for more than the cap allows.
    const underAmber = Math.floor(PATH_BUDGETS.watch.capPerDay * 0.75) - 1;
    expect(
      governor.spend({
        path: 'watch',
        method: 'getSignaturesForAddress',
        atMs: T0,
        units: underAmber,
        fallback: true,
      }).ok,
    ).toBe(true);
    const denied = governor.spend({
      path: 'watch',
      method: 'getSignaturesForAddress',
      atMs: T0,
      units: PATH_BUDGETS.watch.capPerDay,
      fallback: true,
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe('path_cap');
    expect(governor.spend({ path: 'roster', method: 'getSignaturesForAddress', atMs: T0 }).ok).toBe(true);
    expect(governor.snapshot(T0).byPath.roster).toBe(1);
    expect(governor.snapshot(T0).byPath.watch).toBe(underAmber);
  });

  it('stops Helius watch fallback at amber and keeps exits running', () => {
    const governor = new CreditGovernor();
    governor.setReportedUsage(MONTH_AMBER);
    expect(governor.level(T0)).toBe('amber');
    const watch = governor.spend({
      path: 'watch',
      method: 'getSignaturesForAddress',
      atMs: T0,
      fallback: true,
    });
    expect(watch.ok).toBe(false);
    expect(watch.reason).toBe('paused');
    const exit = governor.spend({ path: 'exit', method: 'getSignatureStatuses', atMs: T0 });
    expect(exit.ok).toBe(true);
  });

  it('pauses vetting, agent, token, and wallet at red; roster and exit stay open', () => {
    const governor = new CreditGovernor();
    governor.setReportedUsage(MONTH_RED);
    expect(governor.level(T0)).toBe('red');
    for (const path of ['vetting', 'agent', 'token', 'wallet'] as const) {
      const decision = governor.spend({ path, method: 'getAccountInfo', atMs: T0 });
      expect(decision.reason).toBe('paused');
    }
    expect(governor.spend({ path: 'roster', method: 'getTransaction', atMs: T0 }).ok).toBe(true);
    expect(governor.spend({ path: 'exit', method: 'sendTransaction', atMs: T0 }).ok).toBe(true);
    expect(governor.spend({ path: 'health', method: 'getSlot', atMs: T0 }).ok).toBe(true);
  });

  it('freezes new hires at the 60% month line and leaves only exits at 900k', () => {
    const rosterOnly = new CreditGovernor();
    rosterOnly.setReportedUsage(MONTH_ROSTER_ONLY);
    expect(rosterOnly.level(T0)).toBe('roster-only');
    expect(rosterOnly.spend({ path: 'vetting', method: 'getAccountInfo', atMs: T0 }).reason).toBe('paused');
    expect(rosterOnly.spend({ path: 'health', method: 'getSlot', atMs: T0 }).reason).toBe('paused');
    expect(rosterOnly.spend({ path: 'roster', method: 'getTransaction', atMs: T0 }).ok).toBe(true);
    expect(rosterOnly.spend({ path: 'exit', method: 'getSignatureStatuses', atMs: T0 }).ok).toBe(true);

    const exitsOnly = new CreditGovernor();
    exitsOnly.setReportedUsage(MONTH_EXITS_ONLY);
    expect(exitsOnly.level(T0)).toBe('exits-only');
    expect(exitsOnly.spend({ path: 'exit', method: 'getSignatureStatuses', atMs: T0 }).ok).toBe(true);
    expect(exitsOnly.spend({ path: 'roster', method: 'getSignaturesForAddress', atMs: T0 }).ok).toBe(true);
    expect(exitsOnly.spend({ path: 'watch', method: 'getSignaturesForAddress', atMs: T0 }).reason).toBe(
      'paused',
    );
  });

  it('turns amber when a non-exempt path crosses 75% and does not do so for health', () => {
    const governor = new CreditGovernor();
    const trigger = Math.floor(PATH_BUDGETS.wallet.capPerDay * 0.75);
    for (let i = 0; i < trigger; i++) {
      expect(governor.spend({ path: 'wallet', method: 'getBalance', atMs: T0 }).ok).toBe(true);
    }
    expect(governor.level(T0)).toBe('amber');

    const health = new CreditGovernor();
    for (let i = 0; i < 96; i++) {
      expect(health.spend({ path: 'health', method: 'getSlot', atMs: T0 }).ok).toBe(true);
    }
    expect(health.level(T0)).toBe('green');
  });

  it('resets a path at the next local day and does not roll unused credit sideways', () => {
    const governor = new CreditGovernor();
    governor.spend({ path: 'watch', method: 'getSignaturesForAddress', atMs: T0, units: 100 });
    const nextDay = T0 + 24 * 3_600_000;
    expect(governor.daySpend('watch', nextDay)).toBe(0);
    expect(governor.daySpend('roster', T0)).toBe(0);
    const again = governor.spend({
      path: 'watch',
      method: 'getSignaturesForAddress',
      atMs: nextDay,
      units: PATH_BUDGETS.watch.capPerDay,
    });
    expect(again.ok).toBe(true);
    expect(governor.monthMetered(nextDay)).toBe(100 + PATH_BUDGETS.watch.capPerDay);
  });

  it('trusts the higher of the meter and the Helius-reported usage', () => {
    const quiet = reconcileUsage(100, 105);
    expect(quiet.used).toBe(105);
    expect(quiet.alert).toBe(false);
    const drifted = reconcileUsage(100, 111);
    expect(drifted.used).toBe(111);
    expect(drifted.alert).toBe(true);
    expect(reconcileUsage(100, null).alert).toBe(false);

    const governor = new CreditGovernor();
    governor.spend({ path: 'roster', method: 'getTransaction', atMs: T0, units: 10 });
    governor.setReportedUsage(50);
    expect(governor.monthUsed(T0)).toBe(50);
  });
});

describe('429 storm and rate lanes', () => {
  it('keeps every exit completed or queued and backs background traffic off', () => {
    const storm = run429Storm();
    expect(storm.hours).toBe(12);
    expect(storm.chairsFrozen).toBe(0);
    expect(storm.exitBackoffDenials).toBe(0);
    expect(storm.exitsCompleted + storm.exitsQueued).toBe(5);
    expect(storm.exitsCompleted).toBe(5);
    expect(storm.backgroundBackedOff).toBeGreaterThan(0);
    expect(storm.backgroundDeniedByBackoff).toBeGreaterThan(0);
    expect(storm.backgroundSent).toBeGreaterThan(0);
  });

  it('does not put the exit lane into backoff denial', () => {
    const governor = new CreditGovernor();
    governor.note429('exit', T0);
    expect(governor.spend({ path: 'exit', method: 'getSignatureStatuses', atMs: T0 + 1 }).ok).toBe(true);
    governor.note429('watch', T0);
    const denied = governor.spend({
      path: 'watch',
      method: 'getSignaturesForAddress',
      atMs: T0 + 1,
      fallback: true,
    });
    expect(denied.reason).toBe('backoff');
    const later = governor.spend({
      path: 'watch',
      method: 'getSignaturesForAddress',
      atMs: T0 + 1_000,
      fallback: true,
    });
    expect(later.ok).toBe(true);
  });

  it('reserves 3 req/s for exits and holds background to 5', () => {
    const lanes = new RateLanes();
    let background = 0;
    for (let i = 0; i < 10; i++) background += lanes.tryAcquire('background', T0) ? 1 : 0;
    expect(background).toBe(5);
    let exits = 0;
    for (let i = 0; i < 10; i++) exits += lanes.tryAcquire('exit', T0) ? 1 : 0;
    expect(exits).toBe(5);

    const exitFirst = new RateLanes();
    let exitsOnly = 0;
    for (let i = 0; i < 12; i++) exitsOnly += exitFirst.tryAcquire('exit', T0) ? 1 : 0;
    expect(exitsOnly).toBe(10);
    expect(exitFirst.tryAcquire('background', T0)).toBe(false);
  });

  it('does not call Helius when the governor has already refused', async () => {
    const governor = new CreditGovernor();
    governor.setReportedUsage(MONTH_AMBER);
    let sends = 0;
    await expect(
      governedCall({
        governor,
        path: 'watch',
        method: 'getSignaturesForAddress',
        atMs: T0,
        fallback: true,
        send: async () => {
          sends++;
          return 'nope';
        },
      }),
    ).rejects.toBeInstanceOf(GovernedSpendError);
    expect(sends).toBe(0);
  });

  it('records a 429 from the provider and then refuses the next background call', async () => {
    const governor = new CreditGovernor();
    await expect(
      governedCall({
        governor,
        path: 'watch',
        method: 'getSignaturesForAddress',
        atMs: T0,
        fallback: true,
        send: async () => {
          throw new Error('helius: rate limited (429); backing off');
        },
      }),
    ).rejects.toThrow(/429/);
    await expect(
      governedCall({
        governor,
        path: 'watch',
        method: 'getSignaturesForAddress',
        atMs: T0 + 10,
        fallback: true,
        send: async () => 'should-not-send',
      }),
    ).rejects.toBeInstanceOf(GovernedSpendError);
  });
});

describe('watch-list cap and exit mode guard', () => {
  it('refuses the 21st wallet and a 102-wallet admission attempt', () => {
    const cap = new WatchListCap(20);
    for (let i = 0; i < 20; i++) cap.admit(`wallet-${i}`);
    expect(cap.size).toBe(20);
    expect(() => cap.admit('wallet-20')).toThrow(WatchListFullError);
    let accepted = 0;
    let refused = 0;
    const flood = new WatchListCap(20);
    for (let i = 0; i < 102; i++) {
      try {
        flood.admit(`w-${i}`);
        accepted++;
      } catch (error) {
        expect(error).toBeInstanceOf(WatchListFullError);
        refused++;
      }
    }
    expect(accepted).toBe(20);
    expect(refused).toBe(82);
    expect(flood.size).toBe(20);
  });

  it('refuses a paper executor against a live position', () => {
    expect(guardExitMode('live', 'paper')).toBe('refuse');
    expect(guardExitMode('paper', 'live')).toBe('refuse');
    expect(guardExitMode('paper', 'paper')).toBe('proceed');
    expect(guardExitMode('live', 'live')).toBe('proceed');
  });
});

describe('static timer scan', () => {
  it('rejects a timer file that calls getTransactionsForAddress or transactionsSince', () => {
    const hits = findFullHistoryInTimers([
      {
        name: 'apps/server/src/services/monitor.ts',
        source: [
          'const txs = await this.helius.transactionsSince(address, cursor, 25);',
          "await rpc('getTransactionsForAddress', [address, { transactionDetails: 'full' }]);",
          '// getTransactionsForAddress is mentioned only in a comment',
        ].join('\n'),
      },
    ]);
    expect(hits.map((hit) => hit.line)).toEqual([1, 2]);
    expect(() =>
      assertTimersAvoidFullHistory([
        {
          name: 'apps/server/src/services/monitor.ts',
          source: "await rpc('getTransactionsForAddress', []);",
        },
      ]),
    ).toThrow(/banned from timer loops/);
  });

  it('accepts a signature-first timer and ignores comments', () => {
    expect(() =>
      assertTimersAvoidFullHistory([
        {
          name: 'apps/server/src/services/monitor.ts',
          source: [
            '// never call getTransactionsForAddress from this file',
            'const sigs = await this.helius.signaturesSince(address, cursor);',
            'const tx = await this.helius.transactionSummary(address, sig);',
          ].join('\n'),
        },
      ]),
    ).not.toThrow();
  });
});

describe('Jupiter 1 req/s lanes', () => {
  it('sends an exit ahead of a shadow quote and sheds the shadow under load', () => {
    const scheduler = new JupiterScheduler();
    expect(scheduler.request('shadow', T0)).toBe('sent');
    expect(scheduler.request('shadow', T0 + 100)).toBe('shed');
    expect(scheduler.request('exit', T0 + 100)).toBe('wait');
    expect(scheduler.request('exit', T0 + 1_000)).toBe('sent');
  });
});
