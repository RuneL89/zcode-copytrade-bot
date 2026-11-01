import type { DashboardState } from '../types';
import { splitEquity, usd } from '../types';
import { Sparkline } from './charts';

const SOURCE_LABEL: Record<string, string> = {
  DEMO_FIXTURES: 'Fictional demo fixtures',
  PAPER_CALCULATION: 'Paper calculation (simulated)',
  LIVE_EVIDENCE: 'On-chain evidence',
};

/**
 * Equity hero: one disciplined card. Headline equity + change + sparkline,
 * then a money row (bankroll / wallet USDC / deployed) and a wallet-health
 * row (fee wallet, fees, rent) — all server-sourced and labeled.
 */
export function EquityHero({ state }: { state: DashboardState }) {
  const eq = state.equity;
  const rolling = BigInt(eq.rollingUsdMicro);
  const start = BigInt(eq.startUsdMicro);
  const sinceStart = rolling - start;
  const positive = sinceStart >= 0n;
  const parts = splitEquity(eq.rollingUsdMicro);
  const points = eq.series.map((p) => Number(BigInt(p.usdMicro) / 1000n));
  const counters = state.counters;

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
  const feeLow = state.health.feeSolBalance !== null && Number(state.health.feeSolBalance) < 0.005;

  return (
    <section className="card p-4 mb-3.5" aria-label="equity">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label">Equity · USDC</p>
          <p className="money !text-[38px] leading-none font-bold mt-1.5 flex items-baseline gap-x-1">
            <span>
              {parts.sign}${parts.whole}
              <span className="text-[22px] font-semibold text-faint">{parts.decimals}</span>
            </span>
          </p>
          <p
            className={`money text-[13px] font-semibold mt-1.5 ${positive ? 'text-pos' : 'text-neg'}`}
            data-testid="equity-change"
          >
            {sinceStart > 0n ? '+' : ''}
            {usd(sinceStart.toString())}{' '}
            <span className="text-faint font-normal">since start (${usd(eq.startUsdMicro, 0)})</span>
          </p>
        </div>
        <p className="label !text-[10px] text-right shrink-0 pt-0.5" data-testid="equity-source">
          {SOURCE_LABEL[eq.source] ?? eq.source}
          <br />
          <span className="text-faint">fees included · {new Date(eq.asOf).toLocaleTimeString()}</span>
        </p>
      </div>

      {eq.series.length >= 2 && (
        <div className="mt-3 -mb-1">
          <Sparkline points={points} width={336} height={52} positive={positive} responsive />
        </div>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="panel px-3 py-2">
          <p className="label !text-[10px]">Bankroll</p>
          <p className="money text-[14px] font-semibold mt-0.5" data-testid="bankroll-line">
            ${usd(counters.cashUsdMicro)}
          </p>
        </div>
        <div className="panel px-3 py-2">
          <p className="label !text-[10px]">Wallet USDC</p>
          <p className="money text-[14px] font-semibold mt-0.5">
            {state.health.walletUsdcUsdMicro !== null ? `$${usd(state.health.walletUsdcUsdMicro)}` : '—'}
          </p>
        </div>
        <div className="panel px-3 py-2">
          <p className="label !text-[10px]">Deployed</p>
          <p className="money text-[14px] font-semibold mt-0.5">
            {counters.deployedPct.toFixed(1)}
            <span className="text-faint text-[11px]"> / {counters.maxDeployedPct}%</span>
          </p>
        </div>
      </div>

      {state.health.feeSolBalance !== null && (
        <div className="mt-2 flex items-center justify-between gap-3 px-1" data-testid="sol-balance">
          <p className={`label !text-[10.5px] ${feeLow ? '!text-neg font-semibold' : 'text-faint'}`}>
            {feeLow ? '⚠ Fee wallet low — top up SOL: ' : 'Fee wallet '}
            <span className="mono">{state.health.feeSolBalance} SOL</span>
            {state.health.feeSolUsdMicro !== null && (
              <span className="mono"> (≈ ${usd(state.health.feeSolUsdMicro)})</span>
            )}
          </p>
          <p className="label !text-[10px] text-faint shrink-0 text-right" data-testid="sol-spend">
            {counters.ledgerTxs === null ? (
              'scanning chain…'
            ) : (
              <>
                fees {sol(counters.feesLamports)} · rent {sol(counters.rentLamports)} ·{' '}
                {counters.openTokenAccounts ?? 0} accounts
              </>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
