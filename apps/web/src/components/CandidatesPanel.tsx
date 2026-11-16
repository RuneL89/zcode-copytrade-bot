import { useEffect, useMemo, useState } from 'react';
import type { DashboardState } from '../types';
import { clockFromSeconds, dirPair, signedUsd } from '../types';
import { api } from '../api';
import { Avatar } from './charts';

/**
 * A trader_candidates row, as returned by GET /api/candidates. Display-only:
 * the engine re-verifies every gate live at hire time.
 */
interface CandidateRow {
  candidateId: string;
  handle: string;
  weeklyRank: number | null;
  avatarUrl: string | null;
  enabled: boolean;
  pnl24hUsd: number | null;
  rank24h: number | null;
  winRatePct: number | null;
  recentBuys: number | null;
  recentSells: number | null;
  avgHoldHours: number | null;
  swaps24h: number | null;
  lastSwapAt: string | null;
  lastBuyAt: string | null;
  buys24h: number | null;
  sells24h: number | null;
  activityCheckStatus: 'ok' | 'partial' | 'failed' | null;
  activityCheckedAt: string | null;
  statsCheckedAt: string | null;
  observedAt: string;
}

interface AddressRow {
  candidateId: string;
  chain: string;
  address: string;
  verification: string;
}

const ACTIVE_BUY_WINDOW_HOURS = 4; // ACTIVE_BUY_WINDOW_HOURS default (engine re-verifies live)
const SWAPS_24H_MIN = 5; // funded-activity screen shown in the pool table
const LAST_SWAP_MAX_HOURS = 20; // the same screen's recency window

const POLL_MS = 30_000;

function ageHours(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 3_600_000 : null;
}

/** Freshness LED tone for a stamp against its own freshness window. */
function stampTone(ageH: number | null, windowH: number): 'ok' | 'warn' | 'idle' {
  if (ageH === null) return 'idle';
  if (ageH <= windowH) return 'ok';
  if (ageH <= windowH * 2) return 'warn';
  return 'idle';
}

function ageLabel(ageH: number | null): string {
  if (ageH === null) return '—';
  if (ageH < 1) return `${Math.max(1, Math.round(ageH * 60))}m`;
  if (ageH < 24) return `${ageH.toFixed(ageH < 10 ? 1 : 0)}h`;
  return `${Math.round(ageH / 24)}d`;
}

/**
 * Buyer tier for the pool table's sort — mirrors the watch list's admission
 * (actively trading → bought in 24h → rest). Unknown always sorts last: an
 * unverified wallet is not a buyer as far as this display is concerned.
 */
function buyerTier(row: CandidateRow, now: number): 0 | 1 | 2 {
  // A partial reading is a proven lower bound from a bounded prefix; it sorts
  // with a complete reading, while failed/never-checked wallets stay last.
  if (row.activityCheckStatus !== 'ok' && row.activityCheckStatus !== 'partial') return 2;
  const lastBuyAge = ageHours(row.lastBuyAt, now);
  if (lastBuyAge !== null && lastBuyAge <= ACTIVE_BUY_WINDOW_HOURS) return 0;
  if ((row.buys24h ?? 0) > 0) return 1;
  return 2;
}

/**
 * "Who we copy", rebuilt around what the sweep captures and what the loop
 * considers: a board-pulse strip (how much of the board is actually buying),
 * the promotion queue's order (who takes a chair if one frees
 * now), and every candidate on the board with a direction-aware buyer chip —
 * BUY with age, sell-heavy marker, or an explicit unknown state (CHECK FAILED
 * / NO DATA). Data: the dashboard state (SSE) + a 30s poll of GET /api/candidates.
 * The engine re-verifies every gate live at hire time — this is display-only.
 */
