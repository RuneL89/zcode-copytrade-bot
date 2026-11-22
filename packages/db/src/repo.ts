import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { transitionOrder, type OrderIntentState } from '@zcode-bot/core';
import type { AppDatabase } from './connection.js';
import { schema } from './connection.js';

type Db = AppDatabase;
/** The two independent books. A missing filter means "every row" (legacy readers/tests). */
export type BookMode = 'paper' | 'live';

type ActivationInsert = (typeof schema.traderActivations)['$inferInsert'];
type ObservedEventInsert = (typeof schema.observedLeaderEvents)['$inferInsert'];
type PositionInsert = (typeof schema.copiedPositions)['$inferInsert'];
type IntentInsert = (typeof schema.orderIntents)['$inferInsert'];
type AttemptInsert = (typeof schema.executionAttempts)['$inferInsert'];
type FillInsert = (typeof schema.fills)['$inferInsert'];
type PnlLotInsert = (typeof schema.realizedPnlLots)['$inferInsert'];
type StreakEventInsert = (typeof schema.lossStreakEvents)['$inferInsert'];
type FiringEventInsert = (typeof schema.firingEvents)['$inferInsert'];
type RiskRejectionInsert = (typeof schema.riskRejections)['$inferInsert'];
type ReconciliationInsert = (typeof schema.reconciliationCases)['$inferInsert'];
type ProviderHealthInsert = (typeof schema.providerHealth)['$inferInsert'];
type WatchEventInsert = (typeof schema.watchEvents)['$inferInsert'];
type ShadowTradeInsert = (typeof schema.shadowTrades)['$inferInsert'];

const nowIso = () => new Date().toISOString();

// --- kv / app state ----------------------------------------------------------

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.select().from(schema.kv).where(eq(schema.kv.key, key)).get();
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.insert(schema.kv)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.kv.key, set: { value } })
    .run();
}

export function kvDelete(db: Db, key: string): void {
  db.delete(schema.kv).where(eq(schema.kv.key, key)).run();
}

/** Read every kv row whose key starts with `prefix` (exit.queue:* etc.). */
export function listKvByPrefix(db: Db, prefix: string) {
  return db
    .select()
    .from(schema.kv)
    .where(sql`${schema.kv.key} LIKE ${prefix + '%'}`)
    .all();
}

/** Per-candidate admission-scan deferral (an eligibility signal, not freshness). */
export const ADMISSION_DEFER_KEY_PREFIX = 'admission.defer:';
export const ADMISSION_ATTEMPTS_KEY_PREFIX = 'admission.attempts:';

export function admissionDeferKey(candidateId: string): string {
  return `${ADMISSION_DEFER_KEY_PREFIX}${candidateId}`;
}

/** Consecutive "prefix did not prove the gate" scans (drives the defer ladder). */
export function admissionAttemptsKey(candidateId: string): string {
  return `${ADMISSION_ATTEMPTS_KEY_PREFIX}${candidateId}`;
}

// --- audit / control ---------------------------------------------------------

export function audit(db: Db, category: string, message: string, data?: unknown): void {
  db.insert(schema.auditEvents)
    .values({
      category,
      message,
      dataJson: data === undefined ? null : JSON.stringify(data),
      createdAt: nowIso(),
    })
    .run();
}

export function listAudit(db: Db, limit = 200) {
  return db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.id)).limit(limit).all();
}

export function controlEvent(db: Db, type: string, detail?: string, source = 'dashboard'): void {
  db.insert(schema.controlEvents)
    .values({ type, detail: detail ?? null, source, createdAt: nowIso() })
    .run();
}

export function listControlEvents(db: Db, limit = 100) {
  return db.select().from(schema.controlEvents).orderBy(desc(schema.controlEvents.id)).limit(limit).all();
}

// --- candidates / leaderboard -------------------------------------------------

export function upsertCandidate(
  db: Db,
  input: {
    candidateId: string;
    handle: string;
    weeklyRank: number | null;
    displayedWeeklyPnlUsdMicro: string | null;
    profileUrl: string | null;
    avatarUrl: string | null;
    enabled: boolean;
    source: string;
    observedAt: string;
    // Day-trader stats. Omit (undefined) to PRESERVE the stored value; pass an
    // explicit null to clear it. A GUI re-import must never wipe stats that
    // Dawn or Helius captured.
    avgHoldHours?: number | null;
    tradesCount7d?: number | null;
    winRatePct?: number | null;
    realizedOnchainUsd?: number | null;
    statsCheckedAt?: string | null;
    pnl24hUsd?: number | null;
    pnl7dUsd?: number | null;
    pnl30dUsd?: number | null;
    pnlAllTimeUsd?: number | null;
    rank24h?: number | null;
    rank7d?: number | null;
    rankAllTime?: number | null;
    tradesTotal?: number | null;
    volumeUsd?: number | null;
    recentBuys?: number | null;
    recentSells?: number | null;
    coinsTraded?: number | null;
    lastTradeAgeHours?: number | null;
  },
): void {
  const ts = nowIso();
  const statKeys = [
    'avgHoldHours',
    'tradesCount7d',
    'winRatePct',
    'realizedOnchainUsd',
    'statsCheckedAt',
    'pnl24hUsd',
    'pnl7dUsd',
    'pnl30dUsd',
    'pnlAllTimeUsd',
    'rank24h',
    'rank7d',
    'rankAllTime',
    'tradesTotal',
    'volumeUsd',
    'recentBuys',
    'recentSells',
    'coinsTraded',
    'lastTradeAgeHours',
  ] as const;
  const statSet: Record<string, unknown> = {};
  for (const key of statKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) statSet[key] = value;
  }
  db.insert(schema.traderCandidates)
    .values({ ...input, createdAt: ts, updatedAt: ts })
    .onConflictDoUpdate({
      target: schema.traderCandidates.candidateId,
      set: {
        handle: input.handle,
        weeklyRank: input.weeklyRank,
        displayedWeeklyPnlUsdMicro: input.displayedWeeklyPnlUsdMicro,
        profileUrl: input.profileUrl,
        avatarUrl: input.avatarUrl,
        enabled: input.enabled,
        ...statSet,
        observedAt: input.observedAt,
        updatedAt: ts,
      },
    })
    .run();
}

export function upsertCandidateAddress(
  db: Db,
  candidateId: string,
  addr: { chain: string; address: string; verification: string },
): void {
  db.insert(schema.candidateAddresses)
    .values({ candidateId, ...addr, createdAt: nowIso() })
    .onConflictDoNothing()
    .run();
}

export function listCandidates(db: Db) {
  return db.select().from(schema.traderCandidates).all();
}

