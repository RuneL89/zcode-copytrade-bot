import { useEffect, useState } from 'react';
import { api } from '../api';
import { usd } from '../types';
import type { DashboardState } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { RosterSeat, SeatPositionRow } from './RosterSeat';

/**
 * The roster grid (D4/plan 05; five seats per plan 07): ROSTER_SIZE chairs
 * sharing one budget pool. Each seat is one chair — its own cursor, positions
 * and fire rule; an empty seat keeps the dashed state, which is acceptable.
 * A seat expands (collapsed by default) to its open positions, so the roster is
 * the one place positions live. Positions whose chair is gone (fired, close
 * stuck in reconciliation) appear in the unassigned group below the grid.
 * Firing names the chair (the API refuses an ambiguous call when several are
 * active).
 */
export function RosterPanel({ state }: { state: DashboardState }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fireTarget, setFireTarget] = useState<{ activationId: string; handle: string } | null>(null);
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const seats = state.pipeline.roster;
  const size = Math.max(state.counters.rosterSize ?? 0, seats.length);
  const chairs: Array<(typeof seats)[number] | null> = Array.from(
    { length: size },
    (_, i) => seats[i] ?? null,
  );
  const board = (activationId: string) =>
    state.roster.find((row) => row.activationId === activationId) ?? null;
  const selected = selectedSeat ? (seats.find((s) => s.activationId === selectedSeat) ?? null) : null;

  // Positions grouped by the leader handle the builder stamped on them.
  const byHandle = new Map<string, DashboardState['positions']>();
  for (const p of state.positions) {
    const key = p.leaderHandle ?? '';
    const list = byHandle.get(key);
    if (list) list.push(p);
    else byHandle.set(key, [p]);
  }
  const seatHandles = new Set(seats.map((s) => s.handle));
  const unassigned = state.positions.filter(
    (p) => p.leaderHandle === null || !seatHandles.has(p.leaderHandle),
  );
  const maxAgeHours = state.counters.maxPositionAgeHours;
  const graceHours = state.counters.positionGraceHours;

  if (size === 0) {
    return (
      <section className="card p-4 mb-3.5" aria-label="roster" data-testid="roster-panel">
        <p className="label">Roster</p>
        <p className="text-[11.5px] text-muted mt-2" data-testid="roster-empty">
          No leaders hired — promotion fills the chairs from the watch list (an empty chair is fine).
        </p>
      </section>
    );
  }

  return (
    <section className="card p-4 mb-3.5" aria-label="roster" data-testid="roster-panel">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="label">Roster</p>
        <p className="label !text-[10px] !text-faint" data-testid="roster-counts">
          {seats.length}/{size} chair(s) · shared pool · {state.counters.openPositions} open · $
          {usd(state.counters.deployedUsdMicro)} deployed
        </p>
      </div>
      <ul className="mt-3 grid gap-2.5 grid-cols-1 min-[600px]:grid-cols-2 min-[900px]:grid-cols-3 min-[1100px]:grid-cols-5 list-none m-0 p-0">
        {chairs.map((seat, i) => (
          <RosterSeat
            key={seat?.activationId ?? `empty-${i}`}
            seat={seat}
            board={seat ? board(seat.activationId) : null}
            busy={busy !== null}
            selected={selectedSeat !== null && seat?.activationId === selectedSeat}
            positions={seat ? (byHandle.get(seat.handle) ?? []) : []}
            maxAgeHours={maxAgeHours}
            graceHours={graceHours}
            now={now}
            onSelect={(activationId) =>
              setSelectedSeat((cur) => (cur === activationId ? null : activationId))
            }
            onFire={(activationId, handle) => setFireTarget({ activationId, handle })}
          />
        ))}
      </ul>
      {unassigned.length > 0 && (
        <div className="mt-3" data-testid="unassigned-positions">
          <p className="label !text-[10px]">
            Unassigned positions <span className="!text-faint">({unassigned.length})</span>
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {unassigned.map((p) => (
              <SeatPositionRow
                key={p.positionId}
                p={p}
                maxAgeHours={maxAgeHours}
                graceHours={graceHours}
                now={now}
                leaderLabel={p.leaderHandle ?? 'unknown'}
              />
            ))}
          </ul>
        </div>
      )}
      {selected && (
        <div
          className="panel p-3 mt-2.5"
          data-testid="roster-seat-detail"
          role="region"
          aria-label={`@${selected.handle} detail`}
        >
          <p className="label !text-[10px]">@{selected.handle}</p>
          <p className="text-[11.5px] text-muted mt-1">
            {selected.status}
            {board(selected.activationId) ? ` · ${board(selected.activationId)!.status}` : ''} · realized $
            {usd(selected.realizedPnlUsdMicro)} · unrealized ${usd(selected.unrealizedPnlUsdMicro)} ·{' '}
            {selected.openPositions} open · since{' '}
            {board(selected.activationId)?.sinceIso.slice(11, 19) ?? '—'}Z
          </p>
          <p className="label !text-[10px] !text-faint mt-1">
            streak {board(selected.activationId)?.streak ?? 0}/{board(selected.activationId)?.fireAfter ?? 2}{' '}
            ·{' '}
            {selected.lastSignalAt ? `last signal ${selected.lastSignalAt.slice(11, 19)}Z` : 'no signal yet'}{' '}
            · as of {state.pipeline.asOf.slice(11, 19)}Z
          </p>
        </div>
      )}
      {error && (
        <p className="text-[11px] text-neg mt-2" role="alert">
          {error}
        </p>
      )}

      {fireTarget && (
        <ConfirmDialog
          title={`Fire @${fireTarget.handle}?`}
          dangerLabel="FIRE"
          body="Closes this leader's open positions per the fire policy, frees exactly one chair, and the promotion queue fills it."
          requiredWord="FIRE"
          confirmLabel="FIRE"
          busy={busy !== null}
          onCancel={() => setFireTarget(null)}
          onConfirm={() => {
            const activationId = fireTarget.activationId;
            setFireTarget(null);
            setBusy(activationId);
            setError(null);
            api
              .fire(activationId)
              .catch((e) => setError((e as Error).message))
              .finally(() => setBusy(null));
          }}
        />
      )}
    </section>
  );
}
