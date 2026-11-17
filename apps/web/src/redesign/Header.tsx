import type { DashboardState } from '../types';
import type { CreditsView, SettingsView } from './model';
import { headerModel } from './model';
import { pct, signedUsdFromMicro, usdFromMicro } from './format';
import { CreditsIcon, LineIcon, RiskIcon, SeatsIcon } from './Icons';

export type RedesignRoute = 'line' | 'seats' | 'credits' | 'risk';

export const TABS: Array<{
  id: RedesignRoute;
  label: string;
  short: string;
  icon: (props: { size?: number }) => React.JSX.Element;
}> = [
  { id: 'line', label: 'Line', short: 'Line', icon: LineIcon },
  { id: 'seats', label: 'Seats & positions', short: 'Seats', icon: SeatsIcon },
  { id: 'credits', label: 'Credits', short: 'Credits', icon: CreditsIcon },
  { id: 'risk', label: 'Risk settings', short: 'Risk', icon: RiskIcon },
];

function dotClass(status: string): string {
  if (status === 'OK') return 'dot';
  if (status === 'DEGRADED') return 'dot amber';
  if (status === 'DOWN') return 'dot red';
  return 'dot gray';
}

function fomoStatus(state: DashboardState, settings: SettingsView | null): { status: string; title: string } {
  if (settings && !settings.providers.fomoApiConfigured) {
    return { status: 'UNCONFIGURED', title: 'Fomo API: not configured in this runtime' };
  }
  const last = state.pipeline.discovery.lastSyncAt;
  if (!last) return { status: 'UNCONFIGURED', title: 'Fomo: no sync recorded yet' };
  const ageH = (Date.now() - Date.parse(last)) / 3_600_000;
  return {
    status: ageH <= 24 ? 'OK' : ageH <= 72 ? 'DEGRADED' : 'DOWN',
    title: `Fomo last sync ${last}`,
  };
}

function solStatus(sol: string | null): 'OK' | 'DEGRADED' | 'DOWN' | 'UNCONFIGURED' {
  if (sol === null) return 'UNCONFIGURED';
  const value = Number(sol);
  if (!Number.isFinite(value)) return 'UNCONFIGURED';
  return value < 0.02 ? 'DOWN' : value < 0.05 ? 'DEGRADED' : 'OK';
}

function Kpi({
  label,
  value,
  sub,
  tone,
  className = '',
  children,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: 'pos' | 'neg';
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`kpi ${className}`}>
      <span className="l">{label}</span>
      <span className={`v num ${tone ?? ''}`}>{value}</span>
      {sub !== undefined && <span className="s num">{sub}</span>}
      {children}
    </div>
  );
}

