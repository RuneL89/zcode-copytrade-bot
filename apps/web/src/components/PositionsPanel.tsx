import { useEffect, useState } from 'react';
import type { DashboardState } from '../types';
import { signedUsd, timeAgo, usd } from '../types';

function posChip(status: string): { label: string; cls: string } {
  switch (status) {
    case 'open':
      return { label: 'OPEN', cls: 'bg-emerald-100 text-emerald-700' };
    case 'partially_closed':
      return { label: 'PARTIAL', cls: 'bg-amber-100 text-amber-700' };
    case 'requires_reconciliation':
      return { label: 'RECONCILE', cls: 'bg-fuchsia-100 text-fuchsia-700' };
    default:
      return { label: status.toUpperCase(), cls: 'bg-zinc-100 text-zinc-500' };
  }
}

/** Milliseconds as "HH:MM" (hours can exceed 24; minutes padded). */
function hhmm(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface Countdown {
  text: string;
  phase: 'hold' | 'grace' | 'now';
}

/** Live time-exit countdown for a position: phase 1 decision at maxAge, force-close at maxAge+grace. */
function countdown(
  p: DashboardState['positions'][number],
  maxAgeHours: number,
  graceHours: number,
  now: number,
): Countdown {
  const opened = Date.parse(p.openedIso);
  const ageMs = Number.isFinite(opened) ? now - opened : 0;
  const endMs = (maxAgeHours + graceHours) * 3_600_000;
  if (ageMs >= endMs) return { text: 'SELLS NOW', phase: 'now' };
  if (ageMs >= maxAgeHours * 3_600_000)
    return { text: `GRACE · SELLS IN ${hhmm(endMs - ageMs)}`, phase: 'grace' };
  return { text: `TIME EXIT IN ${hhmm(maxAgeHours * 3_600_000 - ageMs)}`, phase: 'hold' };
}

const TICK_MS = 10_000;

export function PositionsPanel({ state }: { state: DashboardState }) {
  const positions = state.positions;
  const idle = state.counters.idleFireHoursLeft;
  // Local minute-by-minute ticking so countdowns move between state pushes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  const idleLeftMs = idle !== null ? idle * 3_600_000 - (now - Date.parse(state.generatedAt)) : null;

  return (
    <section className="card p-5 mb-4" aria-label="open positions" data-testid="positions-panel">
      <div className="flex items-center justify-between">
        <p className="label">OPEN POSITIONS · {positions.length}</p>
        {positions.length > 0 && (
          <p className="label !text-[9px]" data-testid="open-exposure">
            ENTRY ${usd(state.counters.deployedUsdMicro, 2)} INCL. FEES ·{' '}
            {state.counters.deployedPct.toFixed(0)}% DEPLOYED
          </p>
        )}
      </div>

      {positions.length === 0 ? (
        <div className="mt-2">
          <p className="text-[12.5px] text-[#7d78a0]">
            {state.activeTrader
              ? `No open positions — waiting for @${state.activeTrader.handle}'s next buy.`
              : 'No open positions.'}
          </p>
          {state.activeTrader && idleLeftMs !== null && (
            <div
              className="mt-3 rounded-[14px] bg-amber-50 border border-amber-200 p-3 text-center"
              data-testid="idle-countdown"
            >
              <p className="label !text-[9px] text-amber-700">
                IDLE FIRE — @{state.activeTrader.handle.toUpperCase()} IS REPLACED IF NOTHING COPIES
              </p>
              <p className="money text-[30px] leading-none font-bold text-amber-700 mt-1.5">
                {hhmm(idleLeftMs)}
              </p>
              <p className="label !text-[8px] mt-1 text-[#a29dbf]">
                HOURS:MINUTES UNTIL AUTOMATIC REPLACEMENT
              </p>
            </div>
          )}
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {positions.map((p) => {
            const chip = posChip(p.status);
            const pnl = p.unrealizedPnlUsdMicro ? BigInt(p.unrealizedPnlUsdMicro) : null;
            const markAge =
              p.markAgeSeconds !== null && p.markAgeSeconds >= 90
                ? ` · ${Math.round(p.markAgeSeconds / 60)}m`
                : '';
            const cd = countdown(
              p,
              state.counters.maxPositionAgeHours,
              state.counters.positionGraceHours,
              now,
            );
            const cdCls =
              cd.phase === 'grace'
                ? 'bg-amber-100 border-amber-300 text-amber-800'
                : cd.phase === 'now'
                  ? 'bg-rose-50 border-rose-300 text-rose-700'
                  : 'bg-orange-50 border-orange-200 text-orange-700';
            return (
              <li
                key={p.positionId}
                className="rounded-[14px] bg-white/55 border border-white/80 px-3.5 py-3"
                data-testid="position-row"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-bold">${p.symbol ?? p.mintShort}</span>
                  {p.symbol && <span className="label !text-[8.5px] text-[#a29dbf]">{p.mintShort}</span>}
                  <span className={`label !text-[8.5px] ml-auto rounded-full px-2 py-0.5 ${chip.cls}`}>
                    {chip.label}
                  </span>
                </div>
                <div
                  className={`mt-2 rounded-[10px] border px-3 py-1.5 text-center ${cdCls}`}
                  data-testid="countdown"
                  aria-label={`time exit countdown: ${cd.text}`}
                >
                  <span className="label !text-[10px] font-bold">⏱ {cd.text}</span>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-[12px]">
                  <div>
                    <p className="label !text-[8.5px]">WE COPY</p>
                    <p className="money font-semibold">${usd(p.copyUsdMicro)}</p>
                  </div>
                  <div>
                    <p className="label !text-[8.5px]">MARK{markAge}</p>
                    <p className="money font-semibold">
                      {p.markUsdMicro ? `$${usd(p.markUsdMicro)}` : 'pending'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="label !text-[8.5px]">P/L (OPEN)</p>
                    <p
                      className="money font-semibold"
                      style={{
                        color: pnl === null ? '#a29dbf' : pnl >= 0n ? '#16a06a' : '#e85454',
                      }}
                    >
                      {pnl === null ? '—' : signedUsd(p.unrealizedPnlUsdMicro)}
                    </p>
                  </div>
                </div>
                <p className="label !text-[8px] mt-1.5 text-[#a29dbf]">
                  OPENED {timeAgo(p.openedIso)} AGO · ENTRY FEE ${usd(p.feesUsdMicro)}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <p className="label !text-[8px] mt-3 text-[#a29dbf]">
        DAY-TRADER MODE: SELLS AT {state.counters.maxPositionAgeHours}H IF GREEN, AT{' '}
        {state.counters.maxPositionAgeHours + state.counters.positionGraceHours}H REGARDLESS · MARK = LIVE
        JUPITER QUOTE (≈60S)
      </p>
    </section>
  );
}