/**
 * The next candidates for the admission scan: enabled, wallet in hand, not
 * already on the watch list. Wallets whose last reading showed recent funded
 * buys come first (those are the plausible admissions), then whoever has gone
 * longest without a reading, never-measured ahead of everything. The scan is
 * bounded per tick, so it must advance through the pool instead of re-reading
 * its head forever, and it must reach the promising wallets before the tail.
 * `checkedBeforeIso` filters recently measured rows before the limit, so a
 * one-candidate tick cannot be consumed by a fresh head row.
 */
export function listAdmissionScanCandidates(db: Db, limit: number, checkedBeforeIso?: string) {
  const conditions = [
    eq(schema.traderCandidates.enabled, true),
    sql`EXISTS (SELECT 1 FROM ${schema.candidateAddresses} a
         WHERE a.candidate_id = ${schema.traderCandidates.candidateId}
           AND a.chain = 'solana')`,
    sql`NOT EXISTS (SELECT 1 FROM ${schema.watchWallets} w
         WHERE w.candidate_id = ${schema.traderCandidates.candidateId})`,
    sql`NOT EXISTS (SELECT 1 FROM kv d
         WHERE d.key = ${ADMISSION_DEFER_KEY_PREFIX} || ${schema.traderCandidates.candidateId}
           AND datetime(d.value) > datetime('now'))`,
  ];
  if (checkedBeforeIso) {
    conditions.push(
      sql`(${schema.traderCandidates.activityCheckedAt} IS NULL
           OR ${schema.traderCandidates.activityCheckedAt} < ${checkedBeforeIso})`,
    );
  }
  return db
    .select()
    .from(schema.traderCandidates)
    .where(and(...conditions))
    .orderBy(
      sql`CASE WHEN ${schema.traderCandidates.buys24h} >= 1
                 AND ${schema.traderCandidates.lastBuyAt} IS NOT NULL
                 AND ${schema.traderCandidates.lastBuyAt} >= datetime('now', '-24 hours')
               THEN 0 ELSE 1 END`,
      sql`${schema.traderCandidates.activityCheckedAt} IS NULL DESC`,
      schema.traderCandidates.activityCheckedAt,
    )
    .limit(limit)
    .all();
}

/** Everything Dawn's compact card can report about a candidate. */
export interface CandidateStatsPatch {
  winRatePct?: number | null;
  realizedOnchainUsd?: number | null;
  pnl24hUsd?: number | null;
  pnl7dUsd?: number | null;
  pnl30dUsd?: number | null;
  pnlAllTimeUsd?: number | null;
  rank24h?: number | null;
  rank7d?: number | null;
  rankAllTime?: number | null;
  tradesTotal?: number | null;
  volumeUsd?: number | null;
  recentBuys?: number | null;
  recentSells?: number | null;
  coinsTraded?: number | null;
  lastTradeAgeHours?: number | null;
  checkedAt: string;
}

/**
 * Refresh the Dawn-captured stats. Non-null values only: a reply that omits a
 * field (e.g. the compact card never carries realized/win) must not erase a
 * richer earlier reading. checkedAt always advances as freshness evidence.
 */
export function updateCandidateStats(db: Db, candidateId: string, stats: CandidateStatsPatch): void {
  const patch: Record<string, unknown> = {
    statsCheckedAt: stats.checkedAt,
    updatedAt: stats.checkedAt,
  };
  for (const [key, value] of Object.entries(stats)) {
    if (key === 'checkedAt') continue;
    if (value !== undefined && value !== null) patch[key] = value;
  }
  db.update(schema.traderCandidates)
    .set(patch)
    .where(eq(schema.traderCandidates.candidateId, candidateId))
    .run();
}

/**
 * Store copyable on-chain activity (operator decision, 2026-11-01). The column
 * names are historical; their meanings are now:
 *   swaps_24h    -> copyable coin movements in 24h (entry or exit)
 *   buys_24h     -> attributable coin ENTRIES (his balance of a coin rose)
 *   sells_24h    -> attributable coin EXITS (his balance fell)
 *   last_buy_at  -> newest entry — drives "actively buying" at hire time
 *   last_swap_at -> newest copyable trade — drives the quiet/stall clock
 * Rows written before the cutover are not comparable; the cutover is recorded
 * by the audit line "activity semantics: copyable-trade v2".
 * `status: 'ok'` means the columns are a current, successful measurement; a
 * failed check never reaches this writer (see markCandidateActivityFailed), so
 * a failed refresh can no longer erase a good reading.
 */
export function updateCandidateActivity(
  db: Db,
  candidateId: string,
  activity: {
    swaps24h: number;
    lastSwapAt: string | null;
    lastBuyAt: string | null;
    buys24h: number | null;
    sells24h: number | null;
    status: 'ok' | 'partial';
    checkedAt: string;
  },
): void {
  db.update(schema.traderCandidates)
    .set({
      swaps24h: activity.swaps24h,
      lastSwapAt: activity.lastSwapAt,
      lastBuyAt: activity.lastBuyAt,
      buys24h: activity.buys24h,
      sells24h: activity.sells24h,
      activityCheckStatus: activity.status,
      activityCheckedAt: activity.checkedAt,
      updatedAt: activity.checkedAt,
    })
    .where(eq(schema.traderCandidates.candidateId, candidateId))
    .run();
  kvDelete(db, admissionDeferKey(candidateId));
  // A recorded reading (ok census or a proven partial) also clears the
  // consecutive-failure count behind the admission defer ladder.
  kvDelete(db, admissionAttemptsKey(candidateId));
}

/**
 * Record a failed activity check WITHOUT touching the activity columns or the
 * freshness stamp: the previous reading stays usable (with status 'failed' the
 * snapshot degrades activelyTrading to unknown), and an un-advanced
 * activity_checked_at keeps the candidate first in line for the next refresh.
 * Deterministic incomplete scans use deferCandidateActivity instead.
 */
export function markCandidateActivityFailed(db: Db, candidateId: string, checkedAt: string): void {
  db.update(schema.traderCandidates)
    .set({ activityCheckStatus: 'failed', updatedAt: checkedAt })
    .where(eq(schema.traderCandidates.candidateId, candidateId))
    .run();
}

/**
 * Record a deterministic incomplete scan (overflow/coverage cap) and move the
 * candidate behind its peers until `untilIso`. Activity columns and
 * `activity_checked_at` are untouched: this is a scan-eligibility deferral,
 * not a successful reading. `updateCandidateActivity` clears it on success.
 */
export function deferCandidateActivity(
  db: Db,
  candidateId: string,
  untilIso: string,
  attemptedAt: string,
): void {
  markCandidateActivityFailed(db, candidateId, attemptedAt);
  kvSet(db, admissionDeferKey(candidateId), untilIso);
}

/**
 * Promote an address to 'verified'. Inserts use onConflictDoNothing, so this
 * is the only path that can upgrade an existing 'reported' row.
 */
