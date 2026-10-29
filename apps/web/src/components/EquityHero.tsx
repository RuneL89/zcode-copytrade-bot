import type { DashboardState } from '../types';
import { splitEquity, usd } from '../types';
import { Sparkline } from './charts';

const SOURCE_LABEL: Record<string, string> = {
  DEMO_FIXTURES: 'FICTIONAL DEMO FIXTURES',
  PAPER_CALCULATION: 'PAPER CALCULATION (SIMULATED)',
  LIVE_EVIDENCE: 'ON-CHAIN EVIDENCE',
};

export function EquityHero({ state }: { state: DashboardState }) {
  const eq = state.equity;
  // Headline = rolling equity: bankroll (cash) + unrealized marks.
  const rolling = BigInt(eq.rollingUsdMicro);
  const start = BigInt(eq.startUsdMicro);
  const sinceStart = rolling - start;
  const positive = sinceStart >= 0n;
  const parts = splitEquity(eq.rollingUsdMicro);
  const points = eq.series.map((p) => Number(BigInt(p.usdMicro) / 1000n));

  return (
    <section className="card p-5 mb-4" aria-label="equity">
      <div className="flex items-start justify-between">
        <div>
          <p className="label">EQUITY · USDC</p>
          <p className="money !text-[42px] leading-none font-bold mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span>
              {parts.sign}${parts.whole}
              <span className="text-[#b9b4d6] font-semibold">{parts.decimals}</span>
            </span>
            <span className="money !text-[15px] font-semibold text-[#7d78a0]" data-testid="bankroll-line">
              ${usd(state.counters.cashUsdMicro)} bankroll
            </span>
          </p>
          <p
            className={`money text-[13px] font-semibold mt-1.5 ${positive ? 'text-[#16a06a]' : 'text-[#e85454]'}`}
            data-testid="equity-change"
          >
            {sinceStart > 0n ? '+' : ''}
            {usd(sinceStart.toString())}{' '}
            <span className="text-[#7d78a0] font-normal">since start (${usd(eq.startUsdMicro, 0)})</span>
          </p>
          <p className="label !text-[9px] mt-1.5">
            DEPLOYED {state.counters.deployedPct.toFixed(1)}% OF CAPITAL (CAP {state.counters.maxDeployedPct}
            %)
          </p>
          {state.health.feeSolBalance !== null && (
            <p
              className="label !text-[9px] mt-1"
              data-testid="sol-balance"
              style={{ color: Number(state.health.feeSolBalance) < 0.005 ? '#e85454' : '#16a06a' }}
            >
              {Number(state.health.feeSolBalance) < 0.005
                ? '⚠ FEE WALLET LOW — TOP UP SOL: '
                : 'FEE WALLET: '}
              {state.health.feeSolBalance} SOL
              {state.health.feeSolUsdMicro !== null ? ` (≈ $${usd(state.health.feeSolUsdMicro)})` : ''}
              {` · FEES PAID SO FAR $${usd(state.counters.feesPaidUsdMicro)}`}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="label">CLOSED</p>
          <p className="money text-[15px] font-bold mt-1">{state.stats.copiedTrades}</p>
          <p className="label mt-1">
            {state.stats.winRatePct !== null ? `${state.stats.winRatePct}% WIN` : '—'}
          </p>
        </div>
      </div>
      {eq.series.length >= 2 && (
        <div className="mt-3 -mb-1 overflow-hidden">
          <Sparkline points={points} width={336} height={56} positive={positive} />
        </div>
      )}
      <p className="label !text-[9px] mt-1" data-testid="equity-source">
        {SOURCE_LABEL[eq.source] ?? eq.source} · FEES INCLUDED · {new Date(eq.asOf).toLocaleTimeString()}
      </p>
    </section>
  );
}
