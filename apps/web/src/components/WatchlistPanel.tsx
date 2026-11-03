import { useState } from 'react';
import { api } from '../api';
import type { DashboardState } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * The panel enables "Promote now" only for a watching row the gate does not
 * block — the same `canPromote` verdict the server sent as `blockedReason`.
 */
export function isPromotable(row: DashboardState['watchlist']['rows'][number]): boolean {
  return row.status === 'watching' && row.blockedReason === null;
}

/**
 * D4 watch list: the wallets under observation, their shadow-ledger record and
 * the promotion gate's reason. Every number is labeled SHADOW_LEDGER — the fomo
 * PnL mark is never a gate, so it does not appear here.
 */
export function WatchlistPanel({ state }: { state: DashboardState }) {
  const wl = state.watchlist;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);

  const act = (candidateId: string, fn: () => Promise<unknown>) => {
    setBusy(candidateId);
    setError(null);
    fn()
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(null));
  };

  const queueReady = wl.rows.filter((r) => isPromotable(r)).length;
  const nextBlocked =
    wl.rows.find((r) => r.status === 'watching' && r.blockedReason !== null)?.blockedReason ?? null;

  const age = (iso: string | null): string => {
    if (!iso) return '—';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const hours = ms / 3_600_000;
    if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  };

  const usd = (micro: string): string => {
    const n = Number(micro) / 1e6;
    const sign = n < 0 ? '-' : '';
    return `${sign}$${Math.abs(n).toFixed(2)}`;
  };

  return (
    <section className="card p-4 mb-3.5" aria-label="watch list" data-testid="watchlist-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="label">Watch list</p>
        <p className="label !text-[9.5px] !text-faint" data-testid="watchlist-counts">
          {wl.size}/{wl.cap} watching · bench {wl.bench}/{wl.benchTarget}
        </p>
      </div>
      <p className="label !text-[9px] !text-faint mt-0.5" data-testid="watchlist-order">
        Next hire first: bench, then ready, then blocked.
      </p>

      {wl.rows.length === 0 ? (
        <p className="text-[11.5px] text-muted mt-2" data-testid="watchlist-empty">
          No wallets on the watch list — discovery runs when the bench is below {wl.benchTarget}.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {wl.rows.map((row) => {
            const promotable = isPromotable(row);
            return (
              <li
                key={row.candidateId}
                data-testid={`watch-row-${row.candidateId}`}
                className="border border-insetborder rounded-lg p-2.5"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {row.profileUrl ? (
                    <a
                      href={row.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[13px] font-semibold text-accent min-w-0 truncate"
                    >
                      @{row.handle}
                    </a>
                  ) : (
                    <span className="text-[13px] font-semibold min-w-0 truncate">@{row.handle}</span>
                  )}
                  <span
                    className={`chip tag ${
                      row.status === 'promoted' || row.status === 'hired'
                        ? 'bg-posdim text-pos'
                        : row.status === 'cooling'
                          ? 'bg-warndim text-warn'
                          : row.status === 'archived'
                            ? 'bg-inset text-faint'
                            : 'bg-accentdim text-accent'
                    }`}
                  >
                    {row.status.toUpperCase()}
                  </span>
                  <span className="ml-auto label !text-[9px] !text-faint">SHADOW LEDGER</span>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-2 text-[10.5px]">
                  <div>
                    <p className="label !text-[9px]">LAST BUY</p>
                    <p className="money" data-testid={`watch-lastbuy-${row.candidateId}`}>
                      {age(row.lastFundedBuyAt)}
                    </p>
                  </div>
                  <div>
                    <p className="label !text-[9px]">BUYS/SELLS 24H</p>
                    <p className="money">
                      {row.fundedBuys24h}/{row.fundedSells24h}
                    </p>
                  </div>
                  <div>
                    <p className="label !text-[9px]">CLOSED</p>
                    <p className="money">{row.closedTrades}</p>
                  </div>
                  <div>
                    <p className="label !text-[9px]">NET</p>
                    <p
                      className={`money ${BigInt(row.netShadowPnlUsdMicro) > 0n ? 'text-pos' : BigInt(row.netShadowPnlUsdMicro) < 0n ? 'text-neg' : ''}`}
                    >
                      {usd(row.netShadowPnlUsdMicro)}
                    </p>
                  </div>
                  <div>
                    <p className="label !text-[9px]">OPEN</p>
                    <p className="money">{usd(row.openNotionalUsdMicro)}</p>
                  </div>
                  <div>
                    <p className="label !text-[9px]">AT CEILING</p>
                    <p className="money">{usd(row.ceilingExposureUsdMicro)}</p>
                  </div>
                </div>

                {row.status === 'watching' && row.blockedReason && (
                  <p
                    className="text-[10.5px] text-warn mt-2"
                    data-testid={`watch-blocked-${row.candidateId}`}
                    role="status"
                  >
                    Blocked: {row.blockedReason}
                  </p>
                )}

                <div className="flex gap-2 mt-2">
                  <button
                    disabled={!promotable || busy === row.candidateId}
                    title={promotable ? 'Promote into the roster' : (row.blockedReason ?? row.status)}
                    onClick={() => act(row.candidateId, () => api.watchPromote(row.candidateId))}
                    data-testid={`watch-promote-${row.candidateId}`}
                    className="rounded-[10px] border border-accentborder bg-accentdim text-accent mono text-[10.5px] font-semibold px-2.5 py-1 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                  >
                    {busy === row.candidateId ? 'WORKING…' : 'PROMOTE NOW'}
                  </button>
                  {row.status === 'archived' ? (
                    <button
                      disabled={busy === row.candidateId}
                      onClick={() => act(row.candidateId, () => api.watchUnarchive(row.candidateId))}
                      data-testid={`watch-unarchive-${row.candidateId}`}
                      className="rounded-[10px] border border-insetborder bg-inset text-muted mono text-[10.5px] px-2.5 py-1 cursor-pointer"
                    >
                      UNARCHIVE
                    </button>
                  ) : row.status === 'hired' ? null : (
                    <button
                      disabled={busy === row.candidateId}
                      onClick={() => setArchiveTarget(row.candidateId)}
                      data-testid={`watch-archive-${row.candidateId}`}
                      className="rounded-[10px] border border-insetborder bg-inset text-muted mono text-[10.5px] px-2.5 py-1 cursor-pointer"
                    >
                      ARCHIVE
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="label !text-[9.5px] !text-faint mt-2.5" data-testid="watchlist-footer">
        Next discovery: {wl.nextDiscoveryReason}
      </p>
      <p className="label !text-[9.5px] !text-faint mt-1" data-testid="watchlist-queue">
        Promotion queue: {queueReady} ready · next blocked:{' '}
        {nextBlocked === null ? 'none — every watched wallet is promotable' : nextBlocked}
      </p>
      {error && (
        <p className="text-[11px] text-neg mt-1" role="alert">
          {error}
        </p>
      )}

      {archiveTarget && (
        <ConfirmDialog
          title="Archive this wallet?"
          dangerLabel="ARCHIVE"
          body="It stops being polled and cannot be promoted. A funded buy later does not unarchive it by itself."
          requiredWord="ARCHIVE"
          confirmLabel="ARCHIVE"
          busy={busy !== null}
          onCancel={() => setArchiveTarget(null)}
          onConfirm={() => {
            const candidateId = archiveTarget;
            setArchiveTarget(null);
            act(candidateId, () => api.watchArchive(candidateId));
          }}
        />
      )}
    </section>
  );
}