export function upgradeCandidateAddressVerification(
  db: Db,
  candidateId: string,
  chain: string,
  address: string,
): void {
  db.update(schema.candidateAddresses)
    .set({ verification: 'verified' })
    .where(
      and(
        eq(schema.candidateAddresses.candidateId, candidateId),
        eq(schema.candidateAddresses.chain, chain),
        eq(schema.candidateAddresses.address, address),
      ),
    )
    .run();
}

export function getCandidate(db: Db, candidateId: string) {
  return db
    .select()
    .from(schema.traderCandidates)
    .where(eq(schema.traderCandidates.candidateId, candidateId))
    .get();
}

/** Candidate by the fomoapi stable user id (D3 identity). */
export function findCandidateByUserId(db: Db, userId: string) {
  return db.select().from(schema.traderCandidates).where(eq(schema.traderCandidates.userId, userId)).get();
}

/**
 * Deterministic candidate id for a handle. Handles are labels (D3), so this is
 * only the *first* key of a row: an existing row keeps its id and a known
 * user id wins over the handle-derived one (see upsertCandidateByUser). It
 * also lets a legacy handle-only row merge with its API row instead of
 * duplicating it.
 */
export function candidateIdForHandle(handle: string): string {
  return (
    'cand_' +
    handle
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
  );
}

/**
 * Candidate owning a Solana wallet. One address can sit under two handles
 * (D2 evidence: `okura`/`okuracrypto`), so the lowest candidate_id wins — the
 * stable answer for dedupe; the caller may still see duplicates.
 */
export function findCandidateByWallet(db: Db, address: string) {
  const row = db
    .select({ candidateId: schema.candidateAddresses.candidateId })
    .from(schema.candidateAddresses)
    .where(and(eq(schema.candidateAddresses.chain, 'solana'), eq(schema.candidateAddresses.address, address)))
    .orderBy(schema.candidateAddresses.candidateId)
    .limit(1)
    .get();
  return row ? getCandidate(db, row.candidateId) : undefined;
}

/**
 * Upsert a candidate keyed on the fomoapi `userId` (D3): handles change, the
 * user id does not. The surviving candidate_id is returned so callers key
 * their own rows on it; an existing user row keeps its original id and only
 * gets the fresh handle / address / observation time.
 */
export function upsertCandidateByUser(
  db: Db,
  input: {
    candidateId: string;
    userId: string;
    handle: string;
    source: string;
    observedAt: string;
    address?: string | null;
    /** Window PnL in USD as displayed by the API — context only (never a hire gate). */
    pnlUsd?: number | null;
  },
): string {
  const ts = nowIso();
  const existing = findCandidateByUserId(db, input.userId);
  const candidateId = existing?.candidateId ?? input.candidateId;
  const displayedPnlUsdMicro =
    input.pnlUsd === null || input.pnlUsd === undefined ? null : String(Math.trunc(input.pnlUsd * 1e6));
  db.insert(schema.traderCandidates)
    .values({
      candidateId,
      handle: input.handle,
      userId: input.userId,
      weeklyRank: null,
      displayedWeeklyPnlUsdMicro: displayedPnlUsdMicro,
      profileUrl: null,
      avatarUrl: null,
      enabled: true,
      source: input.source,
      observedAt: input.observedAt,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: schema.traderCandidates.candidateId,
      set: {
        userId: input.userId,
        handle: input.handle,
        // A window PnL reading only overwrites the stored value when this row
        // carries one: an alerts-only upsert must not erase a board reading.
        ...(displayedPnlUsdMicro === null ? {} : { displayedWeeklyPnlUsdMicro: displayedPnlUsdMicro }),
        observedAt: input.observedAt,
        updatedAt: ts,
      },
    })
    .run();
  if (input.address) {
    upsertCandidateAddress(db, candidateId, {
      chain: 'solana',
      address: input.address,
      verification: 'reported',
    });
  }
  return candidateId;
}

export function listCandidateAddresses(db: Db, candidateId?: string) {
  const q = db.select().from(schema.candidateAddresses);
  return candidateId ? q.where(eq(schema.candidateAddresses.candidateId, candidateId)).all() : q.all();
}

export function recordLeaderboardObservation(
  db: Db,
  input: {
    handle: string;
    weeklyRank: number | null;
    displayedPnlUsdMicro: string | null;
    source: string;
    observedAt: string;
    importId?: string;
  },
): void {
  db.insert(schema.leaderboardObservations)
    .values({ ...input, importId: input.importId ?? null })
    .run();
}

/** One captured board scan: all rows sharing an observed_at timestamp. */
export interface BoardScanRows {
  observedAt: string;
  rows: Array<{ handle: string; rank: number | null; displayedPnlUsdMicro: string | null }>;
}

/** The `limit` most recent scans, newest first (one scan = one observed_at group). */
export function listRecentScans(db: Db, limit = 5): BoardScanRows[] {
  const rows = db
    .select({
      handle: schema.leaderboardObservations.handle,
      weeklyRank: schema.leaderboardObservations.weeklyRank,
      displayedPnlUsdMicro: schema.leaderboardObservations.displayedPnlUsdMicro,
      observedAt: schema.leaderboardObservations.observedAt,
    })
    .from(schema.leaderboardObservations)
    .orderBy(desc(schema.leaderboardObservations.observedAt))
    .all();
  const scans: BoardScanRows[] = [];
  for (const row of rows) {
    const last = scans[scans.length - 1];
    if (last && last.observedAt === row.observedAt) {
      last.rows.push({
        handle: row.handle,
        rank: row.weeklyRank,
        displayedPnlUsdMicro: row.displayedPnlUsdMicro,
      });
    } else {
      if (scans.length >= limit) break;
      scans.push({
        observedAt: row.observedAt,
        rows: [{ handle: row.handle, rank: row.weeklyRank, displayedPnlUsdMicro: row.displayedPnlUsdMicro }],
      });
    }
  }
  return scans;
}

/** Delete scans older than the retention window; returns the rows removed. */
export function pruneLeaderboardObservations(db: Db, keepDays = 30): number {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .delete(schema.leaderboardObservations)
    .where(sql`${schema.leaderboardObservations.observedAt} < ${cutoff}`)
    .run();
  return result.changes;
}

export function recordCandidateRejection(
  db: Db,
  input: { recommendationId: string | null; candidateId: string; reason: string; detail?: string },
): void {
  db.insert(schema.candidateRejections)
    .values({ ...input, detail: input.detail ?? null, createdAt: nowIso() })
    .run();
}

/** Most recent rejection per row, newest first — the promotion/hire audit trail. */
export function listCandidateRejections(db: Db, limit = 20) {
  return db
    .select()
    .from(schema.candidateRejections)
    .orderBy(desc(schema.candidateRejections.createdAt))
    .limit(limit)
    .all();
}

// --- activations / cursors / events ---------------------------------------------

export function createActivation(db: Db, input: ActivationInsert): void {
  db.insert(schema.traderActivations).values(input).run();
}

