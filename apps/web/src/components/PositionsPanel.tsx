import { useEffect, useState } from 'react';
import type { DashboardState } from '../types';
import { signedUsd, timeAgo, usd } from '../types';

/** Lamports as a compact SOL string; em dash when the chain has not been read. */
function solAmount(lamports: number | null): string {
  if (lamports === null) return '—';
  return (lamports / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

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

/**
 * The whole hire/fire pipeline in one box: idle countdown → fired → research
 * (requested, then running) → auto-hire. Before a fire the countdown is the
 * headline; after it the same box switches to the stage that is running, so
 * the operator can follow the handoff without changing screens.
 */
function HiringPipeline({ state, now }: { state: DashboardState; now: number }) {
  const h = state.hiring;
  const idleFireAt = h.idleFireAtIso ? Date.parse(h.idleFireAtIso) : null;
  const idleLeftMs = idleFireAt !== null && Number.isFinite(idleFireAt) ? idleFireAt - now : null;

  const steps: Array<{ key: string; label: string; done: boolean; active: boolean }> = [
    {
      key: 'idle',
      label: 'IDLE TIMER',
      done: h.stage !== 'IDLE_COUNTDOWN' && h.stage !== 'IDLE',
      active: h.stage === 'IDLE_COUNTDOWN',
    },
    {
      key: 'fired',
      label: 'FIRED',
      done: h.stage !== 'IDLE_COUNTDOWN' && h.stage !== 'IDLE' && h.stage !== 'FIRED',
      active: h.stage === 'FIRED',
    },
    {
      key: 'research',
      label: h.stage === 'RESEARCH_RUNNING' ? 'RESEARCHING…' : 'RESEARCH',
      done: h.stage === 'ORDERING_READY' || h.stage === 'HIRED',
      active: h.stage === 'RESEARCH_REQUESTED' || h.stage === 'RESEARCH_RUNNING',
    },
    {
      key: 'hire',
      label: 'NEW HIRE',
      done: false,
      active: h.stage === 'ORDERING_READY' || h.stage === 'HIRED',
    },
  ];

  // Headline: the number while counting down, the running stage after that.
  let headline = '—';
  let sub = 'NO ACTIVE TRADER';
  if (h.stage === 'IDLE_COUNTDOWN' && idleLeftMs !== null) {
    headline = hhmm(idleLeftMs);
    sub = 'HOURS:MINUTES UNTIL AUTOMATIC REPLACEMENT';
  } else if (h.stage === 'HIRED') {
    headline = state.activeTrader ? `@${state.activeTrader.handle}` : 'HIRED';
    sub = 'POSITION OPEN — TIMER PAUSED';
  } else if (h.stage === 'FIRED') {
    headline = 'FIRED';
    sub = h.stageSince ? `OUT ${timeAgo(h.stageSince, now)} AGO` : 'WAITING FOR RESEARCH';
  } else if (h.stage === 'RESEARCH_REQUESTED') {
    headline = 'RESEARCH QUEUED';
    sub = 'WAITING FOR THE NEXT RESEARCH RUN';
  } else if (h.stage === 'RESEARCH_RUNNING') {
    headline = 'RESEARCHING';
    sub = h.stageSince ? `STARTED ${timeAgo(h.stageSince, now)} AGO` : 'RANKING THE CURRENT BOARD';
  } else if (h.stage === 'ORDERING_READY') {
    headline = 'HIRING';
    sub = 'FRESH ORDERING VALIDATED — TOP CANDIDATE ACTIVATES';
  }

  return (
    <div
      className={`mt-3 rounded-[14px] border p-3 ${
        h.stage === 'IDLE_COUNTDOWN'
          ? 'bg-amber-50 border-amber-200'
          : h.stage === 'HIRED'
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-orange-50 border-orange-200'
      }`}
      data-testid="hiring-pipeline"
      aria-label={`hire pipeline: ${h.stage}`}
    >
      <div className="flex items-center gap-1" aria-label="pipeline stages">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1 flex-1 min-w-0">
            <span
              className={`flex-1 text-center rounded-full px-1.5 py-1 text-[8px] font-bold tracking-wide truncate ${
                s.done
                  ? 'bg-emerald-100 text-emerald-700'
                  : s.active
                    ? h.stage === 'IDLE_COUNTDOWN'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-orange-100 text-orange-700'
                    : 'bg-white/70 text-[#a29dbf] border border-white'
              }`}
            >
              {s.done ? '✓ ' : ''}
              {s.label}
            </span>
            {i < steps.length - 1 && <span className="text-[#c6c2dd] text-[9px]">›</span>}
          </div>
        ))}
      </div>

      <div className="text-center mt-2">
        <p
          className={`money font-bold leading-none ${
            h.stage === 'IDLE_COUNTDOWN' ? 'text-[30px] text-amber-700' : 'text-[17px] text-[#2a2740]'
          }`}
          data-testid="pipeline-headline"
        >
          {headline}
        </p>
        <p className="label !text-[8px] mt-1 text-[#a29dbf]">{sub}</p>
      </div>

      {state.activeTrader && h.stage === 'IDLE_COUNTDOWN' && (
        <p className="label !text-[8.5px] mt-2 text-center text-amber-700">
          @{state.activeTrader.handle.toUpperCase()} IS REPLACED IF NOTHING COPIES
        </p>
      )}

      {h.pausedForResearch && (
        <div className="mt-2 text-center">
          <p className="label !text-[8.5px] text-orange-700">
            {h.stage === 'RESEARCH_RUNNING'
              ? 'FRESH RESEARCH RE-RANKS THE CURRENT BOARD'
              : 'FRESH RESEARCH STARTS AS SOON AS THE RUN IS DISPATCHED'}
          </p>
          <p className="text-[10.5px] text-[#7d78a0] mt-1 leading-snug">
            The best candidate <span className="font-semibold">right now</span> is hired automatically
            once the new ordering validates.
          </p>
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <p className="label !text-[8px]">BOARD SCAN</p>
          <p className="money font-semibold">
            {h.latestScanAt ? `${timeAgo(h.latestScanAt, now)} ago` : '—'}
          </p>
        </div>
        <div className="text-right">
          <p className="label !text-[8px]">LAST ORDERING</p>
          <p className="money font-semibold">
            {h.recommendationAt ? `${timeAgo(h.recommendationAt, now)} old` : '—'}
          </p>
        </div>
      </div>

      {h.reason && (
        <p className="mt-1.5 text-[9.5px] text-[#a29dbf] break-words text-center" data-testid="pipeline-reason">
          {h.reason}
        </p>
      )}
    </div>
  );
}

export function PositionsPanel({ state }: { state: DashboardState }) {
  const positions = state.positions;
  // Local ticking so the pipeline countdown moves between state pushes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

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
          <HiringPipeline state={state} now={now} />
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
                  OPENED {timeAgo(p.openedIso)} AGO · FEE {solAmount(p.entryFeeLamports)} SOL · RENT{' '}
                  {solAmount(p.entryRentLamports)} SOL
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
