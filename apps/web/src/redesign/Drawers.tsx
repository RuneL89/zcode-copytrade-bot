import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DashboardState } from '../types';
import type { SettingsView } from './model';
import { numberRisk, positionTimeLeftLabel, positionsModel, seatsModel } from './model';
import { useNow } from './useRemote';
import {
  ageLabel,
  avatarColor,
  avatarLetter,
  eetShort,
  humanReason,
  signedUsdFromMicro,
  usdFromMicro,
} from './format';

function DrawerShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  testId,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testId: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim on" onClick={onClose} />
      <aside className="drawer on" aria-label={title} data-testid={testId}>
        <div className="dr-h">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>{title}</div>
            <div className="mono dim" style={{ fontSize: 12 }}>
              {subtitle}
            </div>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="dr-b">{children}</div>
        {footer && <div className="dr-f">{footer}</div>}
      </aside>
    </>
  );
}

export function WatchDrawer({
  state,
  settings,
  candidateId,
  onClose,
}: {
  state: DashboardState;
  settings: SettingsView | null;
  candidateId: string;
  onClose: () => void;
}) {
  const row = state.watchlist.rows.find((item) => item.candidateId === candidateId);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!row) return null;
  const minClosed = numberRisk(settings?.risk ?? {}, 'PROMOTION_MIN_CLOSED', 8);
  const minNet = numberRisk(settings?.risk ?? {}, 'PROMOTION_MIN_NET_USD', 3) * 1_000_000;
  const net = BigInt(row.netShadowPnlUsdMicro);
  const checks = [
    {
      ok: row.closedTrades >= minClosed,
      label: `Closed shadow sample ≥ ${minClosed}`,
      value: String(row.closedTrades),
    },
    {
      ok: net >= BigInt(minNet),
      label: `Net shadow ≥ $${minNet / 1_000_000}`,
      value: signedUsdFromMicro(net),
    },
    {
      ok: Boolean(row.lastFundedBuyAt),
      label: 'Funded buy on record',
      value: row.lastFundedBuyAt ? `${ageLabel(row.lastFundedBuyAt)} ago` : 'never',
    },
    {
      ok: row.status === 'watching' || row.status === 'bench',
      label: 'Watch status can promote',
      value: row.status,
    },
  ];
  const promote = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.watchPromote(row.candidateId);
      setMessage(
        result.ok
          ? `Promotion accepted: ${result.reason === 'HIRED' ? 'hired into a free chair' : 'placed on the bench'}`
          : `Promotion declined: ${humanReason(result.reason)}`,
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    setBusy(true);
    try {
      await api.watchArchive(row.candidateId);
      setMessage('Archived from the watch list.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unarchive = async () => {
    setBusy(true);
    try {
      await api.watchUnarchive(row.candidateId);
      setMessage('Back on the watch list.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DrawerShell
      title={`@${row.handle.replace(/^@/, '')}`}
      subtitle={`${row.candidateId} · ${row.status} · shadow record`}
      onClose={onClose}
      testId="watch-drawer"
      footer={
        <>
          {row.status === 'archived' ? (
            <button
              className="btn good"
              onClick={() => void unarchive()}
              disabled={busy}
              data-testid="watch-unarchive"
            >
              Unarchive
            </button>
          ) : (
            <button
              className="btn danger"
              onClick={() => void archive()}
              disabled={busy}
              data-testid="watch-archive"
            >
              Archive
            </button>
          )}
          <button
            className="btn pri"
            onClick={() => void promote()}
            disabled={busy || row.status === 'hired' || Boolean(row.blockedReason)}
            title={row.blockedReason ?? undefined}
            data-testid="watch-promote"
          >
            {busy ? 'Working…' : 'Promote now'}
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="sec">
        <h4>Shadow ledger</h4>
        <div className="grid4">
          <div className="tile">
            <div className="k">Closed</div>
            <div className="v num">{row.closedTrades}</div>
          </div>
          <div className="tile">
            <div className="k">Net</div>
            <div className={`v num ${net >= 0n ? 'pos' : 'neg'}`}>{signedUsdFromMicro(net)}</div>
          </div>
          <div className="tile">
            <div className="k">Open notional</div>
            <div className="v num">{usdFromMicro(row.openNotionalUsdMicro)}</div>
          </div>
          <div className="tile">
            <div className="k">Buys 24h</div>
            <div className="v num">{row.fundedBuys24h}</div>
          </div>
          <div className="tile">
            <div className="k">Sells 24h</div>
            <div className="v num">{row.fundedSells24h}</div>
          </div>
          <div className="tile">
            <div className="k">Last buy</div>
            <div className="v num">{row.lastFundedBuyAt ? ageLabel(row.lastFundedBuyAt) : '—'}</div>
          </div>
          <div className="tile">
            <div className="k">Ceiling exposure</div>
            <div className="v num">{usdFromMicro(row.ceilingExposureUsdMicro)}</div>
          </div>
          <div className="tile">
            <div className="k">Last event</div>
            <div className="v num">{row.lastEventAt ? ageLabel(row.lastEventAt) : '—'}</div>
          </div>
        </div>
      </div>

      <div className="sec">
        <h4>Code gate</h4>
        {checks.map((check) => (
          <div className="chk" key={check.label}>
            <span className={`ic ${check.ok ? 'p' : 'f'}`}>{check.ok ? '✓' : '✕'}</span>
            {check.label}
            <span className="val num">{check.value}</span>
          </div>
        ))}
        {row.blockedReason && (
          <div className="note" style={{ marginTop: 8 }}>
            <div className="who">◆ Promotion gate</div>
            {humanReason(row.blockedReason)}
          </div>
        )}
      </div>

      {(row.reason || row.status === 'cooling') && (
        <div className="sec">
          <h4>Watch note</h4>
          <div className="dim" style={{ fontSize: 12.5 }}>
            {humanReason(row.reason ?? 'cooling after a firing')}
          </div>
        </div>
      )}

      {message && (
        <div className="note" style={{ marginTop: 14 }} role="alert">
          <div className="who">◆ Result</div>
          {message}
        </div>
      )}

      <div className="sec">
        <h4>Hiring rule</h4>
        <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.5 }}>
          Promotion is a code gate, not an agent review (the agent review pipeline is retired, D6). A free
          chair seats a qualifying wallet immediately; otherwise it waits on the bench in net order. This
          button cannot weaken the gate — the server refuses and returns the reason.
        </div>
      </div>
    </DrawerShell>
  );
}

export function SeatDrawer({
  state,
  settings,
  activationId,
  onClose,
}: {
  state: DashboardState;
  settings: SettingsView | null;
  activationId: string;
  onClose: () => void;
}) {
  const seat = seatsModel(state).find((item) => item?.activationId === activationId);
  const [confirmFire, setConfirmFire] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const now = useNow();
  if (!seat) return null;
  const positions = positionsModel(state, settings, now).filter(
    (position) => position.leaderHandle === seat.handle,
  );
  const closes = state.closes.filter((close) => close.traderHandle === seat.handle).slice(0, 10);
  const activity = state.activity.filter((row) => row.leaderHandle === seat.handle).slice(0, 8);
  const idleFireHours = numberRisk(settings?.risk ?? {}, 'IDLE_FIRE_HOURS', 8);

  const fire = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.fire(seat.activationId);
      setMessage('Fire accepted. The chair is free; the promotion queue may fill it on the next watch tick.');
      setConfirmFire(false);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DrawerShell
      title={`@${seat.handle.replace(/^@/, '')}`}
      subtitle={`seat ${seat.seatIndex} · ${seat.status} · since ${eetShort(seat.sinceIso)}`}
      onClose={onClose}
      testId="seat-drawer"
      footer={
        <>
          <button
            className="btn danger"
            onClick={() => setConfirmFire(true)}
            disabled={busy}
            data-testid="seat-fire"
          >
            Fire seat…
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="sec">
        <h4>Seat performance</h4>
        <div className="grid4">
          <div className="tile">
            <div className="k">Realised</div>
            <div className={`v num ${seat.realizedUsdMicro >= 0n ? 'pos' : 'neg'}`}>
              {signedUsdFromMicro(seat.realizedUsdMicro)}
            </div>
          </div>
          <div className="tile">
            <div className="k">Unrealised</div>
            <div className={`v num ${seat.unrealizedUsdMicro >= 0n ? 'pos' : 'neg'}`}>
              {signedUsdFromMicro(seat.unrealizedUsdMicro)}
            </div>
          </div>
          <div className="tile">
            <div className="k">Open</div>
            <div className="v num">{seat.openPositions}</div>
          </div>
          <div className="tile">
            <div className="k">Loss streak</div>
            <div className="v num">
              {seat.streak}/{seat.fireAfter}
            </div>
          </div>
          <div className="tile">
            <div className="k">Last signal</div>
            <div className="v num">{ageLabel(seat.lastSignalAt, now)}</div>
          </div>
          <div className="tile">
            <div className="k">Idle clock</div>
            <div className="v num">
              {seat.idleFireHoursLeft === null
                ? 'holding'
                : `${seat.idleFireHoursLeft.toFixed(1)}/${idleFireHours}h`}
            </div>
          </div>
          <div className="tile">
            <div className="k">Chair</div>
            <div className="v num">S{seat.seatIndex}</div>
          </div>
          <div className="tile">
            <div className="k">Replaces</div>
            <div className="v num">{seat.replaces ?? '—'}</div>
          </div>
        </div>
      </div>

      <div className="sec">
        <h4>Open positions · {positions.length}</h4>
        {positions.length === 0 && (
          <div className="dim" style={{ fontSize: 12 }}>
            No open positions for this seat.
          </div>
        )}
        <div className="tvl">
          {positions.map((position) => (
            <div className="tvr open" key={position.positionId}>
              <div className="tv1">
                <span className="tok">
                  <i style={{ background: avatarColor(position.symbol) }} />
                  {position.symbol}
                </span>
                <span className="dim num">{ageLabel(position.openedIso, now)}</span>
                <span className="tvx info">open</span>
                <b className={`num ${(position.unrealizedUsdMicro ?? 0n) >= 0n ? 'pos' : 'neg'}`}>
                  {position.unrealizedUsdMicro === null
                    ? 'mark pending'
                    : signedUsdFromMicro(position.unrealizedUsdMicro)}
                </b>
              </div>
              <div className="tv2 num">
                <span>
                  size <b>{usdFromMicro(position.copyUsdMicro)}</b>
                </span>
                <span>
                  stop <b>−{position.stopBps / 100}%</b>
                </span>
                <span>
                  time left <b>{positionTimeLeftLabel(position)}</b>
                </span>
                <span>
                  {position.planSource === 'copytrader' ? '◆ tightened by Copytrader' : 'code default plan'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sec">
        <h4>Recent closed trades · {closes.length}</h4>
        {closes.length === 0 && (
          <div className="dim" style={{ fontSize: 12 }}>
            No closed trades for this tenure yet.
          </div>
        )}
        <div className="tvl">
          {closes.map((close) => (
            <div className="tvr" key={close.id}>
              <div className="tv1">
                <span className="dim num">{eetShort(close.t)}</span>
                <span>{close.symbol ?? '—'}</span>
                <b className={`num ${BigInt(close.pnlUsdMicro) >= 0n ? 'pos' : 'neg'}`}>
                  {signedUsdFromMicro(close.pnlUsdMicro)}
                </b>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sec">
        <h4>Recent leader events</h4>
        {activity.length === 0 && (
          <div className="dim" style={{ fontSize: 12 }}>
            No events in the activity window.
          </div>
        )}
        <div className="tvl">
          {activity.map((event) => (
            <div className="tvr" key={event.id}>
              <div className="tv1">
                <span className="dim num">{eetShort(event.tIso)}</span>
                <span className="tvx info">{event.kind.replace('_', ' ')}</span>
                <span>{event.tokenShort ?? '—'}</span>
                <b className="num">
                  {event.copyUsdMicro
                    ? usdFromMicro(event.copyUsdMicro)
                    : event.leaderUsdMicro
                      ? usdFromMicro(event.leaderUsdMicro)
                      : '—'}
                </b>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirmFire && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          Fire this seat? New entries stop immediately and the chair is left empty (or refilled from the
          promotion queue). Existing positions follow the firing policy.
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn danger" onClick={() => void fire()} disabled={busy}>
              {busy ? 'Firing…' : 'Confirm fire'}
            </button>
            <button className="btn ghost" onClick={() => setConfirmFire(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className="note" style={{ marginTop: 14 }}>
          <div className="who">◆ Result</div>
          {message}
        </div>
      )}
    </DrawerShell>
  );
}

export function FireSeatModal({ state, onClose }: { state: DashboardState; onClose: () => void }) {
  const seats = seatsModel(state).filter(Boolean);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fire = async (activationId: string) => {
    setBusy(activationId);
    try {
      await api.fire(activationId);
      setMessage('Fire accepted. The chair is free; the promotion queue may fill it on the next watch tick.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="modal on" role="dialog" aria-modal="true" data-testid="fire-modal">
      <div className="mbox">
        <h3>Fire a seat</h3>
        <div className="sub">
          The active seat fires immediately; the promotion queue decides the replacement.
        </div>
        <div className="diff">
          {seats.map((seat) => (
            <div key={seat!.activationId} style={{ alignItems: 'center' }}>
              <span>
                <b>
                  S{seat!.seatIndex} @{seat!.handle.replace(/^@/, '')}
                </b>
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <b className={`num ${seat!.totalUsdMicro >= 0n ? 'pos' : 'neg'}`}>
                  {signedUsdFromMicro(seat!.totalUsdMicro)}
                </b>
                <button
                  className="btn danger"
                  onClick={() => void fire(seat!.activationId)}
                  disabled={busy !== null}
                >
                  {busy === seat!.activationId ? 'Firing…' : 'Fire'}
                </button>
              </span>
            </div>
          ))}
          {seats.length === 0 && (
            <div className="dim" style={{ padding: 10 }}>
              No hired seats.
            </div>
          )}
        </div>
        {message && <div className="note">{message}</div>}
        <div className="mact">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