export function updateActivation(db: Db, activationId: string, patch: Partial<ActivationInsert>): void {
  db.update(schema.traderActivations)
    .set({ ...patch })
    .where(eq(schema.traderActivations.activationId, activationId))
    .run();
}

export function getActivation(db: Db, activationId: string) {
  return db
    .select()
    .from(schema.traderActivations)
    .where(eq(schema.traderActivations.activationId, activationId))
    .get();
}

const CHAIR_STATES = ['ACTIVE', 'FIRING', 'REQUIRES_RECONCILIATION'] as const;

export function activeActivation(db: Db, mode?: BookMode) {
  const conditions = [inArray(schema.traderActivations.state, [...CHAIR_STATES])];
  if (mode) conditions.push(eq(schema.traderActivations.mode, mode));
  return db
    .select()
    .from(schema.traderActivations)
    .where(and(...conditions))
    .orderBy(desc(schema.traderActivations.startedAt))
    .limit(1)
    .get();
}

export function listActivations(db: Db, limit = 50, mode?: BookMode) {
  const q = db.select().from(schema.traderActivations);
  return (mode ? q.where(eq(schema.traderActivations.mode, mode)) : q)
    .orderBy(desc(schema.traderActivations.startedAt))
    .limit(limit)
    .all();
}

/** Every activation that still owns a roster chair (D4: roster of N, not one). */
export function listActiveActivations(db: Db, mode?: BookMode) {
  const conditions = [inArray(schema.traderActivations.state, [...CHAIR_STATES])];
  if (mode) conditions.push(eq(schema.traderActivations.mode, mode));
  return db
    .select()
    .from(schema.traderActivations)
    .where(and(...conditions))
    .orderBy(schema.traderActivations.startedAt)
    .all();
}

export function activeActivationCount(db: Db, mode?: BookMode): number {
  const conditions = [inArray(schema.traderActivations.state, [...CHAIR_STATES])];
  if (mode) conditions.push(eq(schema.traderActivations.mode, mode));
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.traderActivations)
    .where(and(...conditions))
    .get();
  return row?.n ?? 0;
}

/** Free roster chairs for a configured roster size (D4: a roster of N leaders). */
export function freeRosterSlots(db: Db, rosterSize: number, mode?: BookMode): number {
  return Math.max(0, rosterSize - activeActivationCount(db, mode));
}

export function getCursor(db: Db, address: string) {
  return db.select().from(schema.leaderCursors).where(eq(schema.leaderCursors.address, address)).get();
}

export function setCursor(
  db: Db,
  input: {
    address: string;
    chain: string;
    activationId: string;
    lastSignature: string;
    lastSlot: number;
    lastTransactionIndex: number;
    lastBlockTime: number | null;
  },
): void {
  const ts = nowIso();
  db.insert(schema.leaderCursors)
    .values({ ...input, updatedAt: ts })
    .onConflictDoUpdate({ target: schema.leaderCursors.address, set: { ...input, updatedAt: ts } })
    .run();
}

export function insertObservedEvent(db: Db, input: ObservedEventInsert): boolean {
  const mode =
    input.mode ?? (input.activationId ? (getActivation(db, input.activationId)?.mode ?? 'paper') : 'paper');
  const res = db
    .insert(schema.observedLeaderEvents)
    .values({ ...input, mode })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export function listObservedEvents(db: Db, activationId?: string, limit = 100, mode?: BookMode) {
  const conditions = [];
  if (activationId) conditions.push(eq(schema.observedLeaderEvents.activationId, activationId));
  if (mode) conditions.push(eq(schema.observedLeaderEvents.mode, mode));
  const q = db.select().from(schema.observedLeaderEvents);
  return (conditions.length > 0 ? q.where(and(...conditions)) : q)
    .orderBy(desc(schema.observedLeaderEvents.id))
    .limit(limit)
    .all();
}

// --- positions / intents / fills -------------------------------------------------

export function insertPosition(db: Db, input: PositionInsert): void {
  db.insert(schema.copiedPositions).values(input).run();
}

export function updatePosition(db: Db, positionId: string, patch: Partial<PositionInsert>): void {
  db.update(schema.copiedPositions).set(patch).where(eq(schema.copiedPositions.positionId, positionId)).run();
}

export function getPosition(db: Db, positionId: string) {
  return db
    .select()
    .from(schema.copiedPositions)
    .where(eq(schema.copiedPositions.positionId, positionId))
    .get();
}

export function openPositions(db: Db, mode?: BookMode) {
  const conditions = [inArray(schema.copiedPositions.status, ['open', 'partially_closed'])];
  if (mode) conditions.push(eq(schema.copiedPositions.mode, mode));
  return db
    .select()
    .from(schema.copiedPositions)
    .where(and(...conditions))
    .all();
}

/**
 * Exposure that consumes budget: live/partially-closed plus frozen
 * reconciliation lots. The engine and withdrawals must count these; the
 * dashboard shows them too.
 */
export function exposurePositions(db: Db, mode?: BookMode) {
  const conditions = [
    inArray(schema.copiedPositions.status, ['open', 'partially_closed', 'requires_reconciliation']),
  ];
  if (mode) conditions.push(eq(schema.copiedPositions.mode, mode));
  return db
    .select()
    .from(schema.copiedPositions)
    .where(and(...conditions))
    .all();
}

export function openPositionForMint(db: Db, candidateId: string, mint: string, mode?: BookMode) {
  const conditions = [
    eq(schema.copiedPositions.candidateId, candidateId),
    eq(schema.copiedPositions.mint, mint),
    inArray(schema.copiedPositions.status, ['open', 'partially_closed']),
  ];
  if (mode) conditions.push(eq(schema.copiedPositions.mode, mode));
  return db
    .select()
    .from(schema.copiedPositions)
    .where(and(...conditions))
    .limit(1)
    .get();
}

export function listPositions(db: Db, limit = 200, mode?: BookMode) {
  const q = db.select().from(schema.copiedPositions);
  return (mode ? q.where(eq(schema.copiedPositions.mode, mode)) : q)
    .orderBy(desc(schema.copiedPositions.openedAt))
    .limit(limit)
    .all();
}

export function insertIntent(db: Db, input: IntentInsert): void {
  db.insert(schema.orderIntents).values(input).run();
}

export function updateIntent(db: Db, intentId: string, patch: Partial<IntentInsert>): void {
  db.update(schema.orderIntents)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(schema.orderIntents.intentId, intentId))
    .run();
}

export function getIntent(db: Db, intentId: string) {
  return db.select().from(schema.orderIntents).where(eq(schema.orderIntents.intentId, intentId)).get();
}

export function intentsInStates(db: Db, states: string[], mode?: BookMode) {
  const conditions = [inArray(schema.orderIntents.state, states)];
  if (mode) conditions.push(eq(schema.orderIntents.mode, mode));
  return db
    .select()
    .from(schema.orderIntents)
    .where(and(...conditions))
    .all();
}

