import { useEffect, useState } from 'react';
import type { DashboardState } from '../types';
import { signedUsd, usd } from '../types';
import { Avatar } from './charts';
import { HiringPipeline } from './HiringPipeline';

const TICK_MS = 10_000;

/**
 * The "who & why" card: who the bot copies right now, the live hire/fire
 * pipeline beneath it, and this hire's performance. The pipeline is always
 * rendered — also while positions are open — so the handoff is never invisible.
 */
export function ActiveTraderCard({ state }: { state: DashboardState }) {
  const t = state.activeTrader;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="card p-4 mb-3.5" aria-label="active trader" data-testid="active-trader">
      {!t ? (
        <>
          <p className="label">Now copying</p>
          <p className="mt-1.5 text-[15px] font-semibold">
            {state.appState === 'PAUSED_WAITING_FOR_ZCODE'
              ? 'Waiting for ZCode'
              : state.appState === 'PAUSED_WAITING_FOR_CANDIDATE'
                ? 'Waiting for a candidate'
                : 'No active trader'}
          </p>
          <p className="text-[12px] text-muted mt-1">
            {state.hiring?.pausedForResearch
              ? 'Fired — the bot is paused while fresh research ranks the current board, then the best candidate is hired automatically.'
              : state.appState === 'PAUSED_WAITING_FOR_ZCODE'
                ? 'Recommendation exhausted, stale, or missing. Use the ZCode scheduled task’s “Run now” action or import a fresh recommendation in Settings. Exits and monitoring continue.'
                : 'Activate a candidate from Settings, or wait for a fresh ZCode recommendation.'}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Avatar name={t.handle} url={t.avatarUrl} size={44} />
            <div className="min-w-0 flex-1">
              <p className="label">Now copying</p>
              <p className="text-[16px] font-bold truncate leading-tight">@{t.handle}</p>
              <p className="text-[11px] text-muted mt-0.5">
                {t.weeklyRank !== null ? `#${t.weeklyRank} weekly` : 'weekly —'} ·{' '}
                {t.displayedPnl7dUsdMicro ? `+${usd(t.displayedPnl7dUsdMicro, 0)}% 7d (displayed)` : '7d —'}
              </p>
            </div>
            <span className="tag chip bg-accentdim text-accent border border-accentborder">
              {t.copyScale}
            </span>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <div>
              <p className="label !text-[10px]">Last 6</p>
              {t.lastSix.length ? (
                <div className="flex gap-1 mt-1.5" aria-label={`last six results: ${t.lastSix.join(', ')}`}>
                  {t.lastSix.map((r, i) => (
                    <span
                      key={i}
                      className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center ${
                        r === 'W'
                          ? 'bg-posdim text-pos'
                          : r === 'L'
                            ? 'bg-negdim text-neg'
                            : 'bg-inset text-faint border border-insetborder'
                      }`}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-faint mt-1.5">no closed trades yet</p>
              )}
            </div>
            <p className="label !text-[10px]">
              FIRE AT {t.fireAfter} L ·{' '}
              <span data-testid="streak" className="mono">
                {t.streak}
              </span>
              /{t.fireAfter}
            </p>
          </div>
        </>
      )}

      <HiringPipeline state={state} now={now} />

      {t && <HirePerformanceCard state={state} />}
    </section>
  );
}

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
    <div className="mt-3 panel p-3.5" data-testid="hire-performance" aria-label="performance since hire">
      <div className="flex items-center justify-between">
        <p className="label !text-[10px]">
          Since hire {new Date(t.sinceIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
        <p className="label !text-[9.5px] !text-faint">resets on rehire</p>
      </div>
      {!hasTrades ? (
        <p className="mt-1.5 text-[12px] text-muted">
          No copied trades this hire — the summary fills when @{t.handle} next trades.
        </p>
      ) : (
        <>
          <div className="mt-1 flex items-baseline justify-between">
            <p className="label !text-[9.5px] !text-faint">Made / lost (fees included)</p>
            <p className={`money text-[18px] font-bold ${realized >= 0n ? 'text-pos' : 'text-neg'}`}>
              {signedUsd(t.realizedPnlUsdMicro)}
            </p>
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-2 text-[12px]">
            <div>
              <p className="label !text-[9.5px]">Bought</p>
              <p className="money font-semibold">
                {t.boughtCount} · ${usd(t.boughtUsdMicro, 0)}
              </p>
            </div>
            <div>
              <p className="label !text-[9.5px]">Sold</p>
              <p className="money font-semibold">
                {t.soldCount}
                {t.soldUsdMicro !== null ? ` · $${usd(t.soldUsdMicro, 0)}` : ''}
              </p>
            </div>
            <div className="text-right">
              <p className="label !text-[9.5px]">Open P/L</p>
              <p className={`money font-semibold ${unrealized >= 0n ? 'text-pos' : 'text-neg'}`}>
                {signedUsd(t.unrealizedPnlUsdMicro)}
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
