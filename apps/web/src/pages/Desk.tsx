import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DashboardState } from '../types';
import { signedUsd, usd } from '../types';

type DeskTab = 'line' | 'seats' | 'credits' | 'risk';

const STAGES = ['Discovered', 'Screening', 'Shadow', 'Agent review', 'Bench', 'Hired', 'Cooling'] as const;

interface CreditView {
  dayTotal: number;
  month: number;
  level: string;
  byPath: Record<string, number>;
  hardCap: number;
  monthCeiling: number;
  admin?: string;
  adminDetail?: string | null;
  reported: { creditsUsed?: number; driftAlert?: boolean; admin?: string } | null;
}

const RISK_FIELDS = [
  'MIN_PER_BUY_USD',
  'MAX_PER_BUY_USD',
  'MAX_OPEN_PER_TRADER_USD',
  'MAX_DEPLOYED_PCT',
  'MAX_DAILY_REALIZED_LOSS_USD',
  'MAX_POSITION_AGE_HOURS',
  'POSITION_GRACE_HOURS',
  'STOP_LOSS_BPS',
  'TRAIL_DISTANCE_BPS',
] as const;

export function DeskPage({ state }: { state: DashboardState }) {
  const [tab, setTab] = useState<DeskTab>('line');
  const [seat, setSeat] = useState<string | null>(null);
  const sol = state.health.feeSolBalance;
  const solUsd = state.health.feeSolUsdMicro;
  const usdc = state.health.walletUsdcUsdMicro;
  const unrealized = state.roster.reduce((sum, row) => sum + BigInt(row.unrealizedPnlUsdMicro || '0'), 0n);
  const counts = stageCounts(state);
  const widest = Math.max(1, ...STAGES.map((name) => counts[name]));

  return (
    <div className="pt-4 pb-28" data-testid="desk">
      <header className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[15px] font-semibold">Copydesk</h1>
          <span className="tag" data-testid="desk-mode">
            {state.fictional ? 'DEMO' : state.appState}
          </span>
        </div>
        <p className="mt-3 text-[11px] uppercase tracking-wide text-muted">SOL balance</p>
        <p className="text-[40px] leading-none font-semibold tabular-nums" data-testid="sol-headline">
          {sol ?? '—'} <span className="text-[18px] text-muted">SOL</span>
        </p>
        <p className="mt-1 text-[13px] text-muted">{solUsd ? `$${usd(solUsd)}` : 'USD price unavailable'}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
          <Metric label="USDC available" value={usdc ? `$${usd(usdc)}` : '—'} />
          <Metric label="Unrealised" value={signedUsd(unrealized.toString())} />
          <Metric label="Equity" value={`$${usd(state.counters.capitalUsdMicro)}`} />
          <Metric label="Deployed" value={`${state.counters.deployedPct}%`} />
        </div>
      </header>

      <div className="flex gap-1 mb-3 overflow-x-auto" role="tablist">
        {(
          [
            ['line', 'Line'],
            ['seats', 'Seats'],
            ['credits', 'Credits'],
            ['risk', 'Risk'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`min-h-[44px] px-3 rounded-full text-[13px] ${tab === id ? 'bg-accentdim text-accent' : 'text-muted'}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'line' && (
        <section
          data-testid="desk-line"
          className="flex flex-col gap-3 min-[900px]:grid min-[900px]:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]"
        >
          <div className="card p-3">
            <p className="text-[13px] font-semibold">Funnel</p>
            <p className="text-[12px] text-muted mb-3">Many wallets in, five seats out.</p>
            <ol className="flex flex-col items-center gap-1">
              {STAGES.map((name) => (
                <li
                  key={name}
                  className="rounded-lg bg-inset px-3 py-2 flex justify-between gap-2 min-h-[44px] items-center"
                  style={{ width: `${Math.max(36, Math.round((counts[name] / widest) * 100))}%` }}
                >
                  <span className="text-[12px]">{name}</span>
                  <span className="tabular-nums font-semibold">{counts[name]}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="card p-3">
            <p className="text-[13px] font-semibold mb-2">Arena · {state.counters.rosterSize ?? 5} seats</p>
            <SeatList state={state} seat={seat} setSeat={setSeat} />
          </div>
        </section>
      )}

      {tab === 'seats' && (
        <section data-testid="desk-seats">
          <SeatList state={state} seat={seat} setSeat={setSeat} />
        </section>
      )}

      {tab === 'credits' && <CreditsTab />}
      {tab === 'risk' && <RiskTab />}
    </div>
  );
}

function SeatList({
  state,
  seat,
  setSeat,
}: {
  state: DashboardState;
  seat: string | null;
  setSeat: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: state.counters.rosterSize ?? 5 }, (_, index) => {
        const row = state.roster[index];
        const id = row?.activationId ?? `empty-${index}`;
        const trades = row ? state.positions.filter((position) => position.leaderHandle === row.handle) : [];
        return (
          <button
            key={id}
            className="card p-3 text-left min-h-[44px]"
            onClick={() => setSeat(seat === id ? null : id)}
          >
            <div className="flex justify-between gap-2">
              <span className="font-semibold">{row ? `@${row.handle}` : `Seat ${index + 1} open`}</span>
              <span className="tabular-nums">{row ? signedUsd(row.realizedPnlUsdMicro) : ''}</span>
            </div>
            {row && (
              <p className="text-[12px] text-muted mt-1">Unrealised {signedUsd(row.unrealizedPnlUsdMicro)}</p>
            )}
            {seat === id && row && (
              <ul className="mt-2 text-[12px]">
                {trades.map((position) => (
                  <li key={position.positionId} className="flex justify-between gap-2 py-1">
                    <span>{position.symbol ?? position.mintShort}</span>
                    <span className="tabular-nums">
                      ${usd(position.copyUsdMicro)} {signedUsd(position.unrealizedPnlUsdMicro)}
                    </span>
                  </li>
                ))}
                {trades.length === 0 && <li className="text-muted">No open copies</li>}
              </ul>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card px-3 py-2">
      <p className="text-[11px] uppercase text-muted">{label}</p>
      <p className="tabular-nums">{value}</p>
    </div>
  );
}

function stageCounts(state: DashboardState): Record<(typeof STAGES)[number], number> {
  const hired = state.roster.length;
  const bench = state.watchlist.bench;
  const watching = state.watchlist.rows.filter((row) => row.status === 'watching').length;
  const cooling = state.watchlist.rows.filter((row) => row.status === 'cooling').length;
  return {
    Discovered: state.pipeline.pool.total,
    Screening: state.pipeline.pool.fundedBuyers24h,
    Shadow: watching,
    'Agent review': state.pipeline.watch.promotable,
    Bench: bench,
    Hired: hired,
    Cooling: cooling,
  };
}

function CreditsTab() {
  const [view, setView] = useState<CreditView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api
      .credits()
      .then((body) => setView(body as unknown as CreditView))
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="text-neg">{error}</p>;
  if (!view) return <p className="text-muted">Loading credits…</p>;
  const dayWidth = Math.min(100, view.hardCap > 0 ? (view.dayTotal / view.hardCap) * 100 : 0);
  const monthWidth = Math.min(100, view.monthCeiling > 0 ? (view.month / view.monthCeiling) * 100 : 0);
  const widest = Math.max(1, ...Object.values(view.byPath));
  return (
    <section data-testid="desk-credits" className="card p-3">
      <p className="text-[13px]">
        Today {view.dayTotal.toLocaleString()} / {view.hardCap.toLocaleString()}
      </p>
      <div className="mt-1 h-2 rounded-full bg-inset overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${dayWidth}%` }} />
      </div>
      <p className="text-[13px] mt-3">
        Month {view.month.toLocaleString()} / {view.monthCeiling.toLocaleString()}
      </p>
      <div className="mt-1 h-2 rounded-full bg-inset overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${monthWidth}%` }} />
      </div>
      <p className="text-[12px] text-muted mt-2">Governor {view.level}</p>
      <ul className="mt-2 text-[12px] flex flex-col gap-1">
        {Object.entries(view.byPath).map(([path, credits]) => (
          <li key={path}>
            <div className="flex justify-between">
              <span>{path}</span>
              <span className="tabular-nums">{credits}</span>
            </div>
            <div className="h-1.5 rounded-full bg-inset overflow-hidden">
              <div
                className="h-full bg-accent"
                style={{ width: `${Math.round((credits / widest) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {view.admin && view.admin !== 'ok' && view.admin !== 'unknown' && (
        <p className="text-[12px] text-muted mt-2">
          {view.adminDetail ?? 'Helius Admin usage is unavailable. This meter is the in-app count.'}
        </p>
      )}
      {view.reported?.creditsUsed !== undefined && (
        <p className="text-[12px] text-muted mt-2">
          Helius Admin reports {view.reported.creditsUsed.toLocaleString()}
          {view.reported.driftAlert ? ' · drift over 10%' : ''}
        </p>
      )}
    </section>
  );
}

function RiskTab() {
  const [risk, setRisk] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [pin, setPin] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void api.settings().then((body) => {
      const current = (body as { risk?: Record<string, unknown> }).risk ?? {};
      const draft: Record<string, string> = {};
      for (const field of RISK_FIELDS) draft[field] = String(current[field] ?? '');
      setRisk(draft);
      setBaseline(draft);
    });
  }, []);

  const save = async () => {
    const patch: Record<string, unknown> = {};
    for (const field of RISK_FIELDS) {
      if (risk[field] !== baseline[field]) patch[field] = Number(risk[field]);
    }
    if (pin) patch.pin = pin;
    try {
      await api.patchSettings(patch);
      setBaseline(risk);
      setConfirming(false);
      setPin('');
      setMessage('Saved');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  return (
    <section data-testid="desk-risk" className="card p-3 flex flex-col gap-2">
      {RISK_FIELDS.map((field) => (
        <label key={field} className="text-[12px]">
          <span className="text-muted">{field}</span>
          <input
            className="mt-1 w-full min-h-[44px] rounded-lg bg-inset px-3"
            value={risk[field] ?? ''}
            onChange={(event) => setRisk({ ...risk, [field]: event.target.value })}
          />
        </label>
      ))}
      {!confirming ? (
        <button
          className="min-h-[44px] rounded-full bg-accentdim text-accent"
          onClick={() => setConfirming(true)}
        >
          Review change
        </button>
      ) : (
        <div className="border border-glassborder rounded-xl p-3" data-testid="risk-confirm">
          <p className="text-[13px] mb-2">Confirm the new limits. Raising risk needs the PIN.</p>
          <ul className="text-[12px] mb-2">
            {RISK_FIELDS.filter((field) => risk[field] !== baseline[field]).map((field) => (
              <li key={field}>
                {field}: {baseline[field]} → {risk[field]}
              </li>
            ))}
          </ul>
          <input
            className="w-full min-h-[44px] rounded-lg bg-inset px-3"
            type="password"
            autoComplete="off"
            placeholder="PIN if this raises risk"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            aria-label="Risk PIN"
          />
          <div className="flex gap-2 mt-2">
            <button
              className="min-h-[44px] flex-1 rounded-full bg-accentdim text-accent"
              onClick={() => void save()}
            >
              Confirm
            </button>
            <button className="min-h-[44px] flex-1" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <p>{message}</p>}
    </section>
  );
}
