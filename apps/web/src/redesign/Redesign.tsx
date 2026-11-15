import { useState } from 'react';
import { api } from '../api';
import type { DashboardState } from '../types';
import type { AuditEvent, CandidateRejectionRow, CreditsView, RejectionsView, SettingsView } from './model';
import { useRemote } from './useRemote';
import { BottomNav, Header, type RedesignRoute } from './Header';
import { LinePage } from './LinePage';
import { SeatsPage } from './SeatsPage';
import { CreditsPage } from './CreditsPage';
import { RiskPage } from './RiskPage';
import { FireSeatModal, SeatDrawer, WatchDrawer } from './Drawers';

export function Redesign({
  state,
  connected,
  route,
  onRoute,
  onDemoReplay,
}: {
  state: DashboardState;
  connected: boolean;
  route: RedesignRoute;
  onRoute: (route: RedesignRoute) => void;
  onDemoReplay: () => void;
}) {
  const settings = useRemote<SettingsView>(() => api.settings() as unknown as Promise<SettingsView>, 60_000);
  const credits = useRemote<CreditsView>(() => api.credits() as unknown as Promise<CreditsView>, 60_000);
  const rejections = useRemote<RejectionsView>(
    () => api.rejections() as unknown as Promise<RejectionsView>,
    60_000,
  );
  const audit = useRemote<{ events: AuditEvent[] }>(
    () => api.audit() as unknown as Promise<{ events: AuditEvent[] }>,
    30_000,
  );
  const [watchId, setWatchId] = useState<string | null>(null);
  const [seatId, setSeatId] = useState<string | null>(null);
  const [fireOpen, setFireOpen] = useState(false);

  const settingsData = settings.data;
  const auditEvents = audit.data?.events ?? [];
  const candidateRejections = rejections.data?.candidateRejections as CandidateRejectionRow[] | undefined;

  const togglePause = () => {
    const action = settingsData?.control.newEntriesPaused
      ? api.resume()
      : api.pause('paused from the funnel');
    void action
      .then(() => {
        settings.reload();
      })
      .catch(() => undefined);
  };

  return (
    <div className="cdx">
      <Header
        state={
          settingsData
            ? {
                ...state,
                control: {
                  newEntriesPaused: settingsData.control.newEntriesPaused,
                  emergencyStopped: settingsData.control.emergencyStopped,
                  pausedReason: settingsData.control.pausedReason ?? null,
                },
              }
            : state
        }
        settings={settingsData}
        credits={credits.data}
        route={route}
        onRoute={onRoute}
        connected={connected}
      />

      {state.fictional && (
        <div className="demo-banner" data-testid="demo-banner">
          <span>Fictional demo · not a performance claim</span>
          <button className="btn ghost" onClick={onDemoReplay}>
            ↻ Replay 28s
          </button>
        </div>
      )}

      <main>
        {route === 'line' && (
          <LinePage
            state={state}
            settings={settingsData}
            audit={auditEvents}
            candidateRejections={candidateRejections}
            onSelectWatch={setWatchId}
            onSelectSeat={setSeatId}
            onPauseToggle={togglePause}
            onOpenFire={() => setFireOpen(true)}
            connected={connected}
          />
        )}
        {route === 'seats' && <SeatsPage state={state} settings={settingsData} onSelectSeat={setSeatId} />}
        {route === 'credits' && <CreditsPage state={state} credits={credits.data} settings={settingsData} />}
        {route === 'risk' &&
          (settingsData ? (
            <RiskPage
              settings={settingsData}
              audit={auditEvents}
              onSaved={() => {
                settings.reload();
                audit.reload();
              }}
              onPausedChanged={() => {
                settings.reload();
              }}
            />
          ) : (
            <div className="cdx-loading">Loading the risk configuration…</div>
          ))}

        <footer className="cdx-footer">
          <span>
            Copydesk · mode {state.mode} · worker {state.health.workerRunning ? 'ok' : 'down'} · Helius{' '}
            {state.health.helius.toLowerCase()} · Jupiter {state.health.jupiter.toLowerCase()}
          </span>
          <a href="#/ops">Ops console</a>
          <a href="#/audit">Audit log</a>
          <a href="#/legacy-settings">Provider keys &amp; imports</a>
        </footer>
      </main>

      <BottomNav route={route} onRoute={onRoute} />

      {watchId && (
        <WatchDrawer
          state={state}
          settings={settingsData}
          candidateId={watchId}
          onClose={() => setWatchId(null)}
        />
      )}
      {seatId && (
        <SeatDrawer
          state={state}
          settings={settingsData}
          activationId={seatId}
          onClose={() => setSeatId(null)}
        />
      )}
      {fireOpen && <FireSeatModal state={state} onClose={() => setFireOpen(false)} />}
    </div>
  );
}
