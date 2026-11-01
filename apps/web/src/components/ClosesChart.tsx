import { useMemo, useState } from 'react';
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardState } from '../types';
import { signedUsd } from '../types';

interface TooltipPayloadEntry {
  payload: { symbol: string | null; traderHandle: string; time: string; pnl: number; pnlText: string };
}

function ClosesTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadEntry[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  return (
    <div className="card !bg-glassstrong px-3 py-2 !rounded-[10px]">
      <p className="text-[11.5px] font-semibold">
        {d.symbol ? `$${d.symbol} · ` : ''}
        {d.traderHandle}
      </p>
      <p className="mono text-[10px] text-faint mt-0.5">{d.time}</p>
      <p className={`money text-[12px] font-bold mt-0.5 ${d.pnl >= 0 ? 'text-pos' : 'text-neg'}`}>
        {d.pnlText}
      </p>
    </div>
  );
}

/**
 * Every copied close as a recharts bar chart with a zero baseline and a
 * value axis. Display-only numbers are derived from the bigint micro-USD
 * strings; authoritative math stays server-side.
 */
export function ClosesChart({ state }: { state: DashboardState }) {
  const [showList, setShowList] = useState(false);
  const wins = state.closes.filter((c) => BigInt(c.pnlUsdMicro) > 0n).length;
  const losses = state.closes.length - wins;
  const winPct = Math.round((wins / Math.max(state.closes.length, 1)) * 100);

  const data = useMemo(
    () =>
      [...state.closes].reverse().map((c) => ({
        pnl: Number(BigInt(c.pnlUsdMicro) / 1000n) / 1000,
        pnlText: signedUsd(c.pnlUsdMicro),
        symbol: c.symbol,
        traderHandle: c.traderHandle,
        time: new Date(c.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      })),
    [state.closes],
  );

  return (
    <section className="card p-4 mb-3.5" aria-label="trade history">
      <div className="flex items-baseline justify-between gap-2">
        <p className="label">Every copied close · ledger all-time</p>
        <p className="label !text-[10px]">
          {state.closes.length === 0 ? (
            '—'
          ) : (
            <>
              <span className="text-pos mono">{wins}W</span> ·{' '}
              <span className="text-neg mono">{losses}L</span> · <span className="mono">{winPct}%</span>
            </>
          )}
        </p>
      </div>
      <p className="label !text-[10px] !text-faint mt-0.5">
        copied <span className="mono">{state.stats.copiedTrades}</span> ·{' '}
        {state.stats.winRatePct !== null ? `${state.stats.winRatePct}% win (bot total)` : '—'}
      </p>

      {state.closes.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-muted">
          No closed trades yet — the chart fills when the leader exits and lots are booked.
        </p>
      ) : (
        <div className="mt-2 h-[120px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <XAxis hide dataKey="time" />
              <YAxis
                width={44}
                tick={{ fill: 'var(--color-faint)', fontSize: 9, fontFamily: 'Geist Mono' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) =>
                  `$${Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`
                }
              />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 4" />
              <Tooltip
                content={<ClosesTooltip />}
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                isAnimationActive={false}
              />
              <Bar dataKey="pnl" radius={2} maxBarSize={14} isAnimationActive={false}>
                {data.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.pnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'}
                    fillOpacity={0.9}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Accessible list alternative to the chart. */}
      {state.closes.length > 0 && (
        <button
          type="button"
          onClick={() => setShowList((v) => !v)}
          className="label !text-[10px] cursor-pointer select-none hover:!text-ink mt-1"
          aria-expanded={showList}
        >
          {showList ? '▾' : '▸'} list all closes
        </button>
      )}
      {showList && state.closes.length > 0 && (
        <ul className="mt-2 max-h-44 overflow-auto text-[12px] space-y-1" data-testid="closes-list">
          {state.closes.map((c) => {
            const pnl = BigInt(c.pnlUsdMicro);
            return (
              <li key={c.id} className="flex justify-between gap-2 border-b border-insetborder pb-1">
                <span className="truncate">
                  {c.symbol ? `$${c.symbol} · ` : ''}
                  {c.traderHandle}
                </span>
                <span className={`money font-semibold ${pnl >= 0n ? 'text-pos' : 'text-neg'}`}>
                  {signedUsd(c.pnlUsdMicro)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
