import { useState } from 'react';
import type { DashboardState } from '../types';
import { signedUsd, solFromBase, usd } from '../types';

/** Rows visible before the operator expands the tape (the server sends 18h). */
const DEFAULT_VISIBLE = 7;

function chipCls(chip: string): string {
  switch (chip) {
    case 'PAUSED':
      return 'bg-warndim text-warn border border-warnborder';
    case 'EMERGENCY':
      return 'bg-negdim text-neg border border-negborder';
    case 'BELOW MIN':
    case 'TOO OLD':
      return 'text-faint border border-insetborder';
    default:
      return 'bg-warndim text-warn border border-warnborder';
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
 * line 2 carries leader size → outcome; a skip reason renders as a full-text
 * chip on its own line so truncation can never hide why a trade was skipped.
 * The outcome value is right-aligned.
 */
export function ActivityFeed({ state }: { state: DashboardState }) {
  const { activity, activityNoiseCount, counters } = state;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? activity : activity.slice(0, DEFAULT_VISIBLE);
  const hidden = activity.length - visible.length;
  return (
    <section className="card p-4 mb-3.5" aria-label="activity tape" data-testid="activity-feed">
      <div className="flex items-baseline justify-between gap-2">
        <p className="label">Activity · last 18h</p>
        <p className="label !text-[10px]">
          today{' '}
          <span className="text-pos mono" data-testid="copied-today">
            {counters.copiedToday} copied
          </span>{' '}
          ·{' '}
          <span
            className={`mono ${counters.skippedToday > 0 ? 'text-warn' : 'text-faint'}`}
            data-testid="skipped-today"
          >
            {counters.skippedToday} skipped
          </span>
        </p>
      </div>

      {activity.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-muted">
          {state.activeTrader
            ? `No leader activity yet — the tape fills when @${state.activeTrader.handle} next trades.`
            : 'No leader activity.'}
        </p>
      ) : (
        <ul className="mt-2.5 space-y-1.5">
          {visible.map((row) => (
            <li key={row.id} className="panel px-3 py-2" data-testid="activity-row" data-kind={row.kind}>
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                    row.kind === 'copied'
                      ? 'bg-posdim text-pos'
                      : row.kind === 'exit'
                        ? 'bg-infodim text-info'
                        : row.kind === 'skipped'
                          ? 'bg-warndim text-warn'
                          : 'bg-inset text-faint'
                  }`}
                >
                  {row.kind === 'copied'
                    ? '✓'
                    : row.kind === 'exit'
                      ? '↗'
                      : row.kind === 'skipped'
                        ? '⚠'
                        : '·'}
                </span>
                <span className="mono text-[9.5px] text-faint w-9 shrink-0">{rowTime(row.tIso)}</span>
                <div className="min-w-0 flex-1 leading-snug">
                  <p className="text-[12.5px] font-medium truncate">
                    {row.kind === 'exit' || row.kind === 'leader_sell' ? 'sold' : 'bought'}{' '}
                    {row.tokenShort ?? 'token'}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {row.kind === 'copied' && (
                    <p className="money text-[12.5px] font-bold text-pos">
                      ${usd(row.copyUsdMicro ?? '0', 2)}
                    </p>
                  )}
                  {row.kind === 'exit' && row.realizedPnlUsdMicro !== null && (
                    <p
                      className={`money text-[12.5px] font-bold ${
                        BigInt(row.realizedPnlUsdMicro) >= 0n ? 'text-pos' : 'text-neg'
                      }`}
                    >
                      {signedUsd(row.realizedPnlUsdMicro)}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-0.5 pl-[30px]">
                <p className="text-[11px] text-muted truncate">
                  {row.kind === 'copied' && <>leader {leaderText(row) || '—'} · 0.25x copy</>}
                  {row.kind === 'skipped' && <>leader {leaderText(row) || '—'} · not copied</>}
                  {row.kind === 'exit' && 'mirrored exit — position closed'}
                  {row.kind === 'leader_sell' && 'no position held'}
                </p>
                {row.reasonChip && (
                  <span className={`tag chip shrink-0 !text-[10px] ${chipCls(row.reasonChip)}`}>
                    {row.reasonChip}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2.5 w-full panel py-1.5 label !text-[10px] !text-muted hover:!text-ink cursor-pointer"
          data-testid="activity-toggle"
        >
          {expanded ? 'Show less' : `Show ${hidden} more (all 18h)`}
        </button>
      )}

      {activityNoiseCount > 0 && (
        <p className="label !text-[9.5px] !text-faint mt-2.5" data-testid="noise-count">
          +{activityNoiseCount} non-trade events (airdrops / transfers) ignored
        </p>
      )}
    </section>
  );
}
