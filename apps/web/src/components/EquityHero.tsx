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
  const parts = splitEquity(eq.rollingUsdMicro);
  const points = eq.series.map((p) => Number(BigInt(p.usdMicro) / 1000n));

  // Sub-cent amounts are common here (a network fee is ~$0.0006), so show
  // enough decimals for the number to mean something instead of "$0.00".
  const money = (micro: string | null): string => {
    if (micro === null) return '—';
    const n = Number(micro);
    if (n === 0) return '0.00';
    return n < 10_000 ? usd(micro, 4) : usd(micro);
  };
  const sol = (lamports: number | null): string => {
    if (lamports === null) return '—';
    return (lamports / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  };
  const counters = state.counters;
  // Live: the headline is the wallet itself; the since-start number is the
  // deposit-adjusted wallet PnL, and the breakdown shows what an explorer
  // would. Paper has no wallet and keeps the modelled change.
  const wallet = eq.wallet ?? null;
  const pnlSince = wallet ? BigInt(wallet.pnlUsdMicro) : sinceStart;
  const pnlPositive = pnlSince >= 0n;
  const positive = wallet ? pnlPositive : sinceStart >= 0n;

  return (
    <section className="card p-5 mb-4" aria-label="equity">
      <div className="flex items-start justify-between">
        <div>
          <p className="label">{wallet ? 'EQUITY · WALLET' : 'EQUITY · USDC'}</p>
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
            className={`money text-[13px] font-semibold mt-1.5 ${pnlPositive ? 'text-[#16a06a]' : 'text-[#e85454]'}`}
            data-testid="equity-change"
          >
            {pnlSince > 0n ? '+' : ''}
            {usd(pnlSince.toString())}{' '}
            <span className="text-[#7d78a0] font-normal">
              {wallet ? 'wallet PnL (deposits excluded)' : `since start ($${usd(eq.startUsdMicro, 0)})`}
            </span>
          </p>
          {wallet && (
            <p className="label !text-[9px] mt-1" data-testid="wallet-breakdown">
              {`WALLET: $${usd(wallet.usdcMicro)} USDC · $${usd(wallet.solUsdMicro)} SOL · $${usd(
                wallet.positionsUsdMicro,
              )} POSITIONS`}
            </p>
          )}
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
            </p>
          )}
          {state.health.feeSolBalance !== null && (
            <p className="label !text-[8.5px] mt-0.5 text-[#7d78a0]" data-testid="sol-spend">
              {counters.ledgerTxs === null ? (
                'SOL SPEND: SCANNING CHAIN…'
              ) : (
                <>
                  {`FEES ${sol(counters.feesLamports)} SOL ($${money(counters.feesPaidUsdMicro)}) · RENT ${sol(counters.rentLamports)} SOL ($${money(counters.rentUsdMicro)}) IN ${counters.openTokenAccounts ?? 0} TOKEN ACCOUNTS`}
                </>
              )}
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
