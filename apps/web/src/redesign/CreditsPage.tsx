import type { DashboardState } from '../types';
import type { CreditsView, SettingsView } from './model';
import { creditsModel } from './model';
import { ageLabel, compactInt, eetShort, pct } from './format';

const LADDER = [
  {
    id: 'green',
    name: 'Normal',
    color: '#34d399',
    desc: 'Under 75% of every path cap and under 450k this cycle. Normal cadence.',
  },
  {
    id: 'amber',
    name: 'Throttled watch',
    color: '#fbbf24',
    desc: 'Watch poll slows; watch fallback goes public-only.',
  },
  {
    id: 'red',
    name: 'Red',
    color: '#f87171',
    desc: 'Discovery, vetting, deep-dives and Helius mint checks pause.',
  },
  {
    id: 'roster-only',
    name: 'Roster-only',
    color: '#ef4444',
    desc: '600k: only roster monitoring and exits spend Helius; hires frozen.',
  },
  {
    id: 'exits-only',
    name: 'Exits-only',
    color: '#b91c1c',
    desc: '900k: entries pause; exits and reconciliation still run.',
  },
] as const;

const RED_PAUSED = new Set(['vetting', 'agent', 'token', 'wallet']);
const PATH_LABEL: Record<string, string> = {
  roster: 'Roster stream',
  exit: 'Exit & execution',
  wallet: 'Wallet & fee ledger',
  watch: 'Watch list',
  vetting: 'Vetting scans',
  agent: 'Agent deep-dives',
  token: 'Token safety',
  health: 'Health',
  outage: 'Outage reserve',
};
const PATH_NOTE: Record<string, string> = {
  roster: 'WSS + filtered getTransaction',
  exit: 'ring-fenced reserve',
  wallet: 'getBalance, token accounts',
  watch: 'public RPC first · Helius fallback',
  vetting: 'one full scan per candidate',
  agent: 'requested by the retired pipeline',
  token: 'mint check, cached',
  health: '1 getSlot every 15 min',
  outage: 'stream-outage reserve',
};

function pathState(id: string, level: string, exempt: boolean): 'exempt' | 'paused' | 'throttled' | 'ok' {
  if (exempt) return 'exempt';
  if (level === 'roster-only' || level === 'exits-only') return 'paused';
  if (level === 'red' && RED_PAUSED.has(id)) return 'paused';
  if (id === 'watch' && level !== 'green') return 'throttled';
  return 'ok';
}

