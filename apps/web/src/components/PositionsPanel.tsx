import { Fragment, useEffect, useState } from 'react';
import type { DashboardState } from '../types';
import { signedUsd, timeAgo, usd } from '../types';

/** Seconds to a compact clock label (2h 5m). */
function hhmm(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Lamports as a compact SOL string; em dash when the chain has not been read. */
function solAmount(lamports: number | null): string {
  if (lamports === null) return '—';
  return (lamports / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

function posChip(status: string): { label: string; cls: string } {
  switch (status) {
    case 'open':
      return { label: 'OPEN', cls: 'bg-posdim text-pos' };
    case 'partially_closed':
      return { label: 'PARTIAL', cls: 'bg-warndim text-warn' };
    case 'requires_reconciliation':
      return { label: 'RECONCILE', cls: 'bg-infodim text-info' };
    default:
      return { label: status.toUpperCase(), cls: 'text-faint' };
  }
}

interface Countdown {
  text: string;
  phase: 'hold' | 'grace' | 'now';
}

/**
 * Live time-exit countdown for a position: phase 1 decision at maxAge, force-close
 * at maxAge+grace. Everything here is in seconds, which is what `hhmm` formats.
 */
export function countdown(
  p: DashboardState['positions'][number],
  maxAgeHours: number,
  graceHours: number,
  now: number,
): Countdown {
  const opened = Date.parse(p.openedIso);
  const ageSec = Number.isFinite(opened) ? Math.max(0, Math.round((now - opened) / 1000)) : 0;
  const endSec = (maxAgeHours + graceHours) * 3_600;
  if (ageSec >= endSec) return { text: 'SELLS NOW', phase: 'now' };
  if (ageSec >= maxAgeHours * 3_600)
    return { text: `GRACE · SELLS IN ${hhmm(endSec - ageSec)}`, phase: 'grace' };
  return { text: `TIME EXIT IN ${hhmm(maxAgeHours * 3_600 - ageSec)}`, phase: 'hold' };
}

const TICK_MS = 10_000;

export function PositionsPanel({ state }: { state: DashboardState }) {
  // Grouped by leader (plan 05): the roster shares one pool, so the panel shows
  // which chair each position belongs to instead of one trader's book.
  const positions = [...state.positions].sort(
    (a, b) =>
      (a.leaderHandle ?? '').localeCompare(b.leaderHandle ?? '') || a.openedIso.localeCompare(b.openedIso),
  );
  let lastLeader: string | null = null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="card p-4 mb-3.5" aria-label="open positions" data-testid="positions-panel">
      <div className="flex items-center justify-between">
        <p className="label">Open positions · {positions.length}</p>
        {positions.length > 0 && (
          <p className="label !text-[10px]" data-testid="open-exposure">
            entry ${usd(state.counters.deployedUsdMicro, 2)} incl. fees ·{' '}
            {state.counters.deployedPct.toFixed(0)}% deployed
          </p>
        )}
      </div>

      {positions.length === 0 ? (
        <div className="mt-2">
          <p className="text-[12.5px] text-muted">
            {state.activeTrader
              ? `No open positions — waiting for @${state.activeTrader.handle}'s next buy.`
              : 'No open positions.'}
          </p>
        </div>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {positions.map((p) => {
            const leaderHeader = p.leaderHandle !== null && p.leaderHandle !== lastLeader;
            lastLeader = p.leaderHandle;
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
                ? 'bg-warndim border-warnborder text-warn'
                : cd.phase === 'now'
                  ? 'bg-negdim border-negborder text-neg'
                  : 'bg-inset border-insetborder text-muted';
            return (
              <Fragment key={p.positionId}>
                {leaderHeader && (
                  <li className="label !text-[9.5px] !text-faint pt-1" data-testid="position-leader">
                    @{p.leaderHandle}
                  </li>
                )}
                <li className="panel px-3 py-2.5" data-testid="position-row">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-bold">${p.symbol ?? p.mintShort}</span>
                    {p.symbol && <span className="mono text-[9.5px] text-faint">{p.mintShort}</span>}
                    <span className={`tag chip ml-auto ${chip.cls}`}>{chip.label}</span>
                  </div>
                  <div
                    className={`mt-1.5 rounded-[10px] border px-3 py-1 text-center ${cdCls}`}
                    data-testid="countdown"
                    aria-label={`time exit countdown: ${cd.text}`}
                  >
                    <span className="mono text-[10px] font-semibold tracking-wide">⏱ {cd.text}</span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 text-[12px]">
                    <div>
                      <p className="label !text-[9.5px]">We copy</p>
                      <p className="money font-semibold">${usd(p.copyUsdMicro)}</p>
                    </div>
                    <div>
                      <p className="label !text-[9.5px]">Mark{markAge}</p>
                      <p className="money font-semibold">
                        {p.markUsdMicro ? `$${usd(p.markUsdMicro)}` : 'pending'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="label !text-[9.5px]">P/L (open)</p>
                      <p
                        className={`money font-semibold ${
                          pnl === null ? 'text-faint' : pnl >= 0n ? 'text-pos' : 'text-neg'
                        }`}
                      >
                        {pnl === null ? '—' : signedUsd(p.unrealizedPnlUsdMicro)}
                      </p>
                    </div>
                  </div>
                  <p className="label !text-[9px] !text-faint mt-1.5">
                    opened {timeAgo(p.openedIso)} ago · fee {solAmount(p.entryFeeLamports)} SOL
                    {p.feesUsdMicro !== null && p.feesUsdMicro !== '0'
                      ? ` ($${usd(p.feesUsdMicro, 4)})`
                      : ''}{' '}
                    · rent {solAmount(p.entryRentLamports)} SOL
                  </p>
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
      <p className="label !text-[9.5px] !text-faint mt-2.5">
        Day-trader mode: sells at {state.counters.maxPositionAgeHours}h if green, at{' '}
        {state.counters.maxPositionAgeHours + state.counters.positionGraceHours}h regardless · mark = live
        Jupiter quote (≈60s)
      </p>
    </section>
  );
}
