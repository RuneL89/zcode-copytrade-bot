import type { DashboardState } from '../types';

/**
 * Detail behind the tappable header badges: everything the footer used to
 * whisper at 8px — control state, pausing reason, providers, worker, wallet —
 * in one readable panel.
 */
export function StatusDrawer({
  state,
  connected,
  onClose,
}: {
  state: DashboardState | null;
  connected: boolean;
  onClose: () => void;
}) {
  type Tone = 'pos' | 'neg' | 'warn';
  const rows: Array<{ k: string; v: string; tone?: Tone }> = [];
  if (state) {
    const c = state.control;
    rows.push({
      k: 'Mode',
      v: state.mode.toUpperCase() + (state.armed ? ' · armed' : ' · not armed'),
      tone: state.armed ? 'neg' : undefined,
    });
    if (c.emergencyStopped) rows.push({ k: 'Emergency stop', v: 'ENGAGED', tone: 'neg' });
    if (c.newEntriesPaused) rows.push({ k: 'New entries', v: 'PAUSED', tone: 'warn' });
    if (c.pausedReason) rows.push({ k: 'Pause reason', v: c.pausedReason });
    rows.push({ k: 'Engine state', v: state.appState });
    rows.push({
      k: 'Worker',
      v: state.health.workerRunning ? 'running' : 'DOWN',
      tone: state.health.workerRunning ? 'pos' : 'neg',
    });
    rows.push({
      k: 'Helius',
      v: state.health.helius,
      tone: state.health.helius === 'OK' ? 'pos' : 'warn',
    });
    rows.push({
      k: 'Jupiter',
      v: state.health.jupiter,
      tone: state.health.jupiter === 'OK' ? 'pos' : 'warn',
    });
    if (state.health.pendingReconciliations > 0)
      rows.push({ k: 'Reconciliations', v: `${state.health.pendingReconciliations} open`, tone: 'warn' });
    if (state.health.feeSolBalance !== null)
      rows.push({ k: 'Fee wallet', v: `${state.health.feeSolBalance} SOL` });
    rows.push({ k: 'SSE', v: connected ? 'connected' : 'reconnecting', tone: connected ? 'pos' : 'warn' });
    rows.push({ k: 'Updated', v: new Date(state.generatedAt).toLocaleTimeString() });
  }

  return (
    <div className="absolute left-0 right-0 top-full z-30 px-4" data-testid="status-drawer">
      <div className="card p-4" style={{ background: 'rgba(23, 25, 32, 0.98)' }}>
        <div className="flex items-center justify-between">
          <p className="label">System status</p>
          <button
            type="button"
            onClick={onClose}
            className="label !text-[10.5px] cursor-pointer !text-faint hover:!text-ink"
          >
            Close
          </button>
        </div>
        {state ? (
          <dl className="mt-2 grid grid-cols-1 gap-y-1.5">
            {rows.map(({ k, v, tone }) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <dt className="text-[11.5px] text-faint shrink-0">{k}</dt>
                <dd
                  className={`mono text-[11px] text-right break-all ${
                    tone === 'pos'
                      ? 'text-pos'
                      : tone === 'neg'
                        ? 'text-neg'
                        : tone === 'warn'
                          ? 'text-warn'
                          : 'text-muted'
                  }`}
                >
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-2 text-[12px] text-muted">Waiting for the first state push…</p>
        )}
      </div>
    </div>
  );
}