export function CandidatesPanel({ state }: { state: DashboardState }) {
  const { sessionElapsedSeconds, entries } = state.candidates;
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [addresses, setAddresses] = useState<AddressRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .candidates()
        .then((r) => {
          if (!alive) return;
          setRows((r.candidates ?? []) as unknown as CandidateRow[]);
          setAddresses((r.addresses ?? []) as unknown as AddressRow[]);
          setLoadError(null);
        })
        .catch((e) => alive && setLoadError((e as Error).message));
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  // Board presence proxy: the sweep stamps every captured row at import time,
  // so "on the latest scan" ≈ observedAt within 10 minutes of the newest one.
  const newestObserved = useMemo(
    () => Math.max(0, ...rows.map((r) => Date.parse(r.observedAt) || 0)),
    [rows],
  );

  const byId = useMemo(() => new Map(rows.map((r) => [r.candidateId, r])), [rows]);
  const addrById = useMemo(() => {
    const m = new Map<string, AddressRow[]>();
    for (const a of addresses) {
      const list = m.get(a.candidateId) ?? [];
      list.push(a);
      m.set(a.candidateId, list);
    }
    return m;
  }, [addresses]);
  const sseById = useMemo(() => new Map(entries.map((e) => [e.candidateId, e])), [entries]);

  const gates = (row: CandidateRow) => {
    const addrs = addrById.get(row.candidateId) ?? [];
    const addrState =
      addrs.length === 0
        ? 'none'
        : addrs.some((a) => a.verification === 'verified')
          ? 'verified'
          : 'reported';
    const actAge = ageHours(row.activityCheckedAt, now);
    const activityFresh = actAge !== null && actAge <= 6;
    const lastSwapAge = ageHours(row.lastSwapAt, now);
    const lastBuyAge = ageHours(row.lastBuyAt, now);
    const statsAge = ageHours(row.statsCheckedAt, now);
    const onScan = (newestObserved - Date.parse(row.observedAt) || 0) <= 10 * 60_000;
    return {
      onScan,
      addrState,
      activityFresh,
      swapsOk: (row.swaps24h ?? 0) >= SWAPS_24H_MIN,
      lastSwapOk: lastSwapAge !== null && lastSwapAge <= LAST_SWAP_MAX_HOURS,
      activelyBuying: lastBuyAge !== null && lastBuyAge <= ACTIVE_BUY_WINDOW_HOURS,
      positiveDay: (row.pnl24hUsd ?? 0) > 0 && statsAge !== null && statsAge <= 12,
      actAge,
      lastSwapAge,
      lastBuyAge,
      statsAge,
      obsAge: ageHours(row.observedAt, now),
      addrs,
    };
  };

  const board = useMemo(
    () =>
      [...rows]
        .filter((r) => r.enabled)
        .sort((a, b) => {
          const tier = buyerTier(a, now) - buyerTier(b, now);
          if (tier !== 0) return tier;
          // Fresher last buy wins the tie, then the bigger day.
          const la = a.lastBuyAt ? Date.parse(a.lastBuyAt) : 0;
          const lb = b.lastBuyAt ? Date.parse(b.lastBuyAt) : 0;
          if (la !== lb) return lb - la;
          return (b.pnl24hUsd ?? -Infinity) - (a.pnl24hUsd ?? -Infinity);
        })
        .slice(0, 8),
    [rows, now],
  );

  // Board pulse: how much of the enabled board is actually buying. Same
  // display-only precedent as gates() — the engine re-verifies live.
  const pulse = useMemo(() => {
    const enabled = rows.filter((r) => r.enabled);
    let bought = 0;
    let inWindow = 0;
    let failed = 0;
    for (const r of enabled) {
      if (r.activityCheckStatus === 'failed') failed++;
      if (r.activityCheckStatus !== 'ok' && r.activityCheckStatus !== 'partial') continue;
      if ((r.buys24h ?? 0) > 0) bought++;
      const a = ageHours(r.lastBuyAt, now);
      if (a !== null && a <= ACTIVE_BUY_WINDOW_HOURS) inWindow++;
    }
    return { total: enabled.length, bought, inWindow, failed };
  }, [rows, now]);

  const statusChip = (candidateId: string) => {
    const e = sseById.get(candidateId);
    if (e?.active) return <span className="tag chip bg-posdim text-pos !text-[10px]">NOW</span>;
    if (e?.fired) return <span className="tag chip bg-negdim text-neg !text-[10px]">FIRED</span>;
    return null;
  };

  /**
   * Direction chip from the on-chain wallet refresh. Unknown is explicit:
   * CHECK FAILED (the check errored) and NO DATA (never checked) are not the
   * same as NO BUYS (checked, wallet quiet).
   */
  function BuyerChip({ row }: { row: CandidateRow }) {
    const g = gates(row);
    const base = 'tag chip !text-[10px] shrink-0 whitespace-nowrap';
    const partialNote =
      row.activityCheckStatus === 'partial' ? ' (partial read — counts are a lower bound)' : '';
    if (row.activityCheckStatus === 'failed') {
      return (
        <span
          className={`${base} border border-negborder text-neg`}
          title="on-chain check failed — direction unknown"
        >
          CHECK FAILED
        </span>
      );
    }
    if (row.activityCheckStatus === null) {
      return (
        <span className={`${base} bg-inset text-faint`} title="wallet never direction-checked">
          NO DATA
        </span>
      );
    }
    const sellsOver = (row.sells24h ?? 0) > (row.buys24h ?? 0);
    if (g.lastBuyAge !== null && g.lastBuyAge <= ACTIVE_BUY_WINDOW_HOURS) {
      return (
        <span
          className={`${base} bg-posdim text-pos`}
          title={`bought ${ageLabel(g.lastBuyAge)} ago — inside the ${ACTIVE_BUY_WINDOW_HOURS}h buy window${partialNote}`}
        >
          BUY {ageLabel(g.lastBuyAge)}
          {sellsOver && ' s>b'}
        </span>
      );
    }
    if (g.lastBuyAge !== null) {
      return (
        <span
          className={`${base} bg-warndim text-warn`}
          title={`last buy ${ageLabel(g.lastBuyAge)} ago — outside the buy window${partialNote}`}
        >
          BUY {ageLabel(g.lastBuyAge)}
          {sellsOver && ' s>b'}
        </span>
      );
    }
    // Checked ok, but no buy found in the lookback: quiet (or sell-only).
    if ((row.sells24h ?? 0) > 0) {
      return (
        <span
          className={`${base} bg-negdim text-neg`}
          title={`no buys in 24h — sell-only wallet${partialNote}`}
        >
          {dirPair(row.buys24h, row.sells24h)}
        </span>
      );
    }
    return (
      <span className={`${base} bg-inset text-faint`} title={`no buys in 24h${partialNote}`}>
        NO BUYS
      </span>
    );
  }

  return (
    <section className="card p-4 mb-3.5" aria-label="who we copy" data-testid="candidates-panel">
      <div className="flex items-baseline justify-between">
        <p className="label">Who we copy</p>
        <p className="money label !text-[10px]">{clockFromSeconds(sessionElapsedSeconds)} / 24h</p>
      </div>

      {loadError && (
        <p className="mono text-[9.5px] text-warn mt-1.5">candidate roster unavailable: {loadError}</p>
      )}

      {/* Board pulse — the buyer-truth line for the whole board at a glance */}
      {pulse.total > 0 && (
        <p className="panel px-3 py-2 mt-2.5 mono text-[11px] text-muted" data-testid="board-pulse">
          BOARD{' '}
          <span className="text-ink">
            {pulse.bought}/{pulse.total}
          </span>{' '}
          bought 24h
          {pulse.inWindow > 0 && (
            <>
              {' · '}
              <span className="text-pos">{pulse.inWindow} in buy window</span>
            </>
          )}
          {pulse.failed > 0 && (
            <>
              {' · '}
              <span className="text-neg">{pulse.failed} check failed</span>
            </>
          )}
        </p>
      )}

      {/* Chairs are filled from the watch list's promotion queue (D4). */}
      <div className="panel p-3 mt-2.5">
        <p className="label !text-[10px]">Next up if a chair frees</p>
        <p className="text-[11.5px] text-muted mt-1">
          {state.watchlist.bench > 0
            ? `${state.watchlist.bench} promotable wallet(s) on the bench — the next chair goes to the best shadow record.`
            : `No promotable wallet yet — the bench target is ${state.watchlist.benchTarget} and discovery refills it.`}
        </p>
      </div>

      <p className="label !text-[9.5px] !text-faint mt-3 border-t border-insetborder pt-2">
        Weekly top on FOMO · watch list {state.watchlist.size}/{state.watchlist.cap} · bench{' '}
        {state.watchlist.bench}/{state.watchlist.benchTarget}
      </p>
    </section>
  );
}