/**
 * Enforced intent transition. Every write that changes state goes through
 * here so the guarded map in @zcode-bot/core is the only authority. Paper
 * simulation may go quoted -> confirmed; live execution must walk
 * pending_sign -> signed -> submitted.
 */
export function transitionIntent(
  db: Db,
  intentId: string,
  to: OrderIntentState,
  patch: Partial<IntentInsert> = {},
): void {
  const current = getIntent(db, intentId);
  if (!current) throw new Error(`intent not found: ${intentId}`);
  transitionOrder(current.state as OrderIntentState, to);
  db.update(schema.orderIntents)
    .set({ ...patch, state: to, updatedAt: nowIso() })
    .where(eq(schema.orderIntents.intentId, intentId))
    .run();
}

/**
 * Reconciliation-only transition: requires chain evidence. The caller has
 * already checked signature status / token deltas.
 */
export function resolveIntentWithEvidence(
  db: Db,
  intentId: string,
  to: 'confirmed' | 'failed',
  patch: Partial<IntentInsert> = {},
): void {
  const current = getIntent(db, intentId);
  if (!current) throw new Error(`intent not found: ${intentId}`);
  if (current.state !== 'requires_reconciliation') {
    throw new Error(`intent ${intentId} is ${current.state}, not requires_reconciliation`);
  }
  db.update(schema.orderIntents)
    .set({ ...patch, state: to, updatedAt: nowIso() })
    .where(eq(schema.orderIntents.intentId, intentId))
    .run();
}

/** Entry intents that still hold budget (pre-fill or signed-but-unresolved). */
export function pendingEntryIntents(db: Db, mode?: BookMode) {
  const conditions = [
    eq(schema.orderIntents.kind, 'entry'),
    inArray(schema.orderIntents.state, ['pending_quote', 'quoted', 'pending_sign', 'signed', 'submitted']),
  ];
  if (mode) conditions.push(eq(schema.orderIntents.mode, mode));
  return db
    .select()
    .from(schema.orderIntents)
    .where(and(...conditions))
    .all();
}

/** Unknown entry intents with no position yet: treat their notional as exposure. */
export function unresolvedEntryIntents(db: Db, mode?: BookMode) {
  const conditions = [
    eq(schema.orderIntents.kind, 'entry'),
    eq(schema.orderIntents.state, 'requires_reconciliation'),
    isNull(schema.orderIntents.positionId),
  ];
  if (mode) conditions.push(eq(schema.orderIntents.mode, mode));
  return db
    .select()
    .from(schema.orderIntents)
    .where(and(...conditions))
    .all();
}

/**
 * Intents whose transaction bytes exist and may have reached the chain:
 * signed, submitted, or already routed to reconciliation with a signature.
 * Everything with no signature is provably unsent and is not included.
 */
export function signedIntents(db: Db, mode?: BookMode) {
  const conditions = [
    inArray(schema.orderIntents.state, ['signed', 'submitted', 'requires_reconciliation']),
    isNotNullSignature(),
  ];
  if (mode) conditions.push(eq(schema.orderIntents.mode, mode));
  return db
    .select()
    .from(schema.orderIntents)
    .where(and(...conditions))
    .all();
}

function isNotNullSignature() {
  return sql`${schema.orderIntents.txSignature} IS NOT NULL`;
}

/**
 * Pre-sign intents left by a crash. The new writer persists `signed` before
 * the send, so a stale quoted/pending_sign row is provably unsent.
 */
export function stalePreSignIntents(db: Db, beforeIso: string, mode?: BookMode) {
  const conditions = [
    inArray(schema.orderIntents.state, ['pending_quote', 'quoted', 'pending_sign']),
    lte(schema.orderIntents.updatedAt, beforeIso),
  ];
  if (mode) conditions.push(eq(schema.orderIntents.mode, mode));
  return db
    .select()
    .from(schema.orderIntents)
    .where(and(...conditions))
    .all();
}

export function openCasesWithSignature(db: Db, mode?: BookMode) {
  const conditions = [
    eq(schema.reconciliationCases.status, 'open'),
    sql`${schema.reconciliationCases.signature} IS NOT NULL`,
  ];
  if (mode) conditions.push(eq(schema.reconciliationCases.mode, mode));
  return db
    .select()
    .from(schema.reconciliationCases)
    .where(and(...conditions))
    .all();
}

export function openReconciliationCaseForActivation(db: Db, activationId: string) {
  for (const c of openReconciliationCases(db)) {
    if (c.intentId) {
      const intent = getIntent(db, c.intentId);
      if (intent?.activationId === activationId) return c;
    }
    if (c.positionId) {
      const position = getPosition(db, c.positionId);
      if (position?.activationId === activationId) return c;
    }
  }
  return undefined;
}

/** One fill per intent: reconciliation and normal execution share this guard. */
export function insertFillIfAbsent(db: Db, input: FillInsert): boolean {
  const existing = db
    .select({ fillId: schema.fills.fillId })
    .from(schema.fills)
    .where(eq(schema.fills.intentId, input.intentId))
    .get();
  if (existing) return false;
  db.insert(schema.fills).values(input).run();
  return true;
}

/**
 * Newest failed exit intent for a position that provably never reached the
 * chain. Used to resolve a legacy exit.queue row written before the queue
 * carried its own plan metadata.
 */
export function latestFailedExitIntent(db: Db, positionId: string) {
  return db
    .select()
    .from(schema.orderIntents)
    .where(
      and(
        eq(schema.orderIntents.positionId, positionId),
        inArray(schema.orderIntents.kind, ['exit', 'fire_close']),
        eq(schema.orderIntents.state, 'failed'),
        isNull(schema.orderIntents.txSignature),
      ),
    )
    .orderBy(desc(schema.orderIntents.createdAt))
    .limit(1)
    .get();
}

export function pendingUnsignedIntentsForActivation(db: Db, activationId: string) {
  return db
    .select()
    .from(schema.orderIntents)
    .where(
      and(
        eq(schema.orderIntents.activationId, activationId),
        inArray(schema.orderIntents.state, ['pending_quote', 'quoted', 'pending_sign']),
      ),
    )
    .all();
}

/** Confirmed entry intents for one position, oldest first (the buy history). */
export function listEntryIntentsForPosition(db: Db, positionId: string) {
  return db
    .select()
    .from(schema.orderIntents)
    .where(
      and(
        eq(schema.orderIntents.positionId, positionId),
        eq(schema.orderIntents.kind, 'entry'),
        eq(schema.orderIntents.state, 'confirmed'),
      ),
    )
    .orderBy(schema.orderIntents.createdAt)
    .all();
}

