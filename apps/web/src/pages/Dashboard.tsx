import type { DashboardState } from '../types';
import { Header } from '../components/Header';
import { EquityHero } from '../components/EquityHero';
import { ActiveTraderCard } from '../components/ActiveTraderCard';
import { PositionsPanel } from '../components/PositionsPanel';
import { ActivityFeed } from '../components/ActivityFeed';
import { ClosesChart } from '../components/ClosesChart';
import { CandidatesPanel } from '../components/CandidatesPanel';
import { HandoffOverlay } from '../components/HandoffOverlay';

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
      <EquityHero state={state} />
      <ActiveTraderCard state={state} />
      <PositionsPanel state={state} />
      <ActivityFeed state={state} />
      <ClosesChart state={state} />
      <CandidatesPanel state={state} />
      <footer className="pb-24 text-center">
        <p className="label !text-[9.5px] !text-faint">
          ZCode Bot · mode {state.mode} · {state.armed ? 'live armed' : 'not armed'} · worker{' '}
          {state.health.workerRunning ? 'ok' : 'down'} · helius {state.health.helius.toLowerCase()} · jupiter{' '}
          {state.health.jupiter.toLowerCase()}
        </p>
        {state.health.pendingReconciliations > 0 && (
          <p className="label !text-[9.5px] !text-info mt-1">
            {state.health.pendingReconciliations} reconciliation case(s) open
          </p>
        )}
      </footer>
      {state.handoff && <HandoffOverlay handoff={state.handoff} />}
    </>
  );
}
