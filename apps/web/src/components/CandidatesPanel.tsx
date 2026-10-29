import type { DashboardState } from '../types';
import { clockFromSeconds, signedUsd } from '../types';
import { Avatar } from './charts';

const SEGMENT_COLORS = ['#7c6fd8', '#e8a06a', '#5ebfa0', '#c96f9e', '#6aa8d8'];

export function CandidatesPanel({ state }: { state: DashboardState }) {
  const { sessionElapsedSeconds, entries } = state.candidates;
  const contributions = entries.map((e) => Math.max(0, Number(BigInt(e.contributionUsdMicro) / 1000n)));
  const total = contributions.reduce((a, b) => a + b, 0) || 1;

  return (
    <section className="card p-5 mb-6" aria-label="who we copy" data-testid="candidates-panel">
      <div className="flex items-center justify-between">
        <p className="label">WHO WE COPY</p>
        <p className="money label">{clockFromSeconds(sessionElapsedSeconds)} / 24H</p>
      </div>

      <div
        className="mt-3 h-2.5 rounded-full overflow-hidden flex border border-white/60"
        role="img"
        aria-label={`equity contribution: ${entries.map((e, i) => `${e.handle} ${contributions[i]}`).join(', ')}`}
      >
        {contributions.map((c, i) => (
          <div
            key={entries[i]!.candidateId}
            style={{
              width: `${(c / total) * 100}%`,
              background: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
              opacity: entries[i]!.fired ? 0.35 : 1,
            }}
          />
        ))}
        {contributions.every((c) => c === 0) && <div className="w-full bg-white/60" />}
      </div>

      <ul className="mt-3 space-y-2">
        {entries.slice(0, 5).map((e, i) => (
          <li key={e.candidateId} className="flex items-center gap-3">
            <div className="relative">
              <Avatar name={e.handle} size={36} />
              <span
                className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center border-2 border-white ${
                  e.active
                    ? 'bg-emerald-500 text-white'
                    : e.fired
                      ? 'bg-rose-500 text-white'
                      : 'bg-white text-[#6d6893]'
                }`}
                aria-label={e.active ? 'active' : e.fired ? 'fired' : 'idle'}
              >
                {e.active ? '●' : e.fired ? '⊗' : (e.weeklyRank ?? '·')}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p
                className={`text-[13px] font-semibold truncate ${e.fired ? 'line-through text-[#a09bbd]' : ''}`}
              >
                @{e.handle}
                {e.active && <span className="label !text-[8.5px] ml-2 text-emerald-600">NOW</span>}
                {e.fired && <span className="label !text-[8.5px] ml-2 text-rose-500">FIRED</span>}
                {e.awaitingZcode && (
                  <span className="label !text-[8.5px] ml-2 text-orange-600">AWAITING ZCODE</span>
                )}
              </p>
              <p className="label !text-[8.5px]">
                {e.weeklyRank !== null ? `#${e.weeklyRank} weekly` : 'unranked'} ·{' '}
                <span style={{ color: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}>■</span>{' '}
                <span className="money">{signedUsd(e.contributionUsdMicro)}</span>
              </p>
            </div>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-[12px] text-[#7d78a0]">
            No candidates imported yet — add them in Settings (manual JSON/CSV import).
          </li>
        )}
      </ul>

      <p className="label !text-[8.5px] mt-3 border-t border-white/70 pt-2">
        WEEKLY TOP ON FOMO · RECOMMENDATION{' '}
        {state.recommendation.status === 'VALID'
          ? `VALID (${state.recommendation.ordered.length} ORDERED · ${state.recommendation.modelLabel ?? 'MODEL'})`
          : state.recommendation.status}
      </p>
    </section>
  );
}
