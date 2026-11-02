import type { DashboardState } from '../types';
import { Header } from '../components/Header';
import { EquityHero } from '../components/EquityHero';
import { PipelineFlow } from '../components/pipeline/PipelineFlow';
import { FiredLane } from '../components/FiredLane';
import { RosterPanel } from '../components/RosterPanel';
import { WatchRail } from '../components/WatchRail';
import { ClosesChart } from '../components/ClosesChart';
import { CandidatesPanel } from '../components/CandidatesPanel';

/**
 * The dashboard (plan 07): context row → equity hero → pipeline spine →
 * fired lane → roster grid → working area (positions 2/3, watch rail 1/3) →
 * secondary detail. The hero and its text stay in a bounded column on desktop
 * while the spine and the grids use the full 1080px container.
 */
export function Dashboard({
  state,
  connected,
  onDemoReplay,
}: {
  state: DashboardState;
  connected: boolean;
  onDemoReplay: () => void;
}) {
  return (
    <>
      <Header state={state} connected={connected} />
      {state.fictional && (
        <div
          className="card !bg-warndim !border-warnborder p-2.5 mb-3.5 flex items-center justify-between gap-2"
          data-testid="demo-banner"
        >
          <p className="label !text-warn !text-[10px] leading-snug">
            Fictional demo · not a performance claim
          </p>
          <button
            onClick={onDemoReplay}
            className="label !text-[10px] !text-warn border border-warnborder chip hover:bg-warndim cursor-pointer"
          >
            ↻ Replay 28s
          </button>
        </div>
      )}

      <div className="min-[900px]:max-w-[600px]">
        <EquityHero state={state} />
      </div>

      <PipelineFlow state={state} />
      <FiredLane state={state} />
      <RosterPanel state={state} />

      <div className="min-[900px]:grid min-[900px]:grid-cols-3 min-[900px]:gap-3.5 min-[900px]:items-start">
        <div className="min-[900px]:col-span-2">
          <ClosesChart state={state} />
        </div>
        <div>
          <WatchRail state={state} />
        </div>
      </div>

      {/* The activity tape lives in the rail's activity tab (plan 07 item 5);
          the sections below are the secondary detail. */}
      <CandidatesPanel state={state} />

      <footer className="pb-24 text-center">
        <p className="label !text-[10px] !text-faint">
          ZCode Bot · mode {state.mode} · {state.armed ? 'live armed' : 'not armed'} · worker{' '}
          {state.health.workerRunning ? 'ok' : 'down'} · helius {state.health.helius.toLowerCase()} · jupiter{' '}
          {state.health.jupiter.toLowerCase()}
        </p>
        {state.health.pendingReconciliations > 0 && (
          <p className="label !text-[10px] !text-info mt-1">
            {state.health.pendingReconciliations} reconciliation case(s) open
          </p>
        )}
      </footer>
    </>
  );
}