/** Fills for a set of intents (one buy can split across partial fills). */
export function listFillsForIntents(db: Db, intentIds: string[]) {
  if (intentIds.length === 0) return [];
  return db.select().from(schema.fills).where(inArray(schema.fills.intentId, intentIds)).all();
}

export function recordAttempt(db: Db, input: AttemptInsert): void {
  db.insert(schema.executionAttempts).values(input).run();
}

export function insertFill(db: Db, input: FillInsert): void {
  db.insert(schema.fills).values(input).run();
}

export function listFills(db: Db, limit = 200, mode?: BookMode) {
  const q = db.select().from(schema.fills);
  return (mode ? q.where(eq(schema.fills.mode, mode)) : q)
    .orderBy(desc(schema.fills.confirmedAt))
    .limit(limit)
    .all();
}

export function insertPnlLot(db: Db, input: PnlLotInsert): void {
  db.insert(schema.realizedPnlLots).values(input).run();
}

export function listPnlLots(db: Db, limit = 500, mode?: BookMode) {
  const q = db.select().from(schema.realizedPnlLots);
  return (mode ? q.where(eq(schema.realizedPnlLots.mode, mode)) : q)
    .orderBy(desc(schema.realizedPnlLots.closedAt))
    .limit(limit)
    .all();
}

export function realizedPnlSince(db: Db, sinceIso: string, mode?: BookMode): bigint {
  const conditions = [gte(schema.realizedPnlLots.closedAt, sinceIso)];
  if (mode) conditions.push(eq(schema.realizedPnlLots.mode, mode));
  const rows = db
    .select({
      total: sql<string | null>`coalesce(sum(cast(${schema.realizedPnlLots.pnlUsdMicro} as integer)), 0)`,
    })
    .from(schema.realizedPnlLots)
    .where(and(...conditions))
    .all();
  return BigInt(rows[0]?.total ?? '0');
}

export function tradesSince(db: Db, sinceIso: string): number {
  const rows = db
    .select({ count: sql<string>`count(*)` })
    .from(schema.orderIntents)
    .where(
      and(gte(schema.orderIntents.createdAt, sinceIso), inArray(schema.orderIntents.state, ['confirmed'])),
    )
    .all();
  return Number(rows[0]?.count ?? '0');
}

// --- streak / firing / handoff -------------------------------------------------

export function insertStreakEvent(db: Db, input: StreakEventInsert): void {
  db.insert(schema.lossStreakEvents).values(input).run();
}

export function listStreakEvents(db: Db, activationId: string) {
  return db
    .select()
    .from(schema.lossStreakEvents)
    .where(eq(schema.lossStreakEvents.activationId, activationId))
    .orderBy(schema.lossStreakEvents.id)
    .all();
}

export function insertFiringEvent(db: Db, input: FiringEventInsert): void {
  db.insert(schema.firingEvents).values(input).run();
}

export function updateFiringEvent(db: Db, id: number, patch: Partial<FiringEventInsert>): void {
  db.update(schema.firingEvents).set(patch).where(eq(schema.firingEvents.id, id)).run();
}

/** Most recent firing row for an activation (handoff bookkeeping). */
export function latestFiringEventForActivation(db: Db, activationId: string) {
  return db
    .select()
    .from(schema.firingEvents)
    .where(eq(schema.firingEvents.activationId, activationId))
    .orderBy(desc(schema.firingEvents.id))
    .limit(1)
    .get();
}

/** The newest firings (the dashboard's fired lane), newest first. */
export function listRecentFirings(db: Db, limit = 5, mode?: BookMode) {
  const q = db.select().from(schema.firingEvents);
  return (mode ? q.where(eq(schema.firingEvents.mode, mode)) : q)
    .orderBy(desc(schema.firingEvents.firedAt))
    .limit(limit)
    .all();
}

/** Firings inside the window (the dashboard pipeline's exits stage). */
export function listFiringEventsSince(db: Db, sinceIso: string, mode?: BookMode) {
  const conditions = [gte(schema.firingEvents.firedAt, sinceIso)];
  if (mode) conditions.push(eq(schema.firingEvents.mode, mode));
  return db
    .select()
    .from(schema.firingEvents)
    .where(and(...conditions))
    .all();
}

/**
 * When this candidate was last fired, or null when never fired. This is the
 * D4 re-entry clock: the block lifts on a later hire of another trader, or
 * after the cooldown while a roster chair is free.
 */
export function lastFiredAt(db: Db, candidateId: string, mode?: BookMode): string | null {
  const conditions = [eq(schema.firingEvents.candidateId, candidateId)];
  if (mode) conditions.push(eq(schema.firingEvents.mode, mode));
  const row = db
    .select({ firedAt: schema.firingEvents.firedAt })
    .from(schema.firingEvents)
    .where(and(...conditions))
    .orderBy(desc(schema.firingEvents.firedAt))
    .limit(1)
    .get();
  return row?.firedAt ?? null;
}

/**
 * True when a trader other than `excludeCandidateId` was activated strictly
 * after `firedAtIso` — the event that lifts a fired trader's re-entry block.
 * Source and chair do not matter, with one exception: the hand-off hire that
 * replaced the firing itself (`replacesActivationId` = the fired activation)
 * does not lift that fired trader's block. A later independent hire still does.
 */
export function hasHireSince(
  db: Db,
  firedAtIso: string,
  excludeCandidateId: string,
  mode?: BookMode,
): boolean {
  // The firing this block belongs to: the newest firing event for the candidate.
  const firingConditions = [eq(schema.firingEvents.candidateId, excludeCandidateId)];
  if (mode) firingConditions.push(eq(schema.firingEvents.mode, mode));
  const lastFiring = db
    .select({ activationId: schema.firingEvents.activationId })
    .from(schema.firingEvents)
    .where(and(...firingConditions))
    .orderBy(desc(schema.firingEvents.firedAt), desc(schema.firingEvents.id))
    .limit(1)
    .get();
  const conditions = [
    gt(schema.traderActivations.startedAt, firedAtIso),
    ne(schema.traderActivations.candidateId, excludeCandidateId),
  ];
  if (mode) conditions.push(eq(schema.traderActivations.mode, mode));
  if (lastFiring) {
    conditions.push(
      or(
        isNull(schema.traderActivations.replacesActivationId),
        ne(schema.traderActivations.replacesActivationId, lastFiring.activationId),
      )!,
    );
  }
  const row = db
    .select({ activationId: schema.traderActivations.activationId })
    .from(schema.traderActivations)
    .where(and(...conditions))
    .limit(1)
    .get();
  return row !== undefined;
}

// --- watch list / shadow ledger (D3/D4) ----------------------------------------

export interface WatchWalletUpsert {
  candidateId: string;
  userId?: string | null;
  address: string;
  status: string; // watching|cooling|bench|hired|archived
  reason?: string | null;
  admittedAt?: string;
}

