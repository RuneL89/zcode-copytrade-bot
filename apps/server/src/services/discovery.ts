import type { AppDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import type { RiskConfig } from '@zcode-bot/config';
import type { FomoApiAlertsResult, FomoApiLeaderboardResult, FomoApiWindow } from '@zcode-bot/providers';

/**
 * Discovery inlet (D3) + the demand trigger D5 requires.
 *
 * The fomoapi leaderboard is the only automatic handle/wallet source: the 24h,
 * 7d and 30d boards are unioned by the stable `userId` and upserted as
 * candidates; the alerts feed adds traders that are not on any board (without a
 * wallet — a trader is only scannable once a wallet appears). The native
 * desktop-Chrome capture and Dawn stay manual fallbacks; nothing here calls
 * them.
 *
 * Fail-closed: no key → no network call at all; a failing window never aborts
 * the others; `trades`/`volumeUsd` are never read (they are lifetime figures —
 * activity comes from the funded-swap scan, D4).
 */

const WINDOWS: FomoApiWindow[] = ['24h', '7d', '30d'];
const LAST_RUN_KEY = 'discovery.last_run_at';
const CREDITS_KEY = 'discovery.credits_remaining';
const SOURCES_KEY = 'discovery.last_sources';
const etagKey = (window: FomoApiWindow) => `discovery.etag.${window}`;
/** Cap on the audit payload when wallets merge identities. */
const MERGE_DETAIL_LIMIT = 20;

export interface DiscoveryWindowResult {
  window: FomoApiWindow;
  ok: boolean;
  notModified: boolean;
  rows: number;
  unparsed: number;
  creditsCost: number | null;
  error: string | null;
}

export interface DiscoveryRunResult {
  skipped: boolean;
  reason: string;
  windows: DiscoveryWindowResult[];
  /** Distinct traders the union carried. */
  traders: number;
  tradersNew: number;
  tradersUpdated: number;
  /** Rows dropped because their wallet already belongs to another identity. */
  merged: number;
  alertsAdded: number;
  alertsSkipped: number;
  alertsError: string | null;
  creditsSpent: number;
  creditsRemaining: number | null;
}

export interface DiscoveryDemandInput {
  /** Watch wallets that reached the promotion bar (the bench). */
  promotableWatchWallets: number;
  watchListWallets: number;
  rosterInUse: number;
  rosterSize: number;
  benchTarget: number;
  lastRunAt: string | null;
  nowMs: number;
  minIntervalMs: number;
}

/**
 * The D5 demand rule. D4's trigger wins over the plan's looser phrasing:
 * discovery is warranted when a free roster slot has no promotable bench
 * wallet behind it, or when the bench itself sits below BENCH_TARGET.
 * A full roster with a full bench means zero external spend.
 */
export function discoveryDecision(input: DiscoveryDemandInput): { run: boolean; reason: string } {
  const freeSlots = Math.max(0, input.rosterSize - input.rosterInUse);
  const demand =
    freeSlots > 0 && input.promotableWatchWallets < freeSlots
      ? `free roster slot(s) ${freeSlots} with only ${input.promotableWatchWallets} promotable wallet(s)`
      : input.promotableWatchWallets < input.benchTarget
        ? `bench below target (${input.promotableWatchWallets}/${input.benchTarget} promotable)`
        : null;
  if (demand === null) {
    return { run: false, reason: 'roster and bench are full — no external spend' };
  }
  if (input.lastRunAt !== null) {
    const elapsed = input.nowMs - Date.parse(input.lastRunAt);
    if (Number.isFinite(elapsed) && elapsed < input.minIntervalMs) {
      return {
        run: false,
        reason: `rate limited (${Math.round(elapsed / 60_000)} min since the last discovery run)`,
      };
    }
  }
  return { run: true, reason: demand };
}

/** Pure predicate form (plan 04/06 read this); the reason lives in `discoveryDecision`. */
export function shouldDiscover(input: DiscoveryDemandInput): boolean {
  return discoveryDecision(input).run;
}

/**
 * The slice of the provider this service needs. `FomoApiClient` satisfies it
 * structurally; tests supply a stub so no test ever touches the real API or
 * spends credits.
 */
export interface DiscoveryApi {
  readonly configured: boolean;
  leaderboard(
    window: FomoApiWindow,
    limit?: number,
    opts?: { etag?: string | null },
  ): Promise<FomoApiLeaderboardResult>;
  alerts(limit?: number): Promise<FomoApiAlertsResult>;
}

export class DiscoveryService {
  constructor(
    private db: AppDatabase,
    private client: DiscoveryApi,
    private risk: RiskConfig,
  ) {}

  /**
   * Last-run facts for the dashboard pipeline (plan 07): when it ran, what the
   * API said was left, and which channels the run used. All three are written
   * by a real run — nothing here is inferred.
   */
  status(): { lastRunAt: string | null; creditsRemaining: number | null; sources: string[] } {
    const credits = repo.kvGet(this.db, CREDITS_KEY);
    const creditsNum = credits === undefined ? Number.NaN : Number(credits);
    const raw = repo.kvGet(this.db, SOURCES_KEY);
    let sources: string[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) sources = parsed.filter((s): s is string => typeof s === 'string');
      } catch {
        /* unparsable record: report no sources rather than guess */
      }
    }
    return {
      lastRunAt: repo.kvGet(this.db, LAST_RUN_KEY) ?? null,
      creditsRemaining: Number.isFinite(creditsNum) ? creditsNum : null,
      sources,
    };
  }

  /** Current demand inputs: watch/bench counts, roster occupancy, rate limit. */
  demand(nowMs = Date.now()): DiscoveryDemandInput {
    return {
      promotableWatchWallets: repo.listWatchWallets(this.db, 'bench').length,
      watchListWallets: repo.listWatchWallets(this.db, 'watching').length,
      rosterInUse: repo.activeActivationCount(this.db),
      rosterSize: this.risk.ROSTER_SIZE,
      benchTarget: this.risk.BENCH_TARGET,
      lastRunAt: repo.kvGet(this.db, LAST_RUN_KEY) ?? null,
      nowMs,
      minIntervalMs: this.risk.DISCOVERY_MIN_INTERVAL_MS,
    };
  }

  /**
   * Demand-triggered discovery (D5): runs only when the demand rule says so AND
   * the rate limit has elapsed. The timer/callback path calls this; the manual
   * CLI/Ops path calls syncDiscovery(true).
   */
  async syncIfNeeded(): Promise<DiscoveryRunResult> {
    return this.syncDiscovery(false);
  }

  /**
   * One discovery run. `force` is the manual operator path (CLI / Ops button):
   * it bypasses the demand + rate-limit gate, never the configured key.
   */
  async syncDiscovery(force = false): Promise<DiscoveryRunResult> {
    const empty: DiscoveryRunResult = {
      skipped: false,
      reason: '',
      windows: [],
      traders: 0,
      tradersNew: 0,
      tradersUpdated: 0,
      merged: 0,
      alertsAdded: 0,
      alertsSkipped: 0,
      alertsError: null,
      creditsSpent: 0,
      creditsRemaining: null,
    };

    if (!this.client.configured) {
      // Fail closed before any network call: no key, no spend.
      repo.audit(this.db, 'discovery', 'discovery skipped: FOMOAPI_KEY not configured', {});
      return { ...empty, skipped: true, reason: 'FOMOAPI_KEY not configured' };
    }

    const decision = discoveryDecision(this.demand());
    if (!force && !decision.run) {
      repo.audit(this.db, 'discovery', `discovery skipped: ${decision.reason}`, {});
      return { ...empty, skipped: true, reason: decision.reason };
    }

    // Stamp the run BEFORE the network work: a crash mid-run must not let the
    // next boot re-burn credits inside the rate-limit window.
    const startedAt = new Date().toISOString();
    repo.kvSet(this.db, LAST_RUN_KEY, startedAt);

    const windows: DiscoveryWindowResult[] = [];
    const union = new Map<
      string,
      { userId: string; handle: string; pnlUsd: number | null; wallet: string | null }
    >();
    let creditsSpent = 0;
    let creditsRemaining: number | null = null;

    for (const window of WINDOWS) {
      try {
        const result = await this.client.leaderboard(window, 150, {
          etag: repo.kvGet(this.db, etagKey(window)) ?? null,
        });
        creditsSpent += result.creditsCost ?? 0;
        creditsRemaining = result.creditsRemaining ?? creditsRemaining;
        if (result.etag) repo.kvSet(this.db, etagKey(window), result.etag);
        windows.push({
          window,
          ok: true,
          notModified: result.notModified,
          rows: result.rows.length,
          unparsed: result.unparsed,
          creditsCost: result.creditsCost,
          error: null,
        });
        if (result.notModified) continue; // ETag matched: pool left untouched
        for (const row of result.rows) {
          const key = `user:${row.userId}`;
          const prev = union.get(key);
          union.set(
            key,
            prev
              ? { ...prev, pnlUsd: prev.pnlUsd ?? row.pnlUsd, wallet: prev.wallet ?? row.wallet }
              : { ...row },
          );
        }
      } catch (e) {
        // One failing window must never abort the others.
        windows.push({
          window,
          ok: false,
          notModified: false,
          rows: 0,
          unparsed: 0,
          creditsCost: null,
          error: messageOf(e),
        });
      }
    }

    const observedAt = new Date().toISOString();
    let tradersNew = 0;
    let tradersUpdated = 0;
    let merged = 0;
    const mergedInto: Array<{ handle: string; userId: string; candidateId: string }> = [];

    for (const row of union.values()) {
      const byUser = repo.findCandidateByUserId(this.db, row.userId);
      if (byUser) {
        repo.upsertCandidateByUser(this.db, {
          candidateId: byUser.candidateId,
          userId: row.userId,
          handle: row.handle,
          source: 'fomoapi',
          observedAt,
          address: row.wallet,
          pnlUsd: row.pnlUsd,
        });
        tradersUpdated++;
        continue;
      }

      const byWallet = row.wallet ? repo.findCandidateByWallet(this.db, row.wallet) : undefined;
      if (byWallet && byWallet.userId !== null && byWallet.userId !== row.userId) {
        // Same wallet, two user ids: the wallet already owns an identity, so
        // this row is a label alias — never a second candidate (D3 dedupe).
        merged++;
        if (mergedInto.length < MERGE_DETAIL_LIMIT) {
          mergedInto.push({ handle: row.handle, userId: row.userId, candidateId: byWallet.candidateId });
        }
        continue;
      }

      const handleId = repo.candidateIdForHandle(row.handle);
      // Adopt the wallet's legacy row when one exists (same identity, now with
      // a stable user id + current label); otherwise the handle-derived id,
      // which also re-uses a legacy handle-only row instead of duplicating it.
      const target = byWallet ?? repo.getCandidate(this.db, handleId);
      repo.upsertCandidateByUser(this.db, {
        candidateId: target?.candidateId ?? handleId,
        userId: row.userId,
        handle: row.handle,
        source: 'fomoapi',
        observedAt,
        address: row.wallet,
        pnlUsd: row.pnlUsd,
      });
      if (target) tradersUpdated++;
      else tradersNew++;
    }

    // Alerts (best effort): they only discover traders — no wallet, no scan.
    let alertsAdded = 0;
    let alertsSkipped = 0;
    let alertsError: string | null = null;
    try {
      const alerts = await this.client.alerts(50);
      creditsSpent += alerts.creditsCost ?? 0;
      creditsRemaining = alerts.creditsRemaining ?? creditsRemaining;
      alertsSkipped += alerts.unparsed;
      const seen = new Set<string>();
      for (const alert of alerts.alerts) {
        if (alert.userId === null) {
          alertsSkipped++;
          continue;
        }
        if (seen.has(alert.userId)) continue;
        seen.add(alert.userId);
        if (repo.findCandidateByUserId(this.db, alert.userId)) continue;
        repo.upsertCandidateByUser(this.db, {
          candidateId: repo.candidateIdForHandle(alert.handle),
          userId: alert.userId,
          handle: alert.handle,
          source: 'fomoapi-alerts',
          observedAt,
        });
        alertsAdded++;
      }
    } catch (e) {
      alertsError = messageOf(e);
    }

    const boardsLine = windows
      .map(
        (w) =>
          `${w.window}=` +
          (w.ok ? (w.notModified ? 'not-modified' : `${w.rows} rows`) : `failed (${w.error})`),
      )
      .join(', ');
    const failedEveryBoard = windows.length === WINDOWS.length && windows.every((w) => !w.ok);
    // Persist the pipeline-stage facts (plan 07): the channels this run used
    // and the credits the API reported left. Only a real run writes them.
    if (creditsRemaining !== null) repo.kvSet(this.db, CREDITS_KEY, String(creditsRemaining));
    repo.kvSet(
      this.db,
      SOURCES_KEY,
      JSON.stringify([
        ...windows.filter((w) => w.ok).map((w) => w.window),
        ...(alertsError === null ? ['alerts'] : []),
      ]),
    );
    repo.audit(
      this.db,
      'discovery',
      `discovery run${force ? ' (manual)' : ''}: ${boardsLine} · ${union.size} trader(s) · ` +
        `${tradersNew} new, ${tradersUpdated} updated, ${merged} merged · alerts +${alertsAdded}` +
        `${alertsError ? ` (failed: ${alertsError})` : ''} · ${creditsSpent} credit(s) spent` +
        `${creditsRemaining === null ? '' : `, ${creditsRemaining} left`}`,
      {
        windows,
        traders: union.size,
        tradersNew,
        tradersUpdated,
        merged,
        mergedInto,
        alertsAdded,
        alertsSkipped,
        alertsError,
        creditsSpent,
        creditsRemaining,
        forced: force,
        startedAt,
        everyBoardFailed: failedEveryBoard,
      },
    );

    return {
      skipped: false,
      reason: force ? 'manual run' : decision.reason,
      windows,
      traders: union.size,
      tradersNew,
      tradersUpdated,
      merged,
      alertsAdded,
      alertsSkipped,
      alertsError,
      creditsSpent,
      creditsRemaining,
    };
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
