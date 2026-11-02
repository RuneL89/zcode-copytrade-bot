import type { DashboardState } from '../types';
import { timeAgo } from '../types';

/**
 * The fired lane (plan 07, AC3): the last five firings with their real cause and
 * the chair's replacement status. Rows come straight from
 * `DashboardState.pipeline.exits.recent` — nothing here is inferred.
 */
export function FiredLane({ state }: { state: DashboardState }) {
  const exits = state.pipeline.exits;
  const recent = exits.recent.slice(0, 5);
  return (
    <section className="card p-4 mb-3.5" aria-label="fired lane" data-testid="fired-lane">
      <div className="flex items-center justify-between gap-2">
        <p className="label">Fired lane</p>
        <p className="label !text-[10px] !text-faint" data-testid="fired-lane-counts">
          {exits.fired24h} fired / 24h · {exits.replacements24h} replaced
        </p>
      </div>
      {recent.length === 0 ? (
        <p className="text-[11.5px] text-muted mt-2" data-testid="fired-lane-empty">
          No firings yet — a lost chair lands here with its cause and replacement.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {recent.map((row) => (
            <li
              key={`${row.candidateId}-${row.firedAt}`}
              data-testid={`fired-row-${row.candidateId}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]"
            >
              <span className="font-semibold text-neg min-w-0 truncate">@{row.handle}</span>
              {/* A reason can be a full sentence (the legacy rank fires were):
                  it wraps inside the card instead of pushing the page sideways. */}
              <span className="chip tag border border-negborder bg-negdim text-neg max-w-full !whitespace-normal break-words">
                {row.reason}
              </span>
              <span className="label !text-[10px] !text-faint whitespace-nowrap">{timeAgo(row.firedAt)}</span>
              <span className="ml-auto label !text-[10px] !text-muted whitespace-nowrap">
                {row.replacedBy ? `replaced by @${row.replacedBy}` : 'chair empty'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