/**
 * Admit (or re-admit) a wallet to the watch list. The row's original
 * `admitted_at` survives a re-upsert — it is the admission clock, and the
 * funded-buy/sell stamps are owned by the event path, never reset here.
 */
export function upsertWatchWallet(db: Db, input: WatchWalletUpsert): void {
  const ts = nowIso();
  db.insert(schema.watchWallets)
    .values({
      candidateId: input.candidateId,
      userId: input.userId ?? null,
      address: input.address,
      status: input.status,
      admittedAt: input.admittedAt ?? ts,
      updatedAt: ts,
      reason: input.reason ?? null,
    })
    .onConflictDoUpdate({
      target: schema.watchWallets.candidateId,
      set: {
        userId: input.userId ?? null,
        address: input.address,
        status: input.status,
        reason: input.reason ?? null,
        updatedAt: ts,
      },
    })
    .run();
}

export function getWatchWallet(db: Db, candidateId: string) {
  return db.select().from(schema.watchWallets).where(eq(schema.watchWallets.candidateId, candidateId)).get();
}

export function listWatchWallets(db: Db, status?: string) {
  const q = db.select().from(schema.watchWallets);
  return (status ? q.where(eq(schema.watchWallets.status, status)) : q)
    .orderBy(schema.watchWallets.admittedAt, schema.watchWallets.candidateId)
    .all();
}

export function setWatchStatus(db: Db, candidateId: string, status: string, reason?: string | null): void {
  db.update(schema.watchWallets)
    .set({ status, reason: reason ?? null, updatedAt: nowIso() })
    .where(eq(schema.watchWallets.candidateId, candidateId))
    .run();
}

/**
 * Record a funded swap. Idempotent on (candidate, signature, side): a
 * re-scanned signature inserts nothing and returns false. On a fresh insert
 * the denormalised last-funded stamp on `watch_wallets` advances to the
 * leader's ON-CHAIN block time (not our ingestion time) — monotonic, so an
 * older re-observation can never move it backwards. An event without a usable
 * block time never advances the stamp: the recency gate fails closed rather
 * than reading an old buy as fresh.
 */
export function insertWatchEvent(db: Db, input: WatchEventInsert): boolean {
  const res = db.insert(schema.watchEvents).values(input).onConflictDoNothing().run();
  if (res.changes === 0) return false;
  if (input.blockTime > 0) {
    const stampAt = new Date(input.blockTime * 1000).toISOString();
    const stamp =
      input.side === 'buy'
        ? { lastFundedBuyAt: stampAt, updatedAt: nowIso() }
        : { lastFundedSellAt: stampAt, updatedAt: nowIso() };
    const stampColumn =
      input.side === 'buy' ? schema.watchWallets.lastFundedBuyAt : schema.watchWallets.lastFundedSellAt;
    db.update(schema.watchWallets)
      .set(stamp)
      .where(
        and(
          eq(schema.watchWallets.candidateId, input.candidateId),
          sql`(${stampColumn} is null or ${stampColumn} < ${stampAt})`,
        ),
      )
      .run();
  }
  return true;
}

export function listWatchEvents(db: Db, candidateId: string, limit = 100) {
  return db
    .select()
    .from(schema.watchEvents)
    .where(eq(schema.watchEvents.candidateId, candidateId))
    .orderBy(desc(schema.watchEvents.id))
    .limit(limit)
    .all();
}

/** Newest funded buy by the leader's on-chain block time, or null when none exists. */
export function lastFundedBuyAt(db: Db, candidateId: string): string | null {
  return newestWatchEventAt(db, candidateId, 'buy');
}

/** Newest funded sell by the leader's on-chain block time, or null when none exists. */
export function lastFundedSellAt(db: Db, candidateId: string): string | null {
  return newestWatchEventAt(db, candidateId, 'sell');
}

function newestWatchEventAt(db: Db, candidateId: string, side: string): string | null {
  const row = db
    .select({ blockTime: schema.watchEvents.blockTime })
    .from(schema.watchEvents)
    .where(
      and(
        eq(schema.watchEvents.candidateId, candidateId),
        eq(schema.watchEvents.side, side),
        gt(schema.watchEvents.blockTime, 0),
      ),
    )
    .orderBy(desc(schema.watchEvents.blockTime), desc(schema.watchEvents.observedAt))
    .limit(1)
    .get();
  return row ? new Date(row.blockTime * 1000).toISOString() : null;
}

/**
 * Drop one candidate's whole watch record (events, lots, cursor). The test-only
 * seed route uses it so a re-seed in the same data dir is deterministic; it is
 * never called by the runtime.
 */
export function resetWatchRecord(db: Db, candidateId: string): void {
  db.delete(schema.watchEvents).where(eq(schema.watchEvents.candidateId, candidateId)).run();
  db.delete(schema.shadowTrades).where(eq(schema.shadowTrades.candidateId, candidateId)).run();
  db.delete(schema.watchCursors).where(eq(schema.watchCursors.candidateId, candidateId)).run();
}

/** Open a pretend position at our notional; returns its row id. */
export function openShadowTrade(db: Db, input: Omit<ShadowTradeInsert, 'status'>): number {
  const res = db
    .insert(schema.shadowTrades)
    .values({ ...input, status: 'open' })
    .run();
  return Number(res.lastInsertRowid);
}

export function closeShadowTrade(
  db: Db,
  id: number,
  input: { closedAt: string; exitReason: string; exitPriceUsdMicro: string; pnlUsdMicro: string },
): void {
  db.update(schema.shadowTrades)
    .set({ status: 'closed', ...input })
    .where(eq(schema.shadowTrades.id, id))
    .run();
}

/** A partial sell shrinks the open lot: entry price and open time are kept. */
export function updateShadowTradeNotional(db: Db, id: number, notionalUsdMicro: string): void {
  db.update(schema.shadowTrades).set({ notionalUsdMicro }).where(eq(schema.shadowTrades.id, id)).run();
}

export function listOpenShadowTrades(db: Db, candidateId?: string) {
  const where = candidateId
    ? and(eq(schema.shadowTrades.status, 'open'), eq(schema.shadowTrades.candidateId, candidateId))
    : eq(schema.shadowTrades.status, 'open');
  return db
    .select()
    .from(schema.shadowTrades)
    .where(where)
    .orderBy(schema.shadowTrades.openedAt, schema.shadowTrades.id)
    .all();
}

export interface ShadowAggregates {
  closedCount: number;
  /** Net of closed trades, micro-USD (bigint: never floating point). */
  netPnlUsdMicro: bigint;
  lastClosedAt: string | null;
}

/**
 * D4 promotion evidence: how many shadow trades closed and how they netted.
 * By default only forward closes count — the admission backfill is ledger
 * evidence, not proof the wallet performs for us. Pass
 * `{ includeBackfilled: true }` for display/audit views that want the whole
 * historical record.
 */