export function CreditsPage({
  state,
  credits,
  settings,
}: {
  state: DashboardState;
  credits: CreditsView | null;
  settings: SettingsView | null;
}) {
  const model = creditsModel(state, credits, settings);
  const levelIndex = Math.max(
    0,
    LADDER.findIndex((rung) => rung.id === model.level),
  );
  const pctOf = (value: number, total: number) => (total > 0 ? Math.min(100, (value / total) * 100) : 0);
  const monthPct = pctOf(model.month, model.freePlan);

  return (
    <section className="view on" id="v-credits" data-testid="desk-credits">
      <div className="toolbar">
        <div>
          <h2 className="title">Credits</h2>
          <div className="sub">
            Every Helius call goes through the governor. Roster and exits are ring-fenced and never paused.
            The dashboard only reads the meter; it adds no Helius calls.
          </div>
        </div>
      </div>

      <div className="g gcred" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="panel" data-testid="helius-meter">
          <div className="ph">
            <h3>Helius · this cycle</h3>
            <span className="dim" style={{ fontSize: 12 }}>
              free plan · {model.dayOfMonth}/{model.daysInMonth} of the calendar month
            </span>
            <span className="r">
              <span
                className="pill"
                style={{
                  color: LADDER[levelIndex]!.color,
                  border: `1px solid ${LADDER[levelIndex]!.color}55`,
                  background: `${LADDER[levelIndex]!.color}18`,
                }}
              >
                ● {LADDER[levelIndex]!.name}
              </span>
            </span>
          </div>

          <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div
                className="dim"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em' }}
              >
                Used
              </div>
              <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.03em' }} className="num">
                {model.month.toLocaleString('en-US')}{' '}
                <span className="dim" style={{ fontSize: 15, fontWeight: 500 }}>
                  / {model.freePlan.toLocaleString('en-US')}
                </span>
              </div>
            </div>
            <div>
              <div
                className="dim"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em' }}
              >
                Pace to month end
              </div>
              <div style={{ fontSize: 20, fontWeight: 650 }} className="num">
                {model.projection.toLocaleString('en-US')}{' '}
                <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>
                  {model.freePlan > 0 ? `${((model.projection / model.freePlan) * 100).toFixed(1)}%` : '—'}
                </span>
              </div>
            </div>
            <div>
              <div
                className="dim"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em' }}
              >
                Avg / day
              </div>
              <div style={{ fontSize: 20, fontWeight: 650 }} className="num">
                {Math.round(model.month / model.dayOfMonth).toLocaleString('en-US')}
              </div>
            </div>
          </div>

          <div className="meter-big">
            <span style={{ width: `${monthPct}%` }} />
            <div
              className="proj"
              style={{
                left: `${monthPct}%`,
                width: `${Math.max(0, pctOf(model.projection, model.freePlan) - monthPct)}%`,
              }}
            />
            <i
              className="mk"
              style={{ left: `${pctOf(model.monthCaps.rosterOnly, model.freePlan)}%`, background: '#f87171' }}
            >
              <em className="up" style={{ color: '#fca5a5' }}>
                60% roster-only
              </em>
            </i>
            <i
              className="mk"
              style={{ left: `${pctOf(model.monthCaps.exitsOnly, model.freePlan)}%`, background: '#ef4444' }}
            >
              <em style={{ color: '#ef4444' }}>90% exits-only</em>
            </i>
          </div>

          <div className="ph" style={{ marginBottom: 4, marginTop: 10 }}>
            <h3 style={{ fontSize: 13 }}>Today by path</h3>
            <span className="dim" style={{ fontSize: 12 }}>
              governor buckets · resets 00:00 EET
            </span>
            <span className="r num" style={{ fontSize: 12.5 }}>
              <b>{model.dayTotal.toLocaleString('en-US')}</b>{' '}
              <span className="dim">/ {model.dayCap.toLocaleString('en-US')} cap</span>
            </span>
          </div>
          <div>
            {model.pathRows.map((row) => {
              const state = pathState(row.id, model.level, row.exempt);
              const width = pctOf(row.used, row.cap);
              return (
                <div className="path" key={row.id}>
                  <div className="nm">
                    {PATH_LABEL[row.id] ?? row.id}
                    <small>{PATH_NOTE[row.id] ?? ''}</small>
                  </div>
                  <div className="pbar">
                    <span
                      style={{
                        width: `${Math.max(width, 0.8)}%`,
                        background:
                          state === 'paused'
                            ? '#4b5263'
                            : state === 'throttled'
                              ? 'var(--amber)'
                              : row.exempt
                                ? 'linear-gradient(90deg,#34d399,#22d3ee)'
                                : 'linear-gradient(90deg,#7c6cff,#60a5fa)',
                      }}
                    />
                    {row.expected > 0 && (
                      <i className="exp" style={{ left: `${pctOf(row.expected, row.cap)}%` }} />
                    )}
                  </div>
                  <div className="cap num" style={{ textAlign: 'right' }}>
                    {row.used.toLocaleString('en-US')}{' '}
                    <span className="dim">/ {row.cap.toLocaleString('en-US')}</span>
                  </div>
                  <div className="pl" style={{ textAlign: 'right' }}>
                    {state === 'exempt' ? (
                      <span className="pill ex">exempt</span>
                    ) : state === 'paused' ? (
                      <span className="pill" style={{ color: '#9ca3af', border: '1px solid #374151' }}>
                        paused
                      </span>
                    ) : state === 'throttled' ? (
                      <span className="pill am">throttled</span>
                    ) : (
                      <span className="pill info">open</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div className="panel">
            <div className="ph">
              <h3>Governor</h3>
              <span className="r dim" style={{ fontSize: 12 }}>
                degrade ladder
              </span>
            </div>
            <div className="ladder">
              {LADDER.map((rung, index) => (
                <div
                  className={`rung ${index === levelIndex ? 'on' : ''}`}
                  key={rung.id}
                  style={index === levelIndex ? { borderColor: rung.color } : undefined}
                >
                  <i className="sw" style={{ background: rung.color }} />
                  <div style={{ color: 'var(--tx2)' }}>
                    <b>
                      {rung.name}
                      {index === levelIndex && (
                        <span style={{ color: rung.color, fontWeight: 600 }}> · active</span>
                      )}
                    </b>
                    {rung.desc}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <h3>Meter vs Helius</h3>
              <span
                className={`r ${model.admin === 'ok' ? 'okchip' : 'dim'}`}
                style={model.admin === 'ok' ? undefined : { fontSize: 12 }}
              >
                <i className="dot" style={{ width: 7, height: 7 }} />
                {model.admin === 'ok' ? 'In sync' : model.admin}
              </span>
            </div>
            <div className="g g2" style={{ gap: 10, gridTemplateColumns: '1fr 1fr' }}>
              <div className="tile">
                <div className="k">In-app meter</div>
                <div className="v num">{model.month.toLocaleString('en-US')}</div>
              </div>
              <div className="tile">
                <div className="k">Helius Admin API</div>
                <div className="v num">
                  {model.reportedUsed === null ? '—' : model.reportedUsed.toLocaleString('en-US')}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--tx2)', marginTop: 10, lineHeight: 1.5 }}>
              {model.reportedUsed === null || model.driftPct === null ? (
                (model.adminDetail ??
                'The Helius Admin usage figure is unavailable; the governor uses its own meter.')
              ) : Math.abs(model.driftPct) > 1000 ? (
                <>
                  The Admin figure is from an earlier process (drift{' '}
                  <b className="num" style={{ color: 'var(--tx)' }}>
                    {pct(model.driftPct)}
                  </b>
                  ). The in-app meter governs until the next reconciliation; no figure here is invented.
                </>
              ) : (
                <>
                  Drift{' '}
                  <b className="num" style={{ color: 'var(--tx)' }}>
                    {pct(model.driftPct)}
                  </b>{' '}
                  (alert at 10%). The governor trusts the higher figure. Last check{' '}
                  {model.reportedAt ? eetShort(model.reportedAt) : '—'}.
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="g g3" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="ph">
            <h3>Helius · last 7 days</h3>
            <span className="r dim" style={{ fontSize: 12 }}>
              stacked by path
            </span>
          </div>
          <div className="empty-gap">
            <b>Not tracked yet.</b> The governor keeps today's buckets and the cycle total in memory; it does
            not persist a daily history. Adding one would be a read-only follow-up, not a fabricated chart.
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            <h3>Fomo API</h3>
            <span className={`okchip ${model.fomo.configured ? '' : 'off'}`}>
              <i className="dot" style={{ width: 7, height: 7 }} />
              {model.fomo.configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em' }}>
            Credits remaining
          </div>
          <div className="num" style={{ fontSize: 20, fontWeight: 650 }}>
            {model.fomo.creditsRemaining === null ? '—' : model.fomo.creditsRemaining.toLocaleString('en-US')}
          </div>
          <div
            className="dim"
            style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em', marginTop: 14 }}
          >
            Last discovery sync
          </div>
          <div className="num" style={{ fontSize: 15, fontWeight: 600 }}>
            {model.fomo.lastSyncAt
              ? `${eetShort(model.fomo.lastSyncAt)} · ${ageLabel(model.fomo.lastSyncAt)} ago`
              : 'never'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5, marginTop: 10 }}>
            Sources: {model.fomo.sources.length ? model.fomo.sources.join(', ') : '—'}. The monthly cap is not
            exposed by the runtime, so this screen never prints one.
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            <h3>Jupiter · free key</h3>
            <span
              className={`okchip ${model.jupiter.keyConfigured && model.jupiter.health === 'OK' ? '' : 'off'}`}
            >
              <i className="dot" style={{ width: 7, height: 7 }} />
              {model.jupiter.keyConfigured ? model.jupiter.health : 'Not configured'}
            </span>
          </div>
          <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em' }}>
            Key
          </div>
          <div className="num" style={{ fontSize: 20, fontWeight: 650 }}>
            {model.jupiter.keyConfigured ? 'configured' : 'not configured'}
          </div>
          <div
            className="dim"
            style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.07em', marginTop: 14 }}
          >
            Base URL
          </div>
          <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {model.jupiter.baseUrl}
          </div>
          <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5, marginTop: 10 }}>
            Per-lane request rates are enforced inside the provider; the runtime does not persist them, so
            they are not charted here.
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="ph">
          <h3>What this screen adds</h3>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.55 }}>
          Zero Helius calls. It reads the governor snapshot the server already keeps, the discovery kv
          counters, and the provider health the dashboard already streams. The projection is the current pace
          multiplied to month end and is labelled as a pace, never as a bill.
        </div>
      </div>
    </section>
  );
}
