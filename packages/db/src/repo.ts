import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from './connection.js';
import { schema } from './connection.js';

type Db = AppDatabase;

type SnapshotInsert = (typeof schema.researchSnapshots)['$inferInsert'];
type RecommendationInsert = (typeof schema.candidateRecommendations)['$inferInsert'];
type RecommendationCandidateInsert = (typeof schema.recommendationCandidates)['$inferInsert'];
type ActivationInsert = (typeof schema.traderActivations)['$inferInsert'];
type ObservedEventInsert = (typeof schema.observedLeaderEvents)['$inferInsert'];
type PositionInsert = (typeof schema.copiedPositions)['$inferInsert'];
type IntentInsert = (typeof schema.orderIntents)['$inferInsert'];
type AttemptInsert = (typeof schema.executionAttempts)['$inferInsert'];
type FillInsert = (typeof schema.fills)['$inferInsert'];
type PnlLotInsert = (typeof schema.realizedPnlLots)['$inferInsert'];
type StreakEventInsert = (typeof schema.lossStreakEvents)['$inferInsert'];
type FiringEventInsert = (typeof schema.firingEvents)['$inferInsert'];
type HandoffEventInsert = (typeof schema.handoffEvents)['$inferInsert'];
type RiskRejectionInsert = (typeof schema.riskRejections)['$inferInsert'];
type ReconciliationInsert = (typeof schema.reconciliationCases)['$inferInsert'];
type ProviderHealthInsert = (typeof schema.providerHealth)['$inferInsert'];

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

