import type { DashboardState } from '../types';
import type { SettingsView } from './model';
import { numberRisk, seatsModel } from './model';
import {
  ageLabel,
  avatarColor,
  avatarLetter,
  eetShort,
  humanReason,
  signedUsdFromMicro,
  usdFromMicro,
} from './format';
import { Sparkline } from './Charts';

function healthClass(total: bigint, streak: number, fireAfter: number, idleLeft: number | null): string {
  if (streak >= fireAfter || total < -10_000_000n) return 'h-r';
  if (streak > 0 || total < 0n || (idleLeft !== null && idleLeft <= 2)) return 'h-a';
  return 'h-g';
}

export function Arena({
  state,
  settings,
  onSelectSeat,
}: {
  state: DashboardState;
  settings: SettingsView | null;
  onSelectSeat: (activationId: string) => void;
}) {
  const seats = seatsModel(state);
  const idleFireHours = numberRisk(settings?.risk ?? {}, 'IDLE_FIRE_HOURS', 8);
  const hired = seats.filter(Boolean);
  const healthy = hired.filter(
    (seat) =>
      healthClass(seat!.totalUsdMicro, seat!.streak, seat!.fireAfter, seat!.idleFireHoursLeft) === 'h-g',
  ).length;
  const watch = hired.filter(
    (seat) =>
      healthClass(seat!.totalUsdMicro, seat!.streak, seat!.fireAfter, seat!.idleFireHoursLeft) === 'h-a',
  ).length;
  const risk = hired.filter(
    (seat) =>
      healthClass(seat!.totalUsdMicro, seat!.streak, seat!.fireAfter, seat!.idleFireHoursLeft) === 'h-r',
  ).length;

  return (
    <>
      <div className="ph">
        <h3>Arena · {seats.length} seats</h3>
        <span className="dim" style={{ fontSize: 12 }}>
          live paper P&amp;L since hire
        </span>
        <span className="r" id="arenaHealth" data-testid="arena-health">
          <span className="pill ex">{healthy} healthy</span> <span className="pill am">{watch} watch</span>{' '}
          <span className="pill rd">{risk} at risk</span>
        </span>
      </div>
      <div id="seatsA">
        {seats.map((seat, index) => {
          if (!seat) {
            return (
              <div className="aseat open" key={`empty-${index}`} data-testid={`seat-${index + 1}`}>
                <div className="sno">S{index + 1}</div>
                <div className="pend dim">Seat open · the promotion queue fills it on the watch tick</div>
              </div>
            );
          }
          const total = seat.totalUsdMicro;
          const idleLeft = seat.idleFireHoursLeft;
          const idlePct =
            idleLeft === null ? 100 : Math.max(0, Math.min(100, (1 - idleLeft / idleFireHours) * 100));
          const health = healthClass(total, seat.streak, seat.fireAfter, idleLeft);
          return (
            <div
              className={`aseat ${health}`}
              key={seat.activationId}
              data-testid={`seat-${seat.seatIndex}`}
              onClick={() => onSelectSeat(seat.activationId)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectSeat(seat.activationId);
              }}
            >
              <div className="sno">S{seat.seatIndex}</div>
              <div className="sid">
                <span className="ava" style={{ background: avatarColor(seat.handle) }}>
                  {avatarLetter(seat.handle)}
                </span>
                <div className="sidt">
                  <div className="c-handle">@{seat.handle.replace(/^@/, '')}</div>
                  <div className="c-wal">since {eetShort(seat.sinceIso)}</div>
                </div>
              </div>
              <div className="spnl">
                <div className={`pnl num ${total >= 0n ? 'pos' : 'neg'}`}>{signedUsdFromMicro(total)}</div>
                <div className="ssub num">
                  streak {seat.streak}/{seat.fireAfter} · {seat.openPositions} open
                </div>
              </div>
              <Sparkline values={seat.series} />
              <div className="smet">
                <div className="mrow">
                  <span>streak</span>
                  <div className="pips">
                    <i className={seat.streak >= 1 ? 'on' : ''} />
                    <i className={seat.streak >= 2 ? 'on' : ''} />
                  </div>
                </div>
                <div className="mrow">
                  <span>idle</span>
                  <div
                    className="bar"
                    title={
                      idleLeft === null
                        ? 'holding a position; the idle clock is stopped'
                        : `${idleLeft.toFixed(1)}h until the idle fire`
                    }
                  >
                    <span
                      style={{
                        width: `${idlePct}%`,
                        background: idlePct > 50 ? 'var(--amber)' : 'linear-gradient(90deg,#60a5fa,#22d3ee)',
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="slat">
                <span className="lat num" title="newest observed leader signal">
                  {ageLabel(seat.lastSignalAt)}
                </span>
                <span className="ssub">{idleLeft === null ? 'holding' : `${idleLeft.toFixed(1)}h left`}</span>
              </div>
              {seat.replaces && <span className="repl">REPLACES {seat.replaces}</span>}
            </div>
          );
        })}
      </div>
      <CoolingTray state={state} />
    </>
  );
}

function CoolingTray({ state }: { state: DashboardState }) {
  const cooling = state.watchlist.rows.filter((row) => row.status === 'cooling').slice(0, 4);
  return (
    <div className="cooltray">
      <span className="lb">Cooling ▸</span>
      <span className="ctarget" />
      {cooling.length === 0 && (
        <span className="dim" style={{ fontSize: 11.5 }}>
          No cooling wallets
        </span>
      )}
      {cooling.map((row) => (
        <span className="cchip" key={row.candidateId} title={row.reason ?? undefined}>
          <span className="ava" style={{ background: avatarColor(row.handle) }}>
            {avatarLetter(row.handle)}
          </span>
          @{row.handle.replace(/^@/, '')}{' '}
          <span style={{ color: '#fca5a5' }}>{humanReason(row.reason ?? 'cooling')}</span>
        </span>
      ))}
    </div>
  );
}

export function SeatSummary({ state }: { state: DashboardState }) {
  const seats = seatsModel(state).filter(Boolean);
  const total = seats.reduce((acc, seat) => acc + seat!.totalUsdMicro, 0n);
  const realized = seats.reduce((acc, seat) => acc + seat!.realizedUsdMicro, 0n);
  return (
    <span className="num dim" style={{ fontSize: 12 }}>
      {seats.length} hired · total {signedUsdFromMicro(total)} · realised {usdFromMicro(realized)}
    </span>
  );
}
