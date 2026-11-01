import type { DashboardState } from '../types';
import { timeAgo } from '../types';

/**
 * The whole hire/fire pipeline in one strip: idle countdown → fired → research
 * (requested, then running) → auto-hire. Rendered inside the "Now copying"
 * card so the operator can follow the handoff without changing screens,
 * whether or not positions are open.
 */
export function HiringPipeline({ state, now }: { state: DashboardState; now: number }) {
  const h = state.hiring;
  const idleFireAt = h.idleFireAtIso ? Date.parse(h.idleFireAtIso) : null;
  const idleLeftMs = idleFireAt !== null && Number.isFinite(idleFireAt) ? idleFireAt - now : null;

  const steps: Array<{ key: string; label: string; done: boolean; active: boolean }> = [
    {
      key: 'idle',
      label: 'Idle timer',
      done: h.stage !== 'IDLE_COUNTDOWN' && h.stage !== 'IDLE',
      active: h.stage === 'IDLE_COUNTDOWN',
    },
    {
      key: 'fired',
      label: 'Fired',
      done: h.stage !== 'IDLE_COUNTDOWN' && h.stage !== 'IDLE' && h.stage !== 'FIRED',
      active: h.stage === 'FIRED',
    },
    {
      key: 'research',
      label:
        h.stage === 'RESEARCH_RUNNING'
          ? 'Researching…'
          : h.stage === 'POOL_STALE'
            ? 'Pool too thin'
            : 'Research',
      done: h.stage === 'ORDERING_READY' || h.stage === 'HIRED',
      active: h.stage === 'RESEARCH_REQUESTED' || h.stage === 'RESEARCH_RUNNING' || h.stage === 'POOL_STALE',
    },
    {
      key: 'hire',
      label: h.noBuyerOnBoard ? 'Waiting: no buyer' : 'New hire',
      done: false,
      active: !h.noBuyerOnBoard && (h.stage === 'ORDERING_READY' || h.stage === 'HIRED'),
    },
  ];

  let headline = '—';
  let sub = 'No active trader';
  if (h.stage === 'IDLE_COUNTDOWN' && idleLeftMs !== null) {
    headline = hhmm(idleLeftMs);
    sub = 'hours:minutes until automatic replacement';
  } else if (h.stage === 'HIRED') {
    headline = state.activeTrader ? `@${state.activeTrader.handle}` : 'Hired';
    sub = 'position open — timer paused';
  } else if (h.stage === 'FIRED') {
    headline = 'Fired';
    const cause = h.firedReason
      ? h.firedReason.length > 44
        ? `${h.firedReason.slice(0, 44)}…`
        : h.firedReason
      : null;
    const out = h.stageSince ? `out ${timeAgo(h.stageSince, now)} ago` : '';
    sub = [cause, out].filter(Boolean).join(' · ') || 'waiting for research';
  } else if (h.stage === 'RESEARCH_REQUESTED') {
    headline = 'Research queued';
    sub = 'waiting for the next research run';
  } else if (h.stage === 'RESEARCH_RUNNING') {
    headline = 'Researching';
    sub = h.stageSince ? `started ${timeAgo(h.stageSince, now)} ago` : 'ranking the current board';
  } else if (h.stage === 'POOL_STALE') {
    headline = 'Pool too thin';
    sub = 'research ran — waiting for the next board refresh';
  } else if (h.stage === 'ORDERING_READY') {
    if (h.noBuyerOnBoard) {
      // Direction gate: nobody on the scan bought inside the active window, so
      // the engine refuses every candidate. Saying "Hiring" here would imply a
      // hire is imminent when none can happen (2026-11-01).
      headline = 'Waiting for a buyer';
      sub = `none of ${h.checkedOnBoard} checked candidates bought in the window — stays flat until one does`;
    } else {
      headline = 'Hiring';
      sub = 'fresh ordering validated — top candidate activates';
    }
  }

  const tone =
    h.stage === 'IDLE_COUNTDOWN'
      ? 'border-warnborder bg-warndim'
      : h.stage === 'HIRED'
        ? 'border-posborder bg-posdim'
        : h.stage === 'FIRED'
          ? 'border-negborder bg-negdim'
          : 'border-infoborder bg-infodim';

  return (
    <div
      className={`mt-3 rounded-[12px] border p-3 ${tone}`}
      data-testid="hiring-pipeline"
      aria-label={`hire pipeline: ${h.stage}`}
    >
      <div className="flex items-center gap-1" aria-label="pipeline stages">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1 flex-1 min-w-0">
            <span
              className={`flex-1 text-center rounded-full px-1 py-0.5 text-[8.5px] font-semibold tracking-wide truncate ${
                s.done ? 'bg-posdim text-pos' : s.active ? 'bg-glassstrong text-ink' : 'text-faint'
              }`}
            >
              {s.done ? '✓ ' : ''}
              {s.label}
            </span>
            {i < steps.length - 1 && <span className="text-faint text-[9px]">›</span>}
          </div>
        ))}
      </div>

      <div className="text-center mt-2">
        <p
          className={`money font-bold leading-none ${
            h.stage === 'IDLE_COUNTDOWN' ? 'text-[28px] text-warn' : 'text-[16px] text-ink'
          }`}
          data-testid="pipeline-headline"
        >
          {headline}
        </p>
        <p className="label !text-[9.5px] mt-1 !text-faint">{sub}</p>
      </div>

      {state.activeTrader && h.stage === 'IDLE_COUNTDOWN' && (
        <p className="label !text-[9.5px] mt-2 text-center text-warn">
          @{state.activeTrader.handle} is replaced if nothing copies
        </p>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <p className="label !text-[9.5px]">Board scan</p>
          <p className="money font-semibold text-[11.5px]">
            {h.latestScanAt ? `${timeAgo(h.latestScanAt, now)} ago` : '—'}
          </p>
        </div>
        <div className="text-right">
          <p className="label !text-[9.5px]">Last ordering</p>
          <p className="money font-semibold text-[11.5px]">
            {h.recommendationAt ? `${timeAgo(h.recommendationAt, now)} old` : '—'}
          </p>
        </div>
      </div>

      {h.pausedForResearch && (
        <p className="text-[10.5px] text-muted mt-2 leading-snug text-center">
          The best candidate <span className="font-semibold">right now</span> is hired automatically once the
          new ordering validates.
        </p>
      )}
      {h.firedReason && (
        <p
          className="mt-2 text-[10px] text-muted break-words text-center"
          data-testid="pipeline-fired-reason"
        >
          Fired: {h.firedReason}
        </p>
      )}
      {h.reason && (
        <p className="mt-1.5 text-[9.5px] text-faint break-words text-center" data-testid="pipeline-reason">
          {h.reason}
        </p>
      )}
    </div>
  );
}

/** Milliseconds as "HH:MM" (hours can exceed 24; minutes padded). */
export function hhmm(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