export function shadowAggregates(
  db: Db,
  candidateId: string,
  opts: { includeBackfilled?: boolean } = {},
): ShadowAggregates {
  const conditions = [
    eq(schema.shadowTrades.candidateId, candidateId),
    eq(schema.shadowTrades.status, 'closed'),
  ];
  if (!opts.includeBackfilled) conditions.push(eq(schema.shadowTrades.backfilled, false));
  const rows = db
    .select({
      pnlUsdMicro: schema.shadowTrades.pnlUsdMicro,
      closedAt: schema.shadowTrades.closedAt,
    })
    .from(schema.shadowTrades)
    .where(and(...conditions))
    .all();
  let net = 0n;
  let lastClosedAt: string | null = null;
  for (const row of rows) {
    if (row.pnlUsdMicro) net += BigInt(row.pnlUsdMicro);
    if (row.closedAt && (lastClosedAt === null || row.closedAt > lastClosedAt)) lastClosedAt = row.closedAt;
  }
  return { closedCount: rows.length, netPnlUsdMicro: net, lastClosedAt };
}

export function getWatchCursor(db: Db, address: string) {
  return db.select().from(schema.watchCursors).where(eq(schema.watchCursors.address, address)).get();
}

export function setWatchCursor(
  db: Db,
  input: {
    address: string;
    candidateId: string;
    lastSignature: string;
    lastSlot: number;
    lastTransactionIndex: number;
  },
): void {
  const ts = nowIso();
  db.insert(schema.watchCursors)
    .values({ ...input, updatedAt: ts })
    .onConflictDoUpdate({ target: schema.watchCursors.address, set: { ...input, updatedAt: ts } })
    .run();
}

// --- risk / reconciliation / health ------------------------------------------------

export function insertRiskRejection(db: Db, input: RiskRejectionInsert): void {
  const mode =
    input.mode ?? (input.activationId ? (getActivation(db, input.activationId)?.mode ?? 'paper') : 'paper');
  db.insert(schema.riskRejections)
    .values({ ...input, mode })
    .run();
}

export function listRiskRejections(db: Db, limit = 200, mode?: BookMode) {
  const q = db.select().from(schema.riskRejections);
  return (mode ? q.where(eq(schema.riskRejections.mode, mode)) : q)
    .orderBy(desc(schema.riskRejections.id))
    .limit(limit)
    .all();
}

export function openReconciliationCases(db: Db, mode?: BookMode) {
  const conditions = [eq(schema.reconciliationCases.status, 'open')];
  if (mode) conditions.push(eq(schema.reconciliationCases.mode, mode));
  return db
    .select()
    .from(schema.reconciliationCases)
    .where(and(...conditions))
    .all();
}

export function insertReconciliationCase(db: Db, input: ReconciliationInsert): number {
  const res = db.insert(schema.reconciliationCases).values(input).run();
  return Number(res.lastInsertRowid);
}

export function resolveReconciliationCase(db: Db, id: number): void {
  db.update(schema.reconciliationCases)
    .set({ status: 'resolved', resolvedAt: nowIso() })
    .where(eq(schema.reconciliationCases.id, id))
    .run();
}

// --- withdrawals ---------------------------------------------------------------

type WithdrawalInsert = (typeof schema.withdrawals)['$inferInsert'];

export function insertWithdrawal(db: Db, input: WithdrawalInsert): void {
  db.insert(schema.withdrawals).values(input).run();
}

export function updateWithdrawal(db: Db, withdrawalId: string, patch: Partial<WithdrawalInsert>): void {
  db.update(schema.withdrawals)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(schema.withdrawals.withdrawalId, withdrawalId))
    .run();
}

export function getWithdrawal(db: Db, withdrawalId: string) {
  return db.select().from(schema.withdrawals).where(eq(schema.withdrawals.withdrawalId, withdrawalId)).get();
}

export function getWithdrawalByIdempotencyKey(db: Db, key: string) {
  return db.select().from(schema.withdrawals).where(eq(schema.withdrawals.idempotencyKey, key)).get();
}

const OPEN_WITHDRAWAL_STATES = ['pending', 'signed', 'submitted', 'unknown'] as const;

/** Anything that still needs chain reconciliation (and holds USDC cash). */
export function openWithdrawals(db: Db, mode?: BookMode) {
  const conditions = [inArray(schema.withdrawals.status, [...OPEN_WITHDRAWAL_STATES])];
  if (mode) conditions.push(eq(schema.withdrawals.mode, mode));
  return db
    .select()
    .from(schema.withdrawals)
    .where(and(...conditions))
    .all();
}

/**
 * USDC leaving the book: `sent` reduces capital permanently; open states
 * reserve cash until reconciled. SOL withdrawals do not touch the USDC ledger.
 */
export function withdrawalTotals(
  db: Db,
  mode?: BookMode,
): { sentUsdMicro: bigint; reservedUsdMicro: bigint } {
  const conditions = [eq(schema.withdrawals.asset, 'USDC')];
  if (mode) conditions.push(eq(schema.withdrawals.mode, mode));
  const rows = db
    .select()
    .from(schema.withdrawals)
    .where(and(...conditions))
    .all();
  let sent = 0n;
  let reserved = 0n;
  for (const row of rows) {
    const amount = BigInt(row.amountUsdMicro ?? '0');
    if (row.status === 'sent') sent += amount;
    else if ((OPEN_WITHDRAWAL_STATES as readonly string[]).includes(row.status)) reserved += amount;
  }
  return { sentUsdMicro: sent, reservedUsdMicro: reserved };
}

export function listWithdrawals(db: Db, limit = 100, mode?: BookMode) {
  const q = db.select().from(schema.withdrawals);
  return (mode ? q.where(eq(schema.withdrawals.mode, mode)) : q)
    .orderBy(desc(schema.withdrawals.createdAt))
    .limit(limit)
    .all();
}

export function recordProviderHealth(db: Db, input: ProviderHealthInsert): void {
  db.insert(schema.providerHealth).values(input).run();
}

export function latestProviderHealth(db: Db) {
  const rows = db.select().from(schema.providerHealth).all();
  const latest = new Map<string, (typeof schema.providerHealth)['$inferSelect']>();
  for (const row of rows) {
    const prev = latest.get(row.provider);
    if (!prev || row.checkedAt > prev.checkedAt) latest.set(row.provider, row);
  }
  return [...latest.values()];
}

// --- users ---------------------------------------------------------------------

export function createUser(db: Db, username: string, passwordHash: string): void {
  db.insert(schema.appUser).values({ username, passwordHash, createdAt: nowIso() }).run();
}

export function getUser(db: Db, username: string) {
  return db.select().from(schema.appUser).where(eq(schema.appUser.username, username)).get();
}

export function countUsers(db: Db): number {
  const rows = db
    .select({ count: sql<string>`count(*)` })
    .from(schema.appUser)
    .all();
  return Number(rows[0]?.count ?? '0');
}
