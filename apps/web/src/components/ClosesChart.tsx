import type { DashboardState } from '../types';
import { signedUsd } from '../types';
import { Lollipop } from './charts';

export function ClosesChart({ state }: { state: DashboardState }) {
  const values = [...state.closes].reverse().map((c) => Number(BigInt(c.pnlUsdMicro) / 1000n));
  const wins = state.closes.filter((c) => BigInt(c.pnlUsdMicro) > 0n).length;
  const losses = state.closes.length - wins;

  return (
    <section className="card p-5 mb-4" aria-label="trade history">
      <div className="flex items-center justify-between">
        <p className="label">EVERY COPIED CLOSE</p>
        <p className="label !text-[9px]">
          {state.closes.length === 0
            ? '—'
            : `${wins}W · ${losses}L · ${Math.round((wins / Math.max(state.closes.length, 1)) * 100)}%`}
        </p>
      </div>
      {state.closes.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-[#7d78a0]">
          No closed trades yet — the chart fills when the leader exits and lots are booked.
        </p>
      ) : (
        <div className="mt-3">
          <Lollipop values={values} width={336} height={116} />
        </div>
      )}
      {/* Accessible list alternative to the chart. */}
      {state.closes.length > 0 && (
        <details className="mt-2">
          <summary className="label cursor-pointer select-none">list all closes</summary>
          <ul className="mt-2 max-h-44 overflow-auto text-[12px] space-y-1" data-testid="closes-list">
            {state.closes.map((c) => {
              const pnl = BigInt(c.pnlUsdMicro);
              return (
                <li key={c.id} className="flex justify-between gap-2 border-b border-white/70 pb-1">
                  <span className="truncate">
                    {c.symbol ? `$${c.symbol} · ` : ''}
                    {c.traderHandle}
                  </span>
                  <span className="money font-semibold" style={{ color: pnl >= 0n ? '#16a06a' : '#e85454' }}>
                    {signedUsd(c.pnlUsdMicro)}
                  </span>
                </li>
              );
            })}
            {state.closes.length === 0 && <li className="text-[#7d78a0]">no copied closes yet</li>}
          </ul>
        </details>
      )}
    </section>
  );
}
