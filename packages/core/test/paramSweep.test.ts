import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RISK, type RiskConfig } from '@zcode-bot/config';
import {
  buildSweepRuns,
  classifyRiskDirection,
  simulateSweep,
  type HireWindow,
  type SimulationParams,
  type SweepSignal,
} from '../src/paramSweep.js';
import { usdToMicro } from '../src/money.js';

const T0 = Date.parse('2026-11-15T06:31:36.000Z');
const HOUR = 3_600_000;
const MINT = '5GDX5fJTQns4arM1J94wjxdA8KXFsV5qW46MLFpHpump';
const CAND = 'cand_coinpumper';

const SIM: SimulationParams = {
  entrySlippageBps: 0,
  exitSlippageBps: 0,
  feeBps: 0,
  delaySeconds: 0,
  pathStepMinutes: 1,
};

function window(over: Partial<HireWindow> = {}): HireWindow {
  return {
    id: 'hire_1',
    seat: 1,
    candidateId: CAND,
    handle: 'coinpumper',
    startMs: T0 - HOUR,
    endMs: null,
    startReason: 'watch_promotion',
    ...over,
  };
}

function signal(over: Partial<SweepSignal> = {}): SweepSignal {
  return {
    id: 'sig_1',
    candidateId: CAND,
    handle: 'coinpumper',
    mint: MINT,
    decimals: 6,
    blockTimeMs: T0,
    entryPriceUsdMicro: 1_000_000n,
    exitAtMs: null,
    exitPriceUsdMicro: null,
    exitKind: 'open',
    leaderInputUsdMicro: usdToMicro(100),
    source: 'shadow',
    ...over,
  };
}

function simulate(
  signals: SweepSignal[],
  options: {
    risk?: Partial<RiskConfig>;
    sim?: Partial<SimulationParams>;
    windows?: HireWindow[];
    fromMs?: number;
    toMs?: number;
  } = {},
) {
  const risk: RiskConfig = { ...DEFAULT_RISK, ...options.risk };
  return simulateSweep({
    signals,
    hireWindows: options.windows ?? [window()],
    risk,
    sim: { ...SIM, ...options.sim },
    fromMs: options.fromMs ?? T0 - HOUR,
    toMs: options.toMs ?? T0 + 24 * HOUR,
    equityStartUsdMicro: usdToMicro(100),
  });
}

describe('simulateSweep — current params on a real paper decision', () => {
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/param-sweep-historic.json', import.meta.url)), 'utf8'),
  ) as {
    leader: {
      candidateId: string;
      handle: string;
      mint: string;
      decimals: number;
      blockTimeIso: string;
      fundingUsdMicro: string;
      tokenBase: string;
      entryPriceUsdMicro: string;
    };
    paper: {
      positionId: string;
      openedAtIso: string;
      inputUsdMicro: string;
      copiedTokenBase: string;
      feesUsdMicro: string;
      status: string;
    };
  };

  it('sizes the real leader buy exactly as the paper desk did', () => {
    const blockTimeMs = Date.parse(fixture.leader.blockTimeIso);
    const result = simulate(
      [
        signal({
          id: 'paper_1',
          candidateId: fixture.leader.candidateId,
          handle: fixture.leader.handle,
          mint: fixture.leader.mint,
          decimals: fixture.leader.decimals,
          blockTimeMs,
          entryPriceUsdMicro: BigInt(fixture.leader.entryPriceUsdMicro),
          exitKind: 'open',
          exitAtMs: null,
          exitPriceUsdMicro: null,
          leaderInputUsdMicro: BigInt(fixture.leader.fundingUsdMicro),
          source: 'paper',
        }),
      ],
      {
        sim: { feeBps: 5 },
        windows: [
          window({
            candidateId: fixture.leader.candidateId,
            handle: fixture.leader.handle,
            startMs: blockTimeMs - 20 * 60_000,
          }),
        ],
        fromMs: blockTimeMs - HOUR,
        toMs: blockTimeMs + HOUR,
      },
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    // The real paper fill (2026-11-15 06:31, OMNI) had input_usd_micro 6,250,000
    // and fee_estimate_usd_micro 3,125. Current defaults reproduce both exactly;
    // the token quantity differs only because the paper fill used a quote.
    expect(trade.notionalUsdMicro).toBe(BigInt(fixture.paper.inputUsdMicro));
    expect(trade.entryFeeUsdMicro).toBe(BigInt(fixture.paper.feesUsdMicro));
    expect(trade.open).toBe(true);
    expect(trade.qtyBase).toBe(10_926_573_426n);
    expect(result.coverage.signalsCopied).toBe(1);
    expect(result.metrics.trades).toBe(1);
    expect(result.metrics.openPositions).toBe(1);
  });
});

