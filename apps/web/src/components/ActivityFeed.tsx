import type { DashboardState } from '../types';
import { signedUsd, solFromBase, usd } from '../types';

function chipCls(chip: string): string {
  switch (chip) {
    case 'PAUSED':
      return 'bg-orange-100 text-orange-700';
    case 'EMERGENCY':
      return 'bg-rose-100 text-rose-700';
    case 'BELOW MIN':
    case 'TOO OLD':
      return 'bg-zinc-100 text-zinc-500';
    default:
      return 'bg-amber-100 text-amber-700';
  }
}

function leaderText(row: DashboardState['activity'][number]): string {
  if (row.leaderUsdMicro !== null) return `$${usd(row.leaderUsdMicro, 0)}`;
  if (row.leaderSolBase !== null) return `◎${solFromBase(row.leaderSolBase)}`;
  return '';
}

function rowTime(tIso: string): string {
  return new Date(tIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Two-line rows: line 1 names the event (never truncates mid-number),
 * line 2 carries leader size → outcome. The outcome value is right-aligned
 * so truncation can never hide the money.
 */
export function ActivityFeed({ state }: { state: DashboardState }) {
  const { activity, activityNoiseCount, counters } = state;
  return (
    <section className="card p-5 mb-4" aria-label="activity tape" data-testid="activity-feed">
      <div className="flex items-center justify-between">
        <p className="label">ACTIVITY</p>
        <p className="label !text-[9px]">
          TODAY{' '}
          <span className="text-emerald-700" data-testid="copied-today">
            {counters.copiedToday} COPIED
          </span>{' '}
          ·{' '}
          <span className={counters.skippedToday > 0 ? 'text-amber-700' : ''} data-testid="skipped-today">
            {counters.skippedToday} SKIPPED
          </span>
        </p>
      </div>

      {activity.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-[#7d78a0]">
          {state.activeTrader
            ? `No leader activity yet — the tape fills when @${state.activeTrader.handle} next trades.`
            : 'No leader activity.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {activity.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-2.5 rounded-[12px] bg-white/55 border border-white/80 px-3 py-2"
              data-testid="activity-row"
              data-kind={row.kind}
            >
              <span
                aria-hidden="true"
                className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                  row.kind === 'copied'
                    ? 'bg-emerald-100 text-emerald-700'
                    : row.kind === 'exit'
                      ? 'bg-indigo-100 text-indigo-700'
                      : row.kind === 'skipped'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-zinc-100 text-zinc-400'
                }`}
              >
                {row.kind === 'copied' ? '✓' : row.kind === 'exit' ? '↗' : row.kind === 'skipped' ? '⚠' : '·'}
              </span>
              <span className="label !text-[8.5px] text-[#a29dbf] w-9 shrink-0">{rowTime(row.tIso)}</span>
              <div className="min-w-0 flex-1 leading-snug">
                <p className="text-[12px] font-medium truncate">
                  {row.kind === 'exit' || row.kind === 'leader_sell' ? 'sold' : 'bought'}{' '}
                  {row.tokenShort ?? 'token'}
                </p>
                <p className="text-[11px] text-[#7d78a0] truncate">
                  {row.kind === 'copied' && <>leader {leaderText(row) || '—'} · 0.25x copy</>}
                  {row.kind === 'skipped' && <>leader {leaderText(row) || '—'} · not copied</>}
                  {row.kind === 'exit' && 'mirrored exit — position closed'}
                  {row.kind === 'leader_sell' && 'no position held'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                {row.kind === 'copied' && (
                  <p className="money text-[12px] font-bold text-emerald-700">
                    ${usd(row.copyUsdMicro ?? '0', 0)}
                  </p>
                )}
                {row.kind === 'exit' && row.realizedPnlUsdMicro !== null && (
                  <p
                    className="money text-[12px] font-bold"
                    style={{
                      color: BigInt(row.realizedPnlUsdMicro) >= 0n ? '#16a06a' : '#e85454',
                    }}
                  >
                    {signedUsd(row.realizedPnlUsdMicro)}
                  </p>
                )}
                {row.reasonChip && (
                  <span
                    className={`label !text-[8px] rounded-full px-2 py-0.5 inline-block ${chipCls(row.reasonChip)}`}
                  >
                    {row.reasonChip}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {activityNoiseCount > 0 && (
        <p className="label !text-[8px] mt-3 text-[#a29dbf]" data-testid="noise-count">
          +{activityNoiseCount} NON-TRADE EVENTS (AIRDROPS / TRANSFERS) IGNORED
        </p>
      )}
    </section>
  );
}
