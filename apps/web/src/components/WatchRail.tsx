import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DashboardState } from '../types';
import { ActivityFeed } from './ActivityFeed';
import { WatchlistPanel } from './WatchlistPanel';

type RailTab = 'watch' | 'activity' | 'audit';

interface AuditRow {
  createdAt?: unknown;
  category?: unknown;
  message?: unknown;
}

/**
 * The watch rail (plan 07): the working area's right-hand column with the three
 * supporting surfaces — the D4 watch list, the SSE activity tape, and the audit
 * trail — one card at a time. Every tab renders its own card; this component
 * only owns the tab bar, so the panels keep their own states and test ids.
 */
export function WatchRail({ state }: { state: DashboardState }) {
  const [tab, setTab] = useState<RailTab>('watch');
  return (
    <div data-testid="watch-rail">
      <div role="tablist" aria-label="Watch rail" className="flex gap-1 mb-2.5">
        {(
          [
            ['watch', 'Watch list'],
            ['activity', 'Activity'],
            ['audit', 'Audit'],
          ] as Array<[RailTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            data-testid={`rail-tab-${id}`}
            onClick={() => setTab(id)}
            className={`label !text-[10.5px] chip border cursor-pointer min-h-[44px] min-[900px]:min-h-[36px] ${
              tab === id
                ? 'bg-accentdim text-accent border-accentborder'
                : 'bg-inset text-muted border-insetborder'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'watch' && <WatchlistPanel state={state} />}
      {tab === 'activity' && <ActivityFeed state={state} />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

/**
 * The rail's audit tab: the newest audit rows, straight from `/api/audit`.
 * Loading, error and empty states are explicit — an empty trail says so rather
 * than showing a spinner forever.
 */
function AuditTab() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .audit()
        .then((r) => {
          if (!alive) return;
          setRows((r.events as AuditRow[]).slice(0, 12));
          setError(null);
        })
        .catch((e: Error) => {
          if (alive) setError(e.message);
        });
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="card p-4 mb-3.5" aria-label="audit trail" data-testid="rail-audit">
      <p className="label">Audit trail</p>
      {error !== null && (
        <p className="text-[11px] text-neg mt-2" role="alert">
          {error}
        </p>
      )}
      {error === null && rows === null && (
        <p className="text-[11.5px] text-muted mt-2" data-testid="rail-audit-loading">
          Loading the trail…
        </p>
      )}
      {error === null && rows !== null && rows.length === 0 && (
        <p className="text-[11.5px] text-muted mt-2" data-testid="rail-audit-empty">
          No audit events yet.
        </p>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="mt-2 space-y-1 mono text-[10.5px]">
          {rows.map((row, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-faint shrink-0">{String(row.createdAt ?? '').slice(11, 19)}</span>
              <span className="text-accent shrink-0">[{String(row.category ?? '')}]</span>
              <span className="text-muted truncate">{String(row.message ?? '')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
