import type { DashboardState } from '../types';
import { timeAgo, usd } from '../types';

type PipelineSeat = DashboardState['pipeline']['roster'][number];
type BoardSeat = DashboardState['roster'][number];

const STATUS_STYLE: Record<PipelineSeat['status'], string> = {
  BUYING: 'bg-posdim text-pos border-posborder',
  SELLING: 'bg-warndim text-warn border-warnborder',
  IDLE: 'bg-inset text-muted border-insetborder',
  RECONCILING: 'bg-negdim text-neg border-negborder',
};

function initials(handle: string): string {
  return handle.slice(0, 2).toUpperCase();
}

/** Hours (one decimal) to a compact "6h 12m" label. */
function idleLabel(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const lastSixClass = (mark: 'W' | 'L' | 'B') =>
  mark === 'W' ? 'text-pos' : mark === 'L' ? 'text-neg' : 'text-faint';

/**
 * One roster chair (plan 07, AC4/AC9). The whole seat is a button whose
 * accessible name carries the seat's figures; the visual layer is
 * `aria-hidden` and the FIRE action is a sibling button, so both are reachable
 * by keyboard. An empty seat keeps the dashed "open seat" state — an accepted
 * outcome (D4).
 */
export function RosterSeat({
  seat,
  board,
  busy,
  selected,
  onSelect,
  onFire,
}: {
  seat: PipelineSeat | null;
  board: BoardSeat | null;
  busy: boolean;
  selected: boolean;
  onSelect: (activationId: string) => void;
  onFire: (activationId: string, handle: string) => void;
}) {
  if (!seat) {
    return (
      <li
        data-testid="roster-empty-seat"
        className="rounded-[12px] border border-dashed border-insetborder p-3 flex items-center min-h-[112px]"
      >
        <p className="text-[11px] text-faint leading-snug">Open seat — fills from the promotion queue.</p>
      </li>
    );
  }

  const realized = board?.realizedPnlUsdMicro ?? seat.realizedPnlUsdMicro;
  const unrealized = board?.unrealizedPnlUsdMicro ?? seat.unrealizedPnlUsdMicro;
  const active = board?.status === 'ACTIVE';
  const signal = seat.lastSignalAt ? `last signal ${timeAgo(seat.lastSignalAt)}` : 'no signal yet';
  // The idle clock only runs while the seat is flat: holding a position pauses
  // it, and the label says so instead of hiding the mechanic.
  const idle =
    seat.openPositions > 0
      ? `idle clock paused · ${seat.openPositions} open`
      : seat.idleFireHoursLeft === null
        ? null
        : seat.idleFireHoursLeft <= 0
          ? 'idle fire now'
          : `idle fire in ${idleLabel(seat.idleFireHoursLeft)}`;
  const aria =
    `@${seat.handle}, ${seat.status}, realized ${usd(realized)}, ` +
    `unrealized ${usd(unrealized)}, ${seat.openPositions} open position(s), ${signal}` +
    (idle ? `, ${idle}` : '');

  return (
    <li
      data-testid={`roster-seat-${seat.activationId}`}
      className={`relative rounded-[12px] border p-3 flex flex-col gap-2 ${
        selected ? 'border-accentborder bg-accentdim' : 'border-insetborder'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(seat.activationId)}
        aria-label={aria}
        aria-pressed={selected}
        data-testid={`roster-chair-${seat.activationId}`}
        className="absolute inset-0 w-full h-full rounded-[12px] cursor-pointer"
      />
      <div className="relative pointer-events-none" aria-hidden="true">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 shrink-0 rounded-full bg-accentdim border border-accentborder text-accent mono text-[10px] font-bold flex items-center justify-center">
            {initials(seat.handle)}
          </span>
          <span className="text-[13px] font-semibold truncate">@{seat.handle}</span>
          <span className="ml-auto flex items-center gap-1 shrink-0">
            {(board?.lastSix ?? []).map((m, i) => (
              <span key={i} className={`label !text-[10px] font-bold ${lastSixClass(m)}`}>
                {m}
              </span>
            ))}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          <span
            className={`chip tag border ${STATUS_STYLE[seat.status]}`}
            data-testid={`seat-status-${seat.activationId}`}
          >
            {seat.status}
          </span>
          {board && (
            <span className="chip tag border border-insetborder bg-inset text-muted">{board.status}</span>
          )}
          <span className="label !text-[10px] !text-faint ml-auto">
            {seat.lastSignalAt ? `signal ${timeAgo(seat.lastSignalAt)}` : 'signal —'}
          </span>
        </div>

        {idle && (
          <p
            className={`label !text-[10px] mt-1.5 ${
              seat.openPositions === 0 && (seat.idleFireHoursLeft ?? 99) <= 2
                ? '!text-warn font-semibold'
                : '!text-faint'
            }`}
            data-testid={`idle-fire-${seat.activationId}`}
          >
            {idle}
          </p>
        )}

        <div className="grid grid-cols-3 gap-2 mt-2 text-[10.5px]">
          <div>
            <p className="label !text-[10px]">REALIZED</p>
            <p className={`money ${BigInt(realized) < 0n ? 'text-neg' : ''}`}>{usd(realized)}</p>
          </div>
          <div>
            <p className="label !text-[10px]">UNREALIZED</p>
            <p className={`money ${BigInt(unrealized) < 0n ? 'text-neg' : ''}`}>{usd(unrealized)}</p>
          </div>
          <div>
            <p className="label !text-[10px]">OPEN</p>
            <p className="money">{seat.openPositions}</p>
          </div>
        </div>
      </div>

      <div className="relative flex items-center gap-2 mt-auto">
        <p className="label !text-[10px] !text-faint">
          STREAK {board?.streak ?? 0}/{board?.fireAfter ?? 2}
          {board ? ` · SINCE ${board.sinceIso.slice(11, 19)}Z` : ''}
        </p>
        <button
          disabled={busy || !active}
          onClick={() => onFire(seat.activationId, seat.handle)}
          aria-label={`Fire @${seat.handle}`}
          data-testid={`roster-fire-${seat.activationId}`}
          className="ml-auto rounded-[10px] border border-negborder bg-negdim text-neg mono text-[10.5px] font-semibold px-2.5 py-1 disabled:opacity-40 cursor-pointer min-h-[44px] min-[900px]:min-h-[32px]"
        >
          FIRE
        </button>
      </div>
    </li>
  );
}
