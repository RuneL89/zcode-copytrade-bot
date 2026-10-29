import type { DashboardState } from '../types';

function RobotIcon({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="4" fill="url(#robot-grad)" />
      <circle cx="9" cy="13" r="1.6" fill="#fff" />
      <circle cx="15" cy="13" r="1.6" fill="#fff" />
      <path d="M9 16.4h6" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 7V4.6" stroke="url(#robot-grad)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="4" r="1.3" fill="#7c6fd8" />
      <defs>
        <linearGradient id="robot-grad" x1="4" y1="7" x2="20" y2="19">
          <stop stopColor="#8b7ff0" />
          <stop offset="1" stopColor="#5ea8e0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

const badgeStyles: Record<string, string> = {
  DEMO: 'bg-amber-100 text-amber-700 border-amber-200',
  PAPER: 'bg-sky-100 text-sky-700 border-sky-200',
  LIVE: 'bg-rose-100 text-rose-700 border-rose-200',
  PAUSED: 'bg-orange-100 text-orange-700 border-orange-200',
  STALE: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  RECONCILIATION: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200',
};

export function Header({ state, connected }: { state: DashboardState | null; connected: boolean }) {
  const badges = state?.badges ?? ['PAPER'];
  return (
    <header className="flex items-center justify-between px-1 pt-5 pb-3">
      <div className="flex items-center gap-3">
        <RobotIcon />
        <div>
          <h1 className="text-[17px] font-bold leading-tight tracking-tight">ZCode Bot</h1>
          <p className="label !text-[9px]">COPY TRADING · FOMO</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {badges.map((b) => (
          <span
            key={b}
            className={`label !text-[9px] rounded-full border px-2 py-0.5 ${badgeStyles[b] ?? 'bg-white/60 text-[#6d6893] border-white'}`}
            data-testid={`badge-${b.toLowerCase()}`}
          >
            {b === 'LIVE' ? (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 live-dot mr-1 align-middle" />
            ) : null}
            {b}
          </span>
        ))}
        <span
          title={connected ? 'live updates connected' : 'reconnecting…'}
          className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-orange-400'}`}
        />
      </div>
    </header>
  );
}