export function Header({
  state,
  settings,
  credits,
  route,
  onRoute,
  connected,
}: {
  state: DashboardState;
  settings: SettingsView | null;
  credits: CreditsView | null;
  route: RedesignRoute;
  onRoute: (route: RedesignRoute) => void;
  connected: boolean;
}) {
  const h = headerModel(state, settings);
  const month = credits?.month ?? 0;
  const freePlan = credits?.freePlan ?? 1_000_000;
  const rosterOnly = credits?.monthCaps?.rosterOnly ?? 600_000;
  const monthPct = Math.min(100, (month / freePlan) * 100);
  const fomo = fomoStatus(state, settings);
  const sol = h.solBalance;
  const solTone = solStatus(sol);
  const solDot =
    solTone === 'OK' ? '' : solTone === 'DEGRADED' ? 'amber' : solTone === 'DOWN' ? 'red' : 'gray';
  const solUsd = h.solUsdMicro ? usdFromMicro(h.solUsdMicro) : null;
  const rent =
    h.rentLamports !== null && h.rentLamports !== undefined
      ? `${(h.rentLamports / 1e9).toFixed(4)} SOL rent`
      : 'rent not sampled';
  const heliusStatus =
    settings && !settings.providers.heliusConfigured ? 'UNCONFIGURED' : state.health.helius;
  const jupiterStatus =
    settings && !settings.providers.jupiter.keyConfigured ? 'UNCONFIGURED' : state.health.jupiter;

  return (
    <header className="top">
      <div className="top-in">
        <div className="brand">
          <div className="logo">
            <i />
          </div>
          <span className="nm" role="heading" aria-level={1}>
            Copydesk
          </span>
          <span
            className={`badge ${h.modeClass}`}
            data-testid={state.mode === 'demo' ? 'badge-demo' : 'badge-mode'}
            title={connected ? 'live stream connected' : 'reconnecting to the server'}
          >
            {h.modeLabel}
          </span>
        </div>

        <div className="kpis">
          <Kpi label="Equity" value={usdFromMicro(h.equity)} />
          <Kpi
            label="Today"
            value={signedUsdFromMicro(h.today)}
            tone={h.today >= 0n ? 'pos' : 'neg'}
            sub={`realised ${signedUsdFromMicro(h.realized)}`}
          />
          <Kpi
            label="Unrealised"
            value={signedUsdFromMicro(h.unrealized)}
            tone={h.unrealized >= 0n ? 'pos' : 'neg'}
            sub={`${h.unrealPct === null ? '—' : pct(h.unrealPct)} · ${h.openCount} open`}
          />
          <Kpi
            label="USDC free"
            value={usdFromMicro(h.usdcFree)}
            sub={`deployed ${usdFromMicro(h.deployed)} · room ${usdFromMicro(h.room)}`}
          />
          <Kpi
            label="SOL balance"
            value={`${sol ?? '—'} SOL`}
            className="kpisol"
            sub={
              <>
                <span
                  className={`dot ${solDot}`}
                  style={{ width: 7, height: 7, marginRight: 5, verticalAlign: 1 }}
                />
                {sol === null ? 'balance not sampled' : solUsd ? `≈ ${solUsd}` : 'no USD price'} · {rent}
              </>
            }
          />
          <div className="kpi helius-kpi only-sm">
            <span className="l">
              Helius month{' '}
              <span className="num" style={{ color: 'var(--tx2)', letterSpacing: 0, textTransform: 'none' }}>
                {month.toLocaleString('en-US')} / {freePlan.toLocaleString('en-US')}
              </span>
            </span>
            <div className="bar cm" style={{ marginTop: 6 }}>
              <span
                style={{
                  width: `${monthPct}%`,
                  background: 'linear-gradient(90deg,var(--acc),var(--cyan))',
                }}
              />
              <i
                className="ceil"
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: `${(rosterOnly / freePlan) * 100}%`,
                  width: 2,
                  background: 'var(--amber)',
                }}
              />
            </div>
          </div>
        </div>

        <div className="status">
          <div className="st" title={`Helius: ${heliusStatus}`}>
            <i className={dotClass(heliusStatus)} />
            <span className="tx">Helius</span>
            <span className="txm" style={{ display: 'none' }}>
              Helius
            </span>
          </div>
          <div className="st" title={`Jupiter: ${jupiterStatus}`}>
            <i className={dotClass(jupiterStatus)} />
            <span className="tx">Jupiter</span>
            <span className="txm" style={{ display: 'none' }}>
              Jup
            </span>
          </div>
          <div className="st" title={fomo.title}>
            <i className={dotClass(fomo.status)} />
            <span className="tx">Fomo</span>
            <span className="txm" style={{ display: 'none' }}>
              Fomo
            </span>
          </div>
          <div className="cmini hide-sm" title="Helius cycle used vs the 60% roster-only ceiling">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10.5,
                color: 'var(--tx3)',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              <span>Helius</span>
              <span className="num" style={{ color: 'var(--tx2)', textTransform: 'none', letterSpacing: 0 }}>
                {month.toLocaleString('en-US')} / {freePlan.toLocaleString('en-US')}
              </span>
            </div>
            <div className="bar" style={{ overflow: 'visible' }}>
              <span style={{ width: `${monthPct}%` }} />
              <i className="ceil" style={{ left: `${(rosterOnly / freePlan) * 100}%` }} />
            </div>
          </div>
        </div>
      </div>

      <nav className="tabs" aria-label="Dashboard sections" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={route === id}
            className={route === id ? 'on' : ''}
            onClick={() => onRoute(id)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}

export function BottomNav({
  route,
  onRoute,
}: {
  route: RedesignRoute;
  onRoute: (route: RedesignRoute) => void;
}) {
  return (
    <nav className="bottomnav" aria-label="Dashboard sections" role="tablist">
      {TABS.map(({ id, short, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={route === id}
          className={route === id ? 'on' : ''}
          onClick={() => onRoute(id)}
        >
          <Icon size={20} />
          {short}
        </button>
      ))}
    </nav>
  );
}
