import { useEffect, useState } from 'react';
import type { DashboardState } from '../types';
import { Avatar } from './charts';

/**
 * Fired-trader handoff animation (tightened to ~3.1s):
 *   1. dim the background        (scrim)
 *   2. raise the outgoing card   (anim-raise)
 *   3. UNFOLLOWED state          (label)
 *   4. rotated red FIRED stamp   (anim-stamp)
 *   5. downward execution arrow  (anim-arrow)
 *   6. NOW COPYING reveal        (anim-reveal)
 *   7. no replacement -> WAITING FOR ZCODE (never an invented trader)
 * prefers-reduced-motion: all animation disabled via CSS, content still shown.
 */
export function HandoffOverlay({ handoff }: { handoff: NonNullable<DashboardState['handoff']> }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 3_200);
    return () => clearTimeout(timer);
  }, [handoff.atIso, handoff.fromHandle, handoff.toHandle]);

  if (!visible) return null;
  const waiting = handoff.phase === 'WAITING_FOR_ZCODE' || handoff.toHandle === null;
  const freshResearch = handoff.phase === 'PAUSED_FOR_FRESH_RESEARCH';
  const reasonLine = `${(handoff.fromReason ?? '2 consecutive losses').toLowerCase()} → ${
    freshResearch ? 'fresh research first' : 'next candidate'
  }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-5 anim-scrim"
      style={{ background: 'rgba(4, 5, 8, 0.7)', backdropFilter: 'blur(6px)' }}
      role="alert"
      aria-live="assertive"
      data-testid="handoff-overlay"
    >
      <div className="w-full max-w-[400px]">
        <div
          className="card !bg-glassstrong p-5 anim-raise relative overflow-hidden"
          data-testid="handoff-card"
        >
          <p className="tag !text-neg">UNFOLLOWED</p>
          <div className="mt-2 flex items-center gap-3">
            <Avatar name={handoff.fromHandle} size={44} />
            <div>
              <p className="text-[16px] font-bold">@{handoff.fromHandle}</p>
              <p className="text-[11px] text-muted">
                {handoff.fromRank !== null ? `#${handoff.fromRank} weekly · ` : ''}
                {handoff.fromPnlText ?? 'PnL —'}
              </p>
            </div>
          </div>
          <p className="label mt-2 !text-[10px] !text-faint">{reasonLine}</p>

          {/* rotated red stamp */}
          <div
            className="anim-stamp absolute right-4 top-9 select-none"
            data-testid="fired-stamp"
            aria-label="trader fired"
          >
            <span
              className="inline-block border-[3px] border-neg text-neg rounded-md px-3 py-1 text-[20px] font-black tracking-[0.2em] mono"
              style={{ transform: 'rotate(-12deg)', background: 'rgba(255, 107, 107, 0.08)' }}
            >
              FIRED
            </span>
          </div>

          {/* downward execution arrow */}
          <div className="anim-arrow flex justify-center my-2" aria-hidden="true">
            <svg width="26" height="34" viewBox="0 0 26 34">
              <path d="M13 2v24" stroke="var(--color-ink)" strokeWidth="2.5" strokeLinecap="round" />
              <path
                d="M6 22l7 8 7-8"
                fill="none"
                stroke="var(--color-ink)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          {waiting ? (
            <div className="anim-reveal panel border-warnborder bg-warndim p-3.5" data-testid="waiting-zcode">
              <p className="tag !text-warn">
                {freshResearch ? 'HIRED PAUSED — FRESH RESEARCH FIRST' : 'WAITING FOR ZCODE'}
              </p>
              {freshResearch ? (
                <p className="text-[12px] text-muted mt-1">
                  The board has refreshed since the last recommendation, so the bot will not hire from a stale
                  ranking. The next research pass re-ranks the current board and the best candidate right now
                  is hired automatically.
                </p>
              ) : (
                <p className="text-[12px] text-muted mt-1">
                  No eligible replacement in the latest recommendation. Monitoring, mirrored exits,
                  reconciliation, and emergency controls continue. Use the ZCode scheduled task's "Run now"
                  action or import a fresh recommendation.
                </p>
              )}
            </div>
          ) : (
            <div className="anim-reveal panel p-3.5 flex items-center gap-3" data-testid="now-copying">
              <Avatar name={handoff.toHandle!} size={40} />
              <div>
                <p className="tag !text-pos">NOW COPYING</p>
                <p className="text-[15px] font-bold">@{handoff.toHandle}</p>
                <p className="text-[11px] text-muted">
                  {handoff.toRank !== null ? `#${handoff.toRank} weekly · ` : ''}copy 0.25x · exits when the
                  leader sells
                </p>
              </div>
            </div>
          )}

          <p className="label !text-[9px] !text-faint mt-3 text-center">
            {handoff.demo ? 'FICTIONAL DEMO · NOT A PERFORMANCE CLAIM' : 'EXECUTED BY ZCODE BOT WORKER'}
          </p>
        </div>
      </div>
    </div>
  );
}