describe('simulateSweep — exits and metrics', () => {
  it('mirrors a leader sell and takes the partial take-profit on the way', () => {
    const result = simulate([
      signal({
        exitKind: 'leader_sell',
        exitAtMs: T0 + HOUR,
        exitPriceUsdMicro: 2_000_000n,
      }),
    ]);
    const trade = result.trades[0]!;
    expect(trade.exitUnits.map((u) => u.reason)).toEqual(['partial_take_profit', 'leader_sell']);
    expect(result.metrics.netPnlUsdMicro).toBe(usdToMicro(7));
    expect(result.metrics.realizedPnlUsdMicro).toBe(usdToMicro(7));
    expect(result.metrics.openUnrealizedUsdMicro).toBe(0n);
    expect(result.metrics.wins).toBe(1);
    expect(result.metrics.losses).toBe(0);
    expect(result.metrics.winRatePct).toBe(100);
    expect(result.metrics.trades).toBe(1);
    expect(result.metrics.exitUnits).toBe(2);
  });

  it('uses the real stop-loss rule on a losing linear path', () => {
    const result = simulate([
      signal({
        exitKind: 'leader_sell',
        exitAtMs: T0 + HOUR,
        exitPriceUsdMicro: 500_000n,
      }),
    ]);
    const trade = result.trades[0]!;
    expect(trade.exitUnits).toHaveLength(1);
    expect(trade.exitUnits[0]!.reason).toBe('stop_loss');
    expect(trade.exitUnits[0]!.atMs).toBeLessThan(T0 + HOUR);
    // $10 at $1 -> 25% stop -> $7.50 back, no fees/slippage in this fixture.
    expect(result.metrics.netPnlUsdMicro).toBe(-2_500_000n);
    expect(result.metrics.worstTradeUsdMicro).toBe(-2_500_000n);
    expect(result.metrics.losses).toBe(1);
    expect(result.metrics.winRatePct).toBe(0);
  });

  it('does not force an alternative exit rule to obey the old shadow code exit', () => {
    const result = simulate([
      signal({
        exitKind: 'code_exit',
        exitAtMs: T0 + 2 * HOUR,
        exitPriceUsdMicro: 1_200_000n,
      }),
    ]);
    const trade = result.trades[0]!;
    expect(trade.exitUnits).toHaveLength(1);
    expect(trade.exitUnits[0]!.reason).toBe('path_end');
    expect(trade.exitUnits[0]!.atMs).toBe(T0 + 2 * HOUR);
    expect(result.metrics.netPnlUsdMicro).toBe(usdToMicro(2));
  });

  it('keeps a position open at the simulation end when no terminal mark is inside the window', () => {
    const result = simulate(
      [
        signal({
          exitKind: 'leader_sell',
          exitAtMs: T0 + 48 * HOUR,
          exitPriceUsdMicro: 2_000_000n,
        }),
      ],
      { toMs: T0 + HOUR },
    );
    const trade = result.trades[0]!;
    expect(trade.open).toBe(true);
    expect(trade.exitUnits).toHaveLength(0);
    expect(result.metrics.openPositions).toBe(1);
    // No terminal mark inside the window: the open mark is flat at entry.
    expect(result.metrics.openUnrealizedUsdMicro).toBe(0n);
  });

  it('tracks the daily-loss stop and rejects later entries that day', () => {
    const result = simulate(
      [
        signal({
          id: 'loss',
          exitKind: 'leader_sell',
          exitAtMs: T0 + HOUR,
          exitPriceUsdMicro: 500_000n,
        }),
        signal({
          id: 'after',
          mint: 'OtherMint1111111111111111111111111111111111',
          blockTimeMs: T0 + 2 * HOUR,
          exitKind: 'leader_sell',
          exitAtMs: T0 + 3 * HOUR,
          exitPriceUsdMicro: 1_000_000n,
        }),
      ],
      { risk: { MAX_DAILY_REALIZED_LOSS_USD: 2 } },
    );
    expect(result.metrics.dailyLossStopDays).toBe(1);
    expect(result.coverage.skippedRisk).toBe(1);
    expect(result.coverage.entryRejections).toContainEqual({
      rule: 'MAX_DAILY_REALIZED_LOSS_USD',
      count: 1,
    });
    expect(result.trades).toHaveLength(1);
  });

  it('coalesces same-mint entries inside 60 seconds', () => {
    const result = simulate([signal({ id: 'first' }), signal({ id: 'second', blockTimeMs: T0 + 30_000 })]);
    expect(result.trades).toHaveLength(1);
    expect(result.coverage.skippedCoalesced).toBe(1);
  });

  it('skips a signal when the candidate has no chair at that moment', () => {
    const result = simulate([signal()], {
      windows: [window({ startMs: T0 + HOUR, endMs: T0 + 2 * HOUR })],
    });
    expect(result.trades).toHaveLength(0);
    expect(result.coverage.skippedNotHired).toBe(1);
  });
});

