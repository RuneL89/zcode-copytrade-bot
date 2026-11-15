import type { DashboardState } from '../types';
import type { AuditEvent, CandidateRejectionRow, SettingsView, DropRow } from './model';
import { dropsModel, feedModel, numberRisk, successionModel } from './model';
import { eetClock, eetShort, humanReason, signedUsdFromMicro, usdFromMicro } from './format';
import { Funnel } from './Funnel';
import { Arena } from './Arena';
import { EquityChart } from './Charts';
import { FlagIcon, PauseIcon } from './Icons';

const FEED_ICON: Record<string, string> = {
  spawn: '+',
  pass: '↗',
  drop: '✕',
  bench: '★',
  buy: 'B',
  win: '$',
  loss: '−',
  fire: '⚑',
  hire: '✓',
  wait: '⏳',
  info: 'i',
  agent: '◆',
  you: '↺',
};

export function LinePage({
  state,
  settings,
  audit,
  candidateRejections,
  onSelectWatch,
  onSelectSeat,
  onPauseToggle,
  onOpenFire,
  connected,
}: {
  state: DashboardState;
  settings: SettingsView | null;
  audit: AuditEvent[];
  candidateRejections: CandidateRejectionRow[] | undefined;
  onSelectWatch: (candidateId: string) => void;
  onSelectSeat: (activationId: string) => void;
  onPauseToggle: () => void;
  onOpenFire: () => void;
  connected: boolean;
}) {
  const drops: DropRow[] = dropsModel(state, candidateRejections);
  const feed = feedModel(audit);
  const succession = successionModel(state);
  const risk = settings?.risk ?? {};
  const maxHires = numberRisk(risk, 'MAX_HIRES_PER_DAY', 3);
  const hiresToday = settings?.hiring?.hiresToday ?? state.pipeline.hiresToday ?? 0;
  const agentHires = settings?.hiring?.mode === 'agent';
  // ControlService mutations are reflected by the settings endpoint before the
  // next SSE state rebuild, so the toolbar reads the fresher source.
  const control = settings?.control ?? state.control;
  const paused = control.newEntriesPaused;
  const stopped = control.emergencyStopped;
  const live = connected && state.health.workerRunning && !stopped;
  const today = BigInt(state.equity.currentUsdMicro) - BigInt(state.equity.startUsdMicro);
  const todayPct = Number((today * 10_000n) / (BigInt(state.equity.startUsdMicro) || 1n)) / 100;
  const realized = state.closes
    .filter((close) => close.t.slice(0, 10) === new Date().toISOString().slice(0, 10))
    .reduce((acc, close) => acc + BigInt(close.pnlUsdMicro), 0n);

  return (
    <section className="view on" id="v-line" data-testid="desk-line">
      <div className="ftool">
        <div>
          <h2 className="title">
            Trader funnel{' '}
            <span className={`livepill ${live ? '' : 'off'}`}>
              <i className="dot" />
              {stopped ? 'STOPPED' : paused ? 'PAUSED' : live ? 'LIVE' : 'STALE'}
            </span>
          </h2>
          <div className="sub">
            Many wallets in, {state.counters.rosterSize ?? 5} seats out. Code screens and scores, the
            promotion queue fills a chair, and you can pause or fire at any time.
          </div>
        </div>
        <div className="fctl">
          <button className="btn" onClick={onPauseToggle} disabled={stopped} data-testid="pause-entries">
            <PauseIcon />
            {paused ? 'Resume entries' : 'Pause entries'}
          </button>
          <button
            className="btn danger"
            onClick={onOpenFire}
            disabled={state.roster.length === 0}
            data-testid="fire-seat"
          >
            <FlagIcon />
            Fire a seat…
          </button>
          <span className="apmode">
            <span className={`pill ${agentHires ? 'agentpill' : 'ex'}`}>
              {agentHires ? '◆ Copytrader hires · you can overrule' : '◆ Code fills seats from the bench'}
            </span>
            <span
              className="pill info"
              title={`${hiresToday} activations started today. The ${maxHires}/day cap applies to agent hire decisions; code fills do not consume it.`}
            >
              seat starts today {hiresToday}
            </span>
            <span className="dim" style={{ fontSize: 11.5 }}>
              Hiring
            </span>
            <span
              className="seg hireseg"
              title="Set by HIRE_APPROVAL in .env; the dashboard shows it read-only"
            >
              <button className={agentHires ? 'on' : ''} disabled>
                Copytrader
              </button>
              <button className={!agentHires ? 'on' : ''} disabled>
                Auto
              </button>
            </span>
          </span>
        </div>
      </div>

      <div className="floor">
        <div className="panel fpanel" data-testid="funnel-panel">
          <div className="ph">
            <h3>Funnel</h3>
            <span className="dim" style={{ fontSize: 12 }}>
              today · width ∝ traders in stage
            </span>
            <span className="r dim num" style={{ fontSize: 12 }}>
              <b style={{ color: 'var(--tx)' }}>{state.pipeline.discovery.newHandles24h}</b> in →{' '}
              <b style={{ color: '#86efac' }}>{state.roster.length}</b> hired ·{' '}
              {state.pipeline.exits.fired24h +
                drops.filter((d) => d.at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length}{' '}
              dropped
            </span>
          </div>
          <Funnel state={state} drops={drops} onSelectWatch={onSelectWatch} />
        </div>

        <div className="panel arena" data-testid="arena-panel">
          <Arena state={state} settings={settings} onSelectSeat={onSelectSeat} />
        </div>
      </div>

      <div className="floor2">
        <div className="panel" data-testid="equity-panel">
          <div className="ph">
            <h3>Desk equity</h3>
            <span className="r dim" style={{ fontSize: 12 }}>
              paper book · since start
            </span>
          </div>
          <div className="eqk">
            <div>
              <div className="k">Equity</div>
              <div className="v num">{usdFromMicro(state.equity.currentUsdMicro)}</div>
            </div>
            <div>
              <div className="k">Today</div>
              <div className={`v num ${realized >= 0n ? 'pos' : 'neg'}`}>{signedUsdFromMicro(realized)}</div>
            </div>
            <div>
              <div className="k">Since start</div>
              <div className={`v num ${todayPct >= 0 ? 'pos' : 'neg'}`}>
                {todayPct >= 0 ? '+' : '−'}
                {Math.abs(todayPct).toFixed(1)}%
              </div>
            </div>
          </div>
          <EquityChart values={state.equity.series.map((point) => point.usdMicro)} />
          <div
            style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--tx3)' }}
          >
            <span>{state.equity.series[0] ? eetShort(state.equity.series[0].t) : '—'}</span>
            <span>dashed = equity at open</span>
            <span>now</span>
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            <h3>Seat succession</h3>
            <span className="r dim" style={{ fontSize: 12 }}>
              who replaced whom · tenure P&amp;L
            </span>
          </div>
          <div id="succ">
            {succession.length === 0 && (
              <div className="dim" style={{ fontSize: 12 }}>
                No firings recorded yet.
              </div>
            )}
            {succession.map((row) => (
              <div className="srow" key={`${row.handle}-${row.firedAt}`}>
                <span className="sno" title={humanReason(row.reason)}>
                  ↺
                </span>
                <div className="chain">
                  <span className="ten old">
                    <span className="t1">
                      <b>{row.handle}</b>
                    </span>
                    <span className="t2">
                      {eetShort(row.firedAt)} · {humanReason(row.reason)}
                    </span>
                  </span>
                  <span className="arr">→</span>
                  {row.replacedBy ? (
                    <span className="ten cur">
                      <span className="t1">
                        <b>{row.replacedBy}</b>
                      </span>
                      <span className="t2">filled the chair</span>
                    </span>
                  ) : (
                    <span className="ten pend">seat left empty</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel feedp" data-testid="live-feed">
          <div className="ph">
            <h3>Live feed</h3>
            <i className="dot" style={{ width: 7, height: 7 }} />
            <span className="r dim" style={{ fontSize: 12 }}>
              EET
            </span>
          </div>
          <div id="feed">
            {feed.slice(0, 14).map((item) => (
              <div className="fe" key={item.id}>
                <span className="ft num">{eetClock(item.at)}</span>
                <span className={`fi fi-${item.type}`}>{FEED_ICON[item.type] ?? 'i'}</span>
                <span className="fx">{item.text}</span>
              </div>
            ))}
            {feed.length === 0 && (
              <div className="dim" style={{ fontSize: 12 }}>
                No audit events yet.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mticker">
        {feed[0] ? (
          <>
            <span className="live">
              <i className="dot" style={{ width: 6, height: 6 }} />
              LIVE
            </span>
            <span className={`fi fi-${feed[0].type}`}>{FEED_ICON[feed[0].type] ?? 'i'}</span>
            <span className="fx">{feed[0].text}</span>
          </>
        ) : (
          <span className="dim">Waiting for the first audit event…</span>
        )}
      </div>
    </section>
  );
}