/** Store Helius on-chain activity — the same numbers the pre-hire gate uses. */
export function updateCandidateActivity(
  db: Db,
  candidateId: string,
  activity: { swaps24h: number; lastSwapAt: string | null; checkedAt: string },
): void {
  db.update(schema.traderCandidates)
    .set({
      swaps24h: activity.swaps24h,
      lastSwapAt: activity.lastSwapAt,
      activityCheckedAt: activity.checkedAt,
      updatedAt: activity.checkedAt,
    })
    .where(eq(schema.traderCandidates.candidateId, candidateId))
    .run();
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

// --- research snapshots / recommendations --------------------------------------

export function saveSnapshot(db: Db, input: SnapshotInsert): void {
  db.insert(schema.researchSnapshots)
    .values(input)
    .onConflictDoUpdate({ target: schema.researchSnapshots.snapshotId, set: input })
    .run();
}

export function getSnapshot(db: Db, snapshotId: string) {
  return db
    .select()
    .from(schema.researchSnapshots)
    .where(eq(schema.researchSnapshots.snapshotId, snapshotId))
    .get();
}

export function latestSnapshot(db: Db) {
  return db
    .select()
    .from(schema.researchSnapshots)
    .orderBy(desc(schema.researchSnapshots.createdAt))
    .limit(1)
    .get();
}

export interface RecommendationRecord {
  recommendationId: string;
  snapshotId: string;
  snapshotHash: string;
  createdAt: string;
  receivedAt: string;
  expiresAt: string;
  modelLabel: string | null;
  researchSessionId: string | null;
  abstain: boolean;
  abstainReason: string | null;
  status: 'pending' | 'validated' | 'rejected' | 'consumed' | 'expired';
  validationError: string | null;
  rawJson: string;
  normalizedJson: string | null;
}

export function saveRecommendation(
  db: Db,
  rec: RecommendationInsert,
  candidates: Array<RecommendationCandidateInsert>,
): void {
  db.transaction((tx) => {
    tx.insert(schema.candidateRecommendations).values(rec).run();
    if (candidates.length > 0) tx.insert(schema.recommendationCandidates).values(candidates).run();
  });
}

export function getRecommendation(db: Db, id: string) {
  return db
    .select()
    .from(schema.candidateRecommendations)
    .where(eq(schema.candidateRecommendations.recommendationId, id))
    .get();
}

export function listRecommendations(db: Db, limit = 50) {
  return db
    .select()
    .from(schema.candidateRecommendations)
    .orderBy(desc(schema.candidateRecommendations.receivedAt))
    .limit(limit)
    .all();
}

export function latestValidRecommendation(db: Db) {
  return db
    .select()
    .from(schema.candidateRecommendations)
    .where(inArray(schema.candidateRecommendations.status, ['validated']))
    .orderBy(desc(schema.candidateRecommendations.receivedAt))
    .limit(1)
    .get();
}

export function listRecommendationCandidates(db: Db, recommendationId: string) {
  return db
    .select()
    .from(schema.recommendationCandidates)
    .where(eq(schema.recommendationCandidates.recommendationId, recommendationId))
    .orderBy(schema.recommendationCandidates.rank)
    .all();
}

export function markRecommendationStatus(db: Db, id: string, status: string): void {
  db.update(schema.candidateRecommendations)
    .set({ status })
    .where(eq(schema.candidateRecommendations.recommendationId, id))
    .run();
}

export function recordChoice(
  db: Db,
  input: {
    recommendationId: string | null;
    chosenCandidateId: string | null;
    firedFromCandidateId: string | null;
    result: string;
    skippedJson?: string;
  },
): void {
  db.insert(schema.recommendationChoices)
    .values({ ...input, skippedJson: input.skippedJson ?? null, createdAt: nowIso() })
    .run();
}

export function recordCandidateRejection(
  db: Db,
  input: { recommendationId: string | null; candidateId: string; reason: string; detail?: string },
): void {
  db.insert(schema.candidateRejections)
    .values({ ...input, detail: input.detail ?? null, createdAt: nowIso() })
    .run();
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

export function activeActivation(db: Db) {
  return db
    .select()
    .from(schema.traderActivations)
    .where(inArray(schema.traderActivations.state, ['ACTIVE', 'FIRING', 'REQUIRES_RECONCILIATION']))
    .orderBy(desc(schema.traderActivations.startedAt))
    .limit(1)
    .get();
}

export function listActivations(db: Db, limit = 50) {
  return db
    .select()
    .from(schema.traderActivations)
    .orderBy(desc(schema.traderActivations.startedAt))
    .limit(limit)
    .all();
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
  const res = db.insert(schema.observedLeaderEvents).values(input).onConflictDoNothing().run();
  return res.changes > 0;
}

export function listObservedEvents(db: Db, activationId?: string, limit = 100) {
  const q = db.select().from(schema.observedLeaderEvents);
  return activationId
    ? q
        .where(eq(schema.observedLeaderEvents.activationId, activationId))
        .orderBy(desc(schema.observedLeaderEvents.id))
        .limit(limit)
        .all()
    : q.orderBy(desc(schema.observedLeaderEvents.id)).limit(limit).all();
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

export function openPositions(db: Db) {
  return db
    .select()
    .from(schema.copiedPositions)
    .where(inArray(schema.copiedPositions.status, ['open', 'partially_closed']))
    .all();
}

export function openPositionForMint(db: Db, candidateId: string, mint: string) {
  return db
    .select()
    .from(schema.copiedPositions)
    .where(
      and(
        eq(schema.copiedPositions.candidateId, candidateId),
        eq(schema.copiedPositions.mint, mint),
        inArray(schema.copiedPositions.status, ['open', 'partially_closed']),
      ),
    )
    .limit(1)
    .get();
}

export function listPositions(db: Db, limit = 200) {
  return db
    .select()
    .from(schema.copiedPositions)
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

export function intentsInStates(db: Db, states: string[]) {
  return db.select().from(schema.orderIntents).where(inArray(schema.orderIntents.state, states)).all();
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

export function recordAttempt(db: Db, input: AttemptInsert): void {
  db.insert(schema.executionAttempts).values(input).run();
}

export function insertFill(db: Db, input: FillInsert): void {
  db.insert(schema.fills).values(input).run();
}

export function listFills(db: Db, limit = 200) {
  return db.select().from(schema.fills).orderBy(desc(schema.fills.confirmedAt)).limit(limit).all();
}

export function insertPnlLot(db: Db, input: PnlLotInsert): void {
  db.insert(schema.realizedPnlLots).values(input).run();
}

export function listPnlLots(db: Db, limit = 500) {
  return db
    .select()
    .from(schema.realizedPnlLots)
    .orderBy(desc(schema.realizedPnlLots.closedAt))
    .limit(limit)
    .all();
}

export function realizedPnlSince(db: Db, sinceIso: string): bigint {
  const rows = db
    .select({
      total: sql<string | null>`coalesce(sum(cast(${schema.realizedPnlLots.pnlUsdMicro} as integer)), 0)`,
    })
    .from(schema.realizedPnlLots)
    .where(gte(schema.realizedPnlLots.closedAt, sinceIso))
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

export function insertHandoffEvent(db: Db, input: HandoffEventInsert): void {
  db.insert(schema.handoffEvents).values(input).run();
}

export function listHandoffEvents(db: Db, limit = 100) {
  return db.select().from(schema.handoffEvents).orderBy(desc(schema.handoffEvents.id)).limit(limit).all();
}

// --- risk / reconciliation / health ------------------------------------------------

export function insertRiskRejection(db: Db, input: RiskRejectionInsert): void {
  db.insert(schema.riskRejections).values(input).run();
}

export function listRiskRejections(db: Db, limit = 200) {
  return db.select().from(schema.riskRejections).orderBy(desc(schema.riskRejections.id)).limit(limit).all();
}

export function openReconciliationCases(db: Db) {
  return db
    .select()
    .from(schema.reconciliationCases)
    .where(eq(schema.reconciliationCases.status, 'open'))
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
