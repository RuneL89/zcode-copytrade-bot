import type { DashboardState } from '../types';
import { signedUsd, usd, timeAgo } from '../types';
import { Avatar } from './charts';

export function ActiveTraderCard({ state }: { state: DashboardState }) {
  const t = state.activeTrader;
  if (!t) {
    // The hiring pipeline (idle → fired → research → hire) lives in the OPEN
    // POSITIONS card, next to where the idle countdown used to be.
    return (
      <section className="card p-5 mb-4" aria-label="active trader">
        <p className="label">NOW COPYING</p>
        <p className="mt-2 text-[15px] font-semibold">
          {state.appState === 'PAUSED_WAITING_FOR_ZCODE'
            ? 'WAITING FOR ZCODE'
            : state.appState === 'PAUSED_WAITING_FOR_CANDIDATE'
              ? 'WAITING FOR A CANDIDATE'
              : 'NO ACTIVE TRADER'}
        </p>
        <p className="text-[12px] text-[#7d78a0] mt-1">
          {state.hiring?.pausedForResearch
            ? 'Fired — the bot is paused while fresh research ranks the current board, then the best candidate is hired automatically. Follow the steps in OPEN POSITIONS.'
            : state.appState === 'PAUSED_WAITING_FOR_ZCODE'
              ? 'Recommendation exhausted, stale, or missing. Use the ZCode scheduled task’s “Run now” action or import a fresh recommendation in Settings. Exits and monitoring continue.'
              : 'Activate a candidate from Settings, or wait for a fresh ZCode recommendation.'}
        </p>
      </section>
    );
  }

  const realized = BigInt(t.realizedPnlUsdMicro);
  const rankText = t.weeklyRank !== null ? `#${t.weeklyRank} weekly` : 'weekly —';
  const pnl7d = t.displayedPnl7dUsdMicro ? `+${usd(t.displayedPnl7dUsdMicro, 0)}% 7d (displayed)` : '7d —';

  return (
    <section className="card p-5 mb-4" aria-label="active trader" data-testid="active-trader">
      <div className="flex items-center gap-3.5">
        <Avatar name={t.handle} url={t.avatarUrl} size={48} />
        <div className="min-w-0 flex-1">
          <p className="label">NOW COPYING</p>
          <p className="text-[17px] font-bold truncate">@{t.handle}</p>
          <p className="text-[11.5px] text-[#7d78a0] mt-0.5">
            {rankText} · {pnl7d}
          </p>
        </div>
        <span className="label !text-[9.5px] rounded-full bg-[#2a2740] text-white px-2.5 py-1">
          {t.copyScale}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div>
          <p className="label">LAST 6</p>
          {t.lastSix.length ? (
            <div className="flex gap-1.5 mt-1.5" aria-label={`last six results: ${t.lastSix.join(', ')}`}>
              {t.lastSix.map((r, i) => (
                <span
                  key={i}
                  className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center ${
                    r === 'W'
                      ? 'bg-emerald-100 text-emerald-700'
                      : r === 'L'
                        ? 'bg-rose-100 text-rose-600'
                        : 'bg-white/70 text-[#c6c2dd] border border-white'
                  }`}
                >
                  {r}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-[#a29dbf] mt-1.5">no closed trades yet</p>
          )}
        </div>
        <div className="text-right">
          <p className="label mt-1">
            FIRE AT {t.fireAfter} L · <span data-testid="streak">{t.streak}</span>/{t.fireAfter}
          </p>
        </div>
      </div>

      <HirePerformanceCard state={state} />
    </section>
  );
}

/**
 * Performance of the CURRENT hire only: realized (fee-net closed lots) plus
 * unrealized (live marks) scoped to this activation. A rehire — even of the
 * same trader — starts a new activation, so these numbers reset.
 */
/**
 * Profit/loss summary for the CURRENT hire: what was bought and sold, net
 * made/lost (fee-net realized), and open P/L at live marks — all scoped to
 * this activation. A rehire (even of the same trader) resets everything.
 */
function HirePerformanceCard({ state }: { state: DashboardState }) {
  const t = state.activeTrader!;
  const realized = BigInt(t.realizedPnlUsdMicro);
  const unrealized = BigInt(t.unrealizedPnlUsdMicro);
  const hasTrades = t.boughtCount > 0 || t.soldCount > 0;
  return (
    <div
      className="mt-4 rounded-[18px] bg-white/55 border border-white/80 p-4"
      data-testid="hire-performance"
      aria-label="performance since hire"
    >
      <div className="flex items-center justify-between">
        <p className="label">
          SINCE HIRE {new Date(t.sinceIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
        <p className="label !text-[9px]">RESETS ON REHIRE</p>
      </div>
      {!hasTrades ? (
        <p className="mt-2 text-[12.5px] text-[#7d78a0]">
          No copied trades this hire — the summary fills when @{t.handle} next trades.
        </p>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline justify-between">
            <p className="label !text-[8.5px]">MADE / LOST (FEES INCLUDED)</p>
            <p
              className="money text-[19px] font-bold"
              style={{ color: realized >= 0n ? '#16a06a' : '#e85454' }}
            >
              {signedUsd(t.realizedPnlUsdMicro)}
            </p>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
            <div>
              <p className="label !text-[8.5px]">BOUGHT</p>
              <p className="money font-semibold">
                {t.boughtCount} · ${usd(t.boughtUsdMicro, 0)}
              </p>
            </div>
            <div>
              <p className="label !text-[8.5px]">SOLD</p>
              <p className="money font-semibold">
                {t.soldCount}
                {t.soldUsdMicro !== null ? ` · $${usd(t.soldUsdMicro, 0)}` : ''}
              </p>
            </div>
            <div className="text-right">
              <p className="label !text-[8.5px]">OPEN P/L</p>
              <p className="money font-semibold" style={{ color: unrealized >= 0n ? '#16a06a' : '#e85454' }}>
                {signedUsd(t.unrealizedPnlUsdMicro)}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
