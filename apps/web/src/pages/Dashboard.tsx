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
          className="card !bg-amber-50/80 border-amber-200 p-2.5 mb-4 flex items-center justify-between gap-2"
          data-testid="demo-banner"
        >
          <p className="label !text-amber-700 !text-[9px] leading-snug">
            FICTIONAL DEMO · NOT A PERFORMANCE CLAIM
          </p>
          <button
            onClick={onDemoReplay}
            className="label !text-[9px] !text-amber-800 border border-amber-300 rounded-full px-3 py-1 hover:bg-amber-100 transition-colors"
          >
            ↻ REPLAY 28s
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
        <p className="label !text-[8.5px]">
          ZCODE BOT · MODE {state.mode.toUpperCase()} · {state.armed ? 'LIVE ARMED' : 'NOT ARMED'} · WORKER{' '}
          {state.health.workerRunning ? 'OK' : 'DOWN'} · HELIUS {state.health.helius} · JUPITER{' '}
          {state.health.jupiter}
        </p>
        {state.health.pendingReconciliations > 0 && (
          <p className="label !text-[8.5px] !text-fuchsia-700 mt-1">
            {state.health.pendingReconciliations} RECONCILIATION CASE(S) OPEN
          </p>
        )}
      </footer>
      {state.handoff && <HandoffOverlay handoff={state.handoff} />}
    </>
  );
}
