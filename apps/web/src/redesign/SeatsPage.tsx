import type { DashboardState } from '../types';
import type { SettingsView } from './model';
import { headerModel, numberRisk, positionTimeLeftLabel, positionsModel, seatsModel } from './model';
import { useNow } from './useRemote';
import {
  ageLabel,
  avatarColor,
  avatarLetter,
  bpsPct,
  durationLabel,
  eetClock,
  eetShort,
  humanReason,
  pct,
  signedUsdFromMicro,
  usdFromMicro,
} from './format';

export function SeatsPage({
  state,
  settings,
  onSelectSeat,
}: {
  state: DashboardState;
  settings: SettingsView | null;
  onSelectSeat: (activationId: string) => void;
}) {
  const h = headerModel(state, settings);
  const now = useNow();
  const seats = seatsModel(state);
  const positions = positionsModel(state, settings, now);
  const idleFireHours = numberRisk(settings?.risk ?? {}, 'IDLE_FIRE_HOURS', 8);
  const fills = state.activity.filter((row) => row.kind !== 'skipped').slice(0, 8);
  const skips = state.activity.filter((row) => row.kind === 'skipped').slice(0, 8);
  const fees = state.counters.feesPaidUsdMicro;
  const rent = state.counters.rentUsdMicro;

  return (
    <section className="view on" id="v-seats" data-testid="desk-seats">
      <div className="toolbar">
        <div>
          <h2 className="title">Seats &amp; positions</h2>
          <div className="sub">
            {seats.length} hired leaders, copied in paper mode. A seat is fired after two losing closes in a
            row or {idleFireHours}h without a funded buy.
          </div>
        </div>
      </div>

      <div className="g wallet">
        <div className="panel wtile">
          <div className="ph">
            <h3>USDC available for trading</h3>
            <span className="pill r">free cash</span>
          </div>
          <div className="big num">{usdFromMicro(h.usdcFree)}</div>
          <div className="dbar">
            <span
              style={{
                width: `${h.usdcFree + h.deployed > 0n ? Number((h.deployed * 100n) / (h.usdcFree + h.deployed)) : 0}%`,
                background: 'linear-gradient(90deg,#7c6cff,#a197ff)',
              }}
            />
            <i className="mk" style={{ left: '80%', background: '#fbbf24' }}>
              <em style={{ color: '#fde68a' }}>80% max deployed</em>
            </i>
          </div>
          <div className="row">
            <span>Deployed in {h.openCount} positions</span>
            <b className="num">{usdFromMicro(h.deployed)}</b>
          </div>
          <div className="row">
            <span>Headroom to the deployed cap</span>
            <b className="num">{usdFromMicro(h.room)}</b>
          </div>
          <div className="src">
            Source: the runtime's bankroll headroom and the last sampled wallet USDC balance. Paper mode never
            signs.
          </div>
        </div>

        <div className="panel wtile">
          <div className="ph">
            <h3>Returns</h3>
            <span className="pill r">today</span>
          </div>
          <div className={`big num ${h.unrealized >= 0n ? 'pos' : 'neg'}`}>
            {signedUsdFromMicro(h.unrealized)}{' '}
            <span style={{ fontSize: 15, fontWeight: 600 }}>
              {h.unrealPct === null ? '—' : pct(h.unrealPct)}
            </span>
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
            unrealised across {h.openCount} open positions
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <span>Realised today</span>
            <b className={`num ${h.realized >= 0n ? 'pos' : 'neg'}`}>{signedUsdFromMicro(h.realized)}</b>
          </div>
          <div className="row">
            <span>Total today</span>
            <b className={`num ${h.today >= 0n ? 'pos' : 'neg'}`}>{signedUsdFromMicro(h.today)}</b>
          </div>
          <div className="src">
            Unrealised uses the marks the server already holds. Realised is the fill ledger. No figure is
            inferred in the browser.
          </div>
        </div>

        <div className="panel wtile wsol" data-testid="sol-headline">
          <div className="ph">
            <h3>SOL balance</h3>
            <span className="pill r">{solLabel(h.solBalance)}</span>
          </div>
          <div className="big num">{h.solBalance ?? '—'} SOL</div>
          <div className="dim num" style={{ fontSize: 13, marginTop: 2 }}>
            {h.solUsdMicro ? `≈ ${usdFromMicro(h.solUsdMicro)}` : 'no USD price'} · wallet balance for fees
            and rent
          </div>
          <div className="dbar">
            <span
              style={{
                width: `${Math.min(100, Number(h.solBalance ?? 0) * 200)}%`,
                background:
                  solLabel(h.solBalance) === 'Healthy'
                    ? '#34d399'
                    : solLabel(h.solBalance) === 'Low'
                      ? '#fbbf24'
                      : '#f87171',
              }}
            />
            <i className="mk" style={{ left: '10%', background: '#f87171' }}>
              <em style={{ color: '#fca5a5' }}>0.05 low</em>
            </i>
          </div>
          <div className="row">
            <span>Fees paid (ledger)</span>
            <b className="num">{fees ? usdFromMicro(fees) : 'pending scan'}</b>
          </div>
          <div className="row">
            <span>Rent locked</span>
            <b className="num">{rent ? usdFromMicro(rent) : 'pending scan'}</b>
          </div>
          <div className="src">
            Balance from the fee-wallet sampler; fees and rent from the chain-priced fee ledger.{' '}
            {h.rentLamports !== null ? `${(h.rentLamports / 1e9).toFixed(4)} SOL refundable.` : ''}
          </div>
        </div>
      </div>

      <div className="g g5" style={{ marginTop: 14 }}>
        {seats.map((seat, index) => {
          if (!seat) {
            return (
              <div className="panel seat" key={`empty-${index}`}>
                <div className="sn">SEAT {index + 1}</div>
                <div className="seat-slot open" style={{ marginTop: 12 }}>
                  Seat open
                  <br />
                  <span style={{ fontSize: 11, color: 'var(--tx2)' }}>promotion queue deciding</span>
                </div>
              </div>
            );
          }
          const total = seat.totalUsdMicro;
          const idlePct =
            seat.idleFireHoursLeft === null
              ? 100
              : Math.max(0, Math.min(100, (1 - seat.idleFireHoursLeft / idleFireHours) * 100));
          const atRisk =
            seat.streak >= seat.fireAfter ||
            (seat.idleFireHoursLeft !== null && seat.idleFireHoursLeft <= 1.5);
          return (
            <div
              className="panel seat clickable"
              key={seat.activationId}
              data-testid={`seat-card-${seat.seatIndex}`}
              onClick={() => onSelectSeat(seat.activationId)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectSeat(seat.activationId);
              }}
            >
              {atRisk && <span className="pill am firerisk">fire risk</span>}
              <div className="sn">SEAT {seat.seatIndex}</div>
              <div className="c-h" style={{ marginTop: 10 }}>
                <span className="ava" style={{ background: avatarColor(seat.handle) }}>
                  {avatarLetter(seat.handle)}
                </span>
                <div className="c-id">
                  <div className="c-handle">@{seat.handle.replace(/^@/, '')}</div>
                  <div className="c-wal">since {eetShort(seat.sinceIso)}</div>
                </div>
              </div>
              <div className={`big num ${total >= 0n ? 'pos' : 'neg'}`}>{signedUsdFromMicro(total)}</div>
              <div style={{ fontSize: 12, color: 'var(--tx2)' }} className="num">
                Realised {signedUsdFromMicro(seat.realizedUsdMicro)} · Unreal.{' '}
                {signedUsdFromMicro(seat.unrealizedUsdMicro)}
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  marginTop: 10,
                  fontSize: 12,
                  color: 'var(--tx2)',
                }}
              >
                <i className="dot" style={{ width: 7, height: 7 }} />
                signal {ageLabel(seat.lastSignalAt, now)}
                <span style={{ marginLeft: 'auto' }}>{seat.openPositions} open</span>
              </div>
              <div className="risk">
                <div className="rr">
                  <span className="lbl">Loss streak</span>
                  <div className="pips">
                    <i className={seat.streak >= 1 ? 'on' : ''} />
                    <i className={seat.streak >= 2 ? 'on' : ''} />
                  </div>
                  <span className="val num">
                    {seat.streak}/{seat.fireAfter}
                  </span>
                </div>
                <div className="rr">
                  <span className="lbl">Idle timer</span>
                  <div className="bar">
                    <span
                      style={{
                        width: `${idlePct}%`,
                        background: idlePct > 50 ? 'var(--amber)' : 'linear-gradient(90deg,#60a5fa,#22d3ee)',
                      }}
                    />
                  </div>
                  <span className="val num">
                    {seat.idleFireHoursLeft === null ? 'hold' : `${seat.idleFireHoursLeft.toFixed(1)}h`}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel" style={{ marginTop: 14 }} data-testid="positions-panel">
        <div className="ph">
          <h3>Open positions</h3>
          <span className="dim" style={{ fontSize: 12 }}>
            {positions.length} open · marked from the server's last quote · exits checked every poll · max
            hold {numberRisk(settings?.risk ?? {}, 'MAX_POSITION_AGE_HOURS', 5)}h
          </span>
        </div>
        <div className="tscroll">
          <table className="t">
            <thead>
              <tr>
                <th>Token</th>
                <th>Leader</th>
                <th className="r">Size</th>
                <th className="r">Unrealised</th>
                <th className="r">%</th>
                <th className="r">Age</th>
                <th>Stop</th>
                <th>Trail</th>
                <th>Take-profit</th>
                <th className="r">Time left</th>
                <th>Exit plan</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.positionId}>
                  <td>
                    <span className="tok">
                      <i style={{ background: avatarColor(position.symbol) }} />
                      {position.symbol}
                    </span>
                  </td>
                  <td className="muted">@{position.leaderHandle.replace(/^@/, '')}</td>
                  <td className="r num">{usdFromMicro(position.copyUsdMicro)}</td>
                  <td
                    className={`r num ${position.unrealizedUsdMicro === null || position.unrealizedUsdMicro >= 0n ? 'pos' : 'neg'}`}
                  >
                    {position.unrealizedUsdMicro === null
                      ? '—'
                      : signedUsdFromMicro(position.unrealizedUsdMicro)}
                  </td>
                  <td className={`r num ${(position.unrealizedPct ?? 0) >= 0 ? 'pos' : 'neg'}`}>
                    {position.unrealizedPct === null ? '—' : pct(position.unrealizedPct)}
                  </td>
                  <td className="r num">{ageLabel(position.openedIso, now)}</td>
                  <td className="num">−{bpsPct(position.stopBps)}</td>
                  <td className="num">
                    arm +{bpsPct(position.trailArmBps)} · {bpsPct(position.trailDistanceBps)} off
                  </td>
                  <td className="num">50% @ +{bpsPct(position.takeProfitBps)}</td>
                  <td className={`r num ${position.timeLeftMs < 0 ? 'amb' : ''}`}>
                    {positionTimeLeftLabel(position, durationLabel)}
                  </td>
                  <td>
                    {position.planSource === 'copytrader' ? (
                      <span className="pill agentpill" style={{ fontSize: 10.5 }}>
                        ◆ tightened by Copytrader
                      </span>
                    ) : (
                      <span className="dim">code default</span>
                    )}
                    {position.status === 'requires_reconciliation' && (
                      <span className="pill rd" style={{ marginLeft: 6 }}>
                        reconciling
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {positions.length === 0 && (
                <tr>
                  <td colSpan={11} className="dim" style={{ padding: 16 }}>
                    No open positions. The desk opens one when a hired leader makes a funded buy.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="g g2" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="ph">
            <h3>Recent fills</h3>
            <span className="r dim" style={{ fontSize: 12 }}>
              paper · from the runtime tape
            </span>
          </div>
          <div className="tscroll">
            <table className="t">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Leader</th>
                  <th>Token</th>
                  <th className="r">Size</th>
                  <th className="r">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {fills.map((fill) => (
                  <tr key={fill.id}>
                    <td className="num dim">{eetClock(fill.tIso)}</td>
                    <td>
                      <span className={`pill ${fill.kind === 'copied' ? 'ex' : 'rd'}`}>
                        {fill.kind === 'copied' ? 'BUY' : 'SELL'}
                      </span>
                    </td>
                    <td className="muted">@{fill.leaderHandle?.replace(/^@/, '') ?? '—'}</td>
                    <td>{fill.tokenShort ?? '—'}</td>
                    <td className="r num">
                      {fill.copyUsdMicro
                        ? usdFromMicro(fill.copyUsdMicro)
                        : fill.leaderUsdMicro
                          ? usdFromMicro(fill.leaderUsdMicro)
                          : '—'}
                    </td>
                    <td
                      className={`r num ${fill.realizedPnlUsdMicro ? (BigInt(fill.realizedPnlUsdMicro) >= 0n ? 'pos' : 'neg') : 'dim'}`}
                    >
                      {fill.realizedPnlUsdMicro ? signedUsdFromMicro(fill.realizedPnlUsdMicro) : '—'}
                    </td>
                  </tr>
                ))}
                {fills.length === 0 && (
                  <tr>
                    <td colSpan={6} className="dim" style={{ padding: 16 }}>
                      No fills in the activity window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            <h3>Skipped copies</h3>
            <span className="r dim" style={{ fontSize: 12 }}>
              with reasons
            </span>
          </div>
          <div className="tscroll">
            <table className="t">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Leader</th>
                  <th>Token</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {skips.map((skip) => (
                  <tr key={skip.id}>
                    <td className="num dim">{eetClock(skip.tIso)}</td>
                    <td className="muted">@{skip.leaderHandle?.replace(/^@/, '') ?? '—'}</td>
                    <td>{skip.tokenShort ?? '—'}</td>
                    <td className="muted">{skip.reasonChip ?? 'not copied'}</td>
                  </tr>
                ))}
                {skips.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dim" style={{ padding: 16 }}>
                      No skipped copies in the activity window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="ph">
          <h3>Fired lane</h3>
          <span className="r dim" style={{ fontSize: 12 }}>
            the last five firings · replacement status
          </span>
        </div>
        <div className="tscroll">
          <table className="t">
            <thead>
              <tr>
                <th>Fired</th>
                <th>Reason</th>
                <th>At</th>
                <th>Replacement</th>
              </tr>
            </thead>
            <tbody>
              {state.pipeline.exits.recent.map((fire) => (
                <tr key={`${fire.candidateId}-${fire.firedAt}`}>
                  <td>
                    <b>@{fire.handle.replace(/^@/, '')}</b>
                  </td>
                  <td className="muted">{humanReason(fire.reason)}</td>
                  <td className="num dim">{eetShort(fire.firedAt)}</td>
                  <td>
                    {fire.replacedBy ? (
                      `@${fire.replacedBy.replace(/^@/, '')}`
                    ) : (
                      <span className="dim">seat left empty</span>
                    )}
                  </td>
                </tr>
              ))}
              {state.pipeline.exits.recent.length === 0 && (
                <tr>
                  <td colSpan={4} className="dim" style={{ padding: 16 }}>
                    No firings recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function solLabel(balance: string | null): 'Healthy' | 'Low' | 'Critical' | 'Unsampled' {
  if (balance === null) return 'Unsampled';
  const value = Number(balance);
  if (!Number.isFinite(value)) return 'Unsampled';
  return value < 0.02 ? 'Critical' : value < 0.05 ? 'Low' : 'Healthy';
}
