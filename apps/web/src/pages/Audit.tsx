import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { RefreshIcon } from '../components/icons';

/** Relative + absolute stamp, e.g. "11m ago · 10:12". */
function dualTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const rel = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  const abs = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${rel} · ${abs}`;
}

const POLL_MS = 15_000;

/**
 * Audit trail: risk rejections, reconciliation cases, and the event log (the
 * watch/promotion decisions land there too). Refreshes every 15s and on demand
 * so the page never sits frozen at mount-time data.
 */
export function AuditPage({ onBack }: { onBack: () => void }) {
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [rejections, setRejections] = useState<Array<Record<string, unknown>>>([]);
  const [cases, setCases] = useState<Array<Record<string, unknown>>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, r, c] = await Promise.all([api.audit(), api.rejections(), api.reconciliation()]);
      setEvents(a.events);
      setRejections(r.rejections);
      setCases(c.cases);
      setFetchedAt(new Date().toISOString());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  return (
    <div className="pb-24">
      <div className="flex items-center justify-between pt-5 pb-3">
        <div>
          <h1 className="text-[17px] font-bold">Audit</h1>
          <p className="label !text-[10px] !text-faint mt-0.5">
            {fetchedAt ? `refreshed ${dualTime(fetchedAt, now)} · every 15s` : 'loading…'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              window.location.hash = '#/weekly';
              window.dispatchEvent(new Event('popstate'));
            }}
            className="label !text-[10.5px] underline cursor-pointer"
          >
            weekly review
          </button>
          <button
            onClick={() => void load()}
            aria-label="refresh audit"
            className="text-muted hover:text-ink cursor-pointer"
          >
            <RefreshIcon size={16} />
          </button>
          <button onClick={onBack} className="label !text-[10.5px] underline cursor-pointer">
            ← dashboard
          </button>
        </div>
      </div>
      {error && (
        <p className="text-[12px] text-neg mb-3" role="alert">
          {error}
        </p>
      )}

      <section className="card p-4 mb-3.5">
        <p className="label">Risk rejections</p>
        {rejections.length === 0 && <p className="text-[12px] text-muted mt-2">none</p>}
        <ul className="mt-2 mono text-[10.5px] space-y-1 max-h-56 overflow-auto text-muted">
          {rejections.slice(0, 40).map((r: Record<string, unknown>, i: number) => (
            <li key={i}>
              {String(r.createdAt).slice(11, 19)} {String(r.rule)} value={String(r.actualValue)} limit=
              {String(r.limitValue)}
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-4 mb-3.5">
        <p className="label">Reconciliation cases</p>
        {cases.length === 0 && <p className="text-[12px] text-muted mt-2">none open</p>}
        <ul className="mt-2 text-[12px] space-y-1">
          {cases.map((c, i) => (
            <li key={i} className="text-info">
              {String(c.kind)} · {String(c.detail ?? '')}
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-4">
        <p className="label">Event log</p>
        <ul className="mt-2 text-[11.5px] space-y-1 max-h-80 overflow-auto">
          {events.slice(0, 60).map((e: Record<string, unknown>, i: number) => (
            <li key={i} className="border-b border-insetborder pb-1">
              <span className="mono text-[9.5px] text-faint">
                {String(e.createdAt).slice(11, 19)} [{String(e.category)}]
              </span>{' '}
              {String(e.message)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