describe('buildSweepRuns — grid and risk labels', () => {
  const baselineSim: SimulationParams = {
    ...SIM,
    hiringPolicy: 'actual',
    ranking: 'net',
  };

  it('labels tighter, looser and mixed one-factor changes', () => {
    expect(
      classifyRiskDirection(DEFAULT_RISK, baselineSim, { ...DEFAULT_RISK, STOP_LOSS_BPS: 2000 }, baselineSim),
    ).toBe('TIGHTENS');
    expect(
      classifyRiskDirection(DEFAULT_RISK, baselineSim, { ...DEFAULT_RISK, STOP_LOSS_BPS: 3000 }, baselineSim),
    ).toBe('LOOSENS');
    expect(
      classifyRiskDirection(
        DEFAULT_RISK,
        baselineSim,
        { ...DEFAULT_RISK, STOP_LOSS_BPS: 2000, MIN_PER_BUY_USD: 1 },
        baselineSim,
      ),
    ).toBe('MIXED');
    expect(
      classifyRiskDirection(
        DEFAULT_RISK,
        baselineSim,
        { ...DEFAULT_RISK, PROMOTION_MAX_LAST_BUY_HOURS: 8 },
        baselineSim,
      ),
    ).toBe('LOOSENS');
  });

  it('builds OFAT runs, hiring alternatives and combinations, skipping the baseline value', () => {
    const runs = buildSweepRuns(DEFAULT_RISK, baselineSim, {
      values: { STOP_LOSS_BPS: [2000, 2500, 3000], COPY_SCALE: [0.25, 0.5] },
      hiring: ['actual', 'net', 'net_per_trade'],
      combinations: [{ STOP_LOSS_BPS: 2000, MIN_PER_BUY_USD: 1 }],
      maxRuns: 50,
    });
    expect(runs.map((run) => run.label)).not.toContain('STOP_LOSS_BPS=2500');
    expect(runs.map((run) => run.label)).not.toContain('COPY_SCALE=0.25');
    expect(runs.find((run) => run.label === 'STOP_LOSS_BPS=2000')?.riskLabel).toBe('TIGHTENS');
    // hiring=actual is the baseline, so it is not duplicated as an alternative.
    expect(runs.find((run) => run.label === 'hiring=actual')).toBeUndefined();
    expect(runs.find((run) => run.label === 'hiring=net')?.riskLabel).toBe('MIXED');
    expect(runs.find((run) => run.label === 'STOP_LOSS_BPS=2000 + MIN_PER_BUY_USD=1')?.riskLabel).toBe(
      'MIXED',
    );
  });

  it('caps the number of runs', () => {
    const runs = buildSweepRuns(DEFAULT_RISK, baselineSim, {
      values: { STOP_LOSS_BPS: [1000, 1500, 2000, 2500, 3000, 3500, 4000] },
      maxRuns: 3,
    });
    expect(runs).toHaveLength(3);
  });

  it('re-picks hires for promotion and cooldown runs so the rule can act', () => {
    const runs = buildSweepRuns(DEFAULT_RISK, baselineSim, {
      values: { PROMOTION_MIN_CLOSED: [4], COOLDOWN_HOURS: [12] },
    });
    expect(runs.find((run) => run.label === 'PROMOTION_MIN_CLOSED=4')?.sim.hiringPolicy).toBe('shadow');
    expect(runs.find((run) => run.label === 'COOLDOWN_HOURS=12')?.sim.hiringPolicy).toBe('shadow');
  });

  it('refuses an unknown grid key instead of silently ignoring it', () => {
    expect(() =>
      buildSweepRuns(DEFAULT_RISK, baselineSim, {
        values: { STOP_LOSS_BSP: [2000] },
      }),
    ).toThrow(/unknown sweep parameter/);
  });
});
