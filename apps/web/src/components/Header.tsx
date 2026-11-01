import { useEffect, useState } from 'react';
import type { DashboardState } from '../types';
import { Logo } from './Logo';
import { StatusDrawer } from './StatusDrawer';

const badgeStyles: Record<string, string> = {
  DEMO: 'bg-warndim text-warn border-warnborder',
  PAPER: 'bg-accentdim text-accent border-accentborder',
  LIVE: 'bg-negdim text-neg border-negborder',
  PAUSED: 'bg-warndim text-warn border-warnborder',
  STALE: 'bg-warndim text-warn border-warnborder',
  RECONCILIATION: 'bg-infodim text-info border-infoborder',
};

function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Compact relative age for the freshness chip ("now", "12s", "3m"). */
function freshAge(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

export function Header({ state, connected }: { state: DashboardState | null; connected: boolean }) {
  const [statusOpen, setStatusOpen] = useState(false);
  const now = useNowTick(5_000);
  const badges = state?.badges ?? ['PAPER'];
  const generatedAge = state ? freshAge(state.generatedAt, now) : null;

  return (
    <header className="relative flex items-center justify-between px-1 pt-5 pb-3">
      <div className="flex items-center gap-3">
        <Logo size={32} />
        <div>
          <h1 className="text-[16px] font-bold leading-tight tracking-tight">ZCode Bot</h1>
          <p className="label !text-[10.5px] !text-faint">Copy trading · FOMO</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {badges.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => setStatusOpen((v) => !v)}
            aria-expanded={statusOpen}
            className={`tag chip cursor-pointer border ${badgeStyles[b] ?? 'bg-inset text-muted border-insetborder'}`}
            data-testid={`badge-${b.toLowerCase()}`}
          >
            {b === 'LIVE' ? (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-neg live-dot mr-1.5" />
            ) : null}
            {b}
          </button>
        ))}
        <span
          className="flex items-center gap-1"
          title={connected ? 'Live updates connected' : 'Reconnecting…'}
        >
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-pos live-dot' : 'bg-warn'}`} />
          {generatedAge && (
            <span className="mono text-[9.5px] text-faint" data-testid="freshness">
              {generatedAge}
            </span>
          )}
        </span>
      </div>
      {statusOpen && (
        <StatusDrawer state={state} connected={connected} onClose={() => setStatusOpen(false)} />
      )}
    </header>
  );
}
