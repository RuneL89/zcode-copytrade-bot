import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

/**
 * Monetary values are micro-USD INTEGERs. Token amounts are decimal-string
 * base units (TEXT) parsed via BigInt. Never floating point.
 */

export const appUser = sqliteTable('app_user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
});

export const traderCandidates = sqliteTable('trader_candidates', {
  candidateId: text('candidate_id').primaryKey(),
  handle: text('handle').notNull(),
  weeklyRank: integer('weekly_rank'),
  displayedWeeklyPnlUsdMicro: text('displayed_weekly_pnl_usd_micro'),
  profileUrl: text('profile_url'),
  avatarUrl: text('avatar_url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  source: text('source').notNull().default('manual'),
  avgHoldHours: real('avg_hold_hours'),
  tradesCount7d: integer('trades_count_7d'),
  winRatePct: real('win_rate_pct'),
  realizedOnchainUsd: real('realized_onchain_usd'),
  statsCheckedAt: text('stats_checked_at'),
  // Dawn compact card: PnL as displayed per period (unrealized marks).
  pnl24hUsd: real('pnl_24h_usd'),
  pnl7dUsd: real('pnl_7d_usd'),
  pnl30dUsd: real('pnl_30d_usd'),
  pnlAllTimeUsd: real('pnl_all_time_usd'),
  rank24h: integer('rank_24h'),
  rank7d: integer('rank_7d'),
  rankAllTime: integer('rank_all_time'),
  // Dawn compact card: Trading block.
  tradesTotal: integer('trades_total'),
  volumeUsd: real('volume_usd'),
  recentBuys: integer('recent_buys'),
  recentSells: integer('recent_sells'),
  coinsTraded: integer('coins_traded'),
  lastTradeAgeHours: real('last_trade_age_hours'),
  // Helius on-chain activity (the same numbers the pre-hire gate enforces).
  swaps24h: integer('swaps_24h'),
  lastSwapAt: text('last_swap_at'),
  activityCheckedAt: text('activity_checked_at'),
  observedAt: text('observed_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const candidateAddresses = sqliteTable(
  'candidate_addresses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    candidateId: text('candidate_id').notNull(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    verification: text('verification').notNull().default('reported'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('uniq_candidate_address').on(t.candidateId, t.chain, t.address)],
);

export const leaderboardObservations = sqliteTable(
  'leaderboard_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    handle: text('handle').notNull(),
    weeklyRank: integer('weekly_rank'),
    displayedPnlUsdMicro: text('displayed_pnl_usd_micro'),
    source: text('source').notNull(),
    observedAt: text('observed_at').notNull(),
    importId: text('import_id'),
  },
  (t) => [index('idx_obs_handle').on(t.handle)],
);

export const researchSnapshots = sqliteTable('research_snapshots', {
  snapshotId: text('snapshot_id').primaryKey(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  sourceFreshnessSeconds: integer('source_freshness_seconds').notNull(),
  hash: text('hash').notNull(),
  payloadJson: text('payload_json').notNull(),
});

export const candidateRecommendations = sqliteTable('candidate_recommendations', {
  recommendationId: text('recommendation_id').primaryKey(),
  snapshotId: text('snapshot_id').notNull(),
  snapshotHash: text('snapshot_hash').notNull(),
  createdAt: text('created_at').notNull(),
  receivedAt: text('received_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  modelLabel: text('model_label'),
  researchSessionId: text('research_session_id'),
  abstain: integer('abstain', { mode: 'boolean' }).notNull().default(false),
  abstainReason: text('abstain_reason'),
  status: text('status').notNull().default('pending'), // pending|validated|rejected|consumed|expired
  validationError: text('validation_error'),
  rawJson: text('raw_json').notNull(),
  normalizedJson: text('normalized_json'),
});

export const recommendationCandidates = sqliteTable('recommendation_candidates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recommendationId: text('recommendation_id').notNull(),
  rank: integer('rank').notNull(),
  candidateId: text('candidate_id').notNull(),
  confidence: text('confidence').notNull(),
  thesis: text('thesis').notNull(),
  concernsJson: text('concerns_json').notNull().default('[]'),
  evidenceJson: text('evidence_json').notNull().default('[]'),
});

export const recommendationChoices = sqliteTable('recommendation_choices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recommendationId: text('recommendation_id'),
  chosenCandidateId: text('chosen_candidate_id'),
  firedFromCandidateId: text('fired_from_candidate_id'),
  result: text('result').notNull(), // ACTIVATE | PAUSED_WAITING_FOR_ZCODE | ...
  skippedJson: text('skipped_json'),
  createdAt: text('created_at').notNull(),
});

export const traderActivations = sqliteTable(
  'trader_activations',
  {
    activationId: text('activation_id').primaryKey(),
    candidateId: text('candidate_id').notNull(),
    state: text('state').notNull().default('ACTIVE'), // WATCHING|ACTIVE|FIRING|FIRED|REQUIRES_RECONCILIATION
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    endReason: text('end_reason'), // fired|manual|replaced
    lossStreak: integer('loss_streak').notNull().default(0),
    firedReason: text('fired_reason'),
    source: text('source').notNull().default('zcode_shortlist'), // manual|zcode_shortlist|deterministic_fallback
  },
  (t) => [index('idx_activation_candidate').on(t.candidateId)],
);

export const leaderCursors = sqliteTable('leader_cursors', {
  address: text('address').primaryKey(),
  chain: text('chain').notNull().default('solana'),
  activationId: text('activation_id').notNull(),
  lastSignature: text('last_signature').notNull(),
  lastSlot: integer('last_slot').notNull(),
  lastTransactionIndex: integer('last_transaction_index').notNull().default(0),
  lastBlockTime: integer('last_block_time'),
  updatedAt: text('updated_at').notNull(),
});

export const observedLeaderEvents = sqliteTable(
  'observed_leader_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dedupeKey: text('dedupe_key').notNull(),
    activationId: text('activation_id').notNull(),
    candidateId: text('candidate_id').notNull(),
    address: text('address').notNull(),
    signature: text('signature').notNull(),
    slot: integer('slot').notNull(),
    transactionIndex: integer('transaction_index').notNull().default(0),
    blockTime: integer('block_time'),
    kind: text('kind').notNull(), // swap_buy|swap_sell|skipped|...
    skipReason: text('skip_reason'),
    detailJson: text('detail_json'),
    rawRef: text('raw_ref'),
    parserVersion: text('parser_version').notNull(),
    processedAt: text('processed_at').notNull(),
  },
  (t) => [uniqueIndex('uniq_event_dedupe').on(t.dedupeKey), index('idx_event_slot').on(t.slot)],
);

export const copiedPositions = sqliteTable(
  'copied_positions',
  {
    positionId: text('position_id').primaryKey(),
    activationId: text('activation_id').notNull(),
    candidateId: text('candidate_id').notNull(),
    mint: text('mint').notNull(),
    mintSymbol: text('mint_symbol'),
    status: text('status').notNull().default('open'), // open|closed|partially_closed|requires_reconciliation
    entryIntentId: text('entry_intent_id'),
    inputMint: text('input_mint').notNull(),
    inputUsdMicro: text('input_usd_micro').notNull(),
    copiedTokenBase: text('copied_token_base').notNull(),
    remainingTokenBase: text('remaining_token_base').notNull(),
    leaderTokenBase: text('leader_token_base'),
    realizedPnlUsdMicro: text('realized_pnl_usd_micro').notNull().default('0'),
    feesUsdMicro: text('fees_usd_micro').notNull().default('0'),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at'),
    closeReason: text('close_reason'), // leader_exit|fire_close_all|emergency|manual
  },
  (t) => [index('idx_position_status').on(t.status), index('idx_position_activation').on(t.activationId)],
);

export const orderIntents = sqliteTable(
  'order_intents',
  {
    intentId: text('intent_id').primaryKey(),
    kind: text('kind').notNull(), // entry|exit|fire_close|close_all
    mode: text('mode').notNull(), // paper|live
    activationId: text('activation_id'),
    candidateId: text('candidate_id'),
    positionId: text('position_id'),
    mint: text('mint').notNull(),
    inputMint: text('input_mint').notNull(),
    inputAmountBase: text('input_amount_base').notNull(),
    inputUsdMicro: text('input_usd_micro'),
    minOutputBase: text('min_output_base'),
    slippageBps: integer('slippage_bps'),
    priceImpactBps: integer('price_impact_bps'),
    state: text('state').notNull().default('pending_quote'),
    idempotencyKey: text('idempotency_key').notNull(),
    quoteJson: text('quote_json'),
    txSignature: text('tx_signature'),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('uniq_intent_idem').on(t.idempotencyKey), index('idx_intent_state').on(t.state)],
);

export const executionAttempts = sqliteTable('execution_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  intentId: text('intent_id').notNull(),
  attemptNo: integer('attempt_no').notNull(),
  phase: text('phase').notNull(), // quote|sign|submit|confirm
  requestRef: text('request_ref'),
  responseRef: text('response_ref'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
});

export const fills = sqliteTable('fills', {
  fillId: text('fill_id').primaryKey(),
  intentId: text('intent_id').notNull(),
  positionId: text('position_id'),
  mode: text('mode').notNull(), // paper|live (demo never writes here)
  txSignature: text('tx_signature'),
  inputAmountBase: text('input_amount_base').notNull(),
  outputAmountBase: text('output_amount_base').notNull(),
  priceUsdMicro: text('price_usd_micro'),
  feeEstimateUsdMicro: text('fee_estimate_usd_micro').notNull().default('0'),
  balanceEvidenceJson: text('balance_evidence_json'),
  commitment: text('commitment'),
  confirmedAt: text('confirmed_at').notNull(),
});

export const realizedPnlLots = sqliteTable('realized_pnl_lots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  positionId: text('position_id').notNull(),
  closedBase: text('closed_base').notNull(),
  proceedsUsdMicro: text('proceeds_usd_micro').notNull(),
  costBasisUsdMicro: text('cost_basis_usd_micro').notNull(),
  feesUsdMicro: text('fees_usd_micro').notNull().default('0'),
  pnlUsdMicro: text('pnl_usd_micro').notNull(),
  unitType: text('unit_type').notNull(), // position_closed|partial_close
  closedAt: text('closed_at').notNull(),
  signature: text('signature'),
});

export const lossStreakEvents = sqliteTable('loss_streak_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  activationId: text('activation_id').notNull(),
  unitType: text('unit_type').notNull(),
  unitRef: text('unit_ref'),
  result: text('result').notNull(), // win|loss|breakeven
  pnlUsdMicro: text('pnl_usd_micro').notNull(),
  streakAfter: integer('streak_after').notNull(),
  createdAt: text('created_at').notNull(),
});

export const firingEvents = sqliteTable('firing_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  activationId: text('activation_id').notNull(),
  candidateId: text('candidate_id').notNull(),
  reason: text('reason').notNull(),
  lossStreak: integer('loss_streak').notNull(),
  positionPolicy: text('position_policy').notNull(),
  firedAt: text('fired_at').notNull(),
  closeCompletedAt: text('close_completed_at'),
  handoffStatus: text('handoff_status').notNull(), // activated:<id> | PAUSED_WAITING_FOR_ZCODE | ...
});

export const handoffEvents = sqliteTable('handoff_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromCandidateId: text('from_candidate_id'),
  toCandidateId: text('to_candidate_id'),
  status: text('status').notNull(), // activated|paused_waiting_for_zcode|paused_waiting_for_candidate
  recommendationId: text('recommendation_id'),
  source: text('source').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});

export const candidateRejections = sqliteTable('candidate_rejections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recommendationId: text('recommendation_id'),
  candidateId: text('candidate_id').notNull(),
  reason: text('reason').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});

export const riskRejections = sqliteTable('risk_rejections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  activationId: text('activation_id'),
  rule: text('rule').notNull(),
  limitValue: text('limit_value').notNull(),
  actualValue: text('actual_value').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});

export const reconciliationCases = sqliteTable('reconciliation_cases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(), // unknown_execution|balance_mismatch|missing_position
  intentId: text('intent_id'),
  positionId: text('position_id'),
  signature: text('signature'),
  status: text('status').notNull().default('open'), // open|resolved
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const controlEvents = sqliteTable('control_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // pause|resume|emergency_stop|close_all|arm_live|disarm|replacement_request
  detail: text('detail'),
  source: text('source').notNull().default('dashboard'),
  createdAt: text('created_at').notNull(),
});

export const providerHealth = sqliteTable('provider_health', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').notNull(),
  status: text('status').notNull(), // ok|degraded|down|disabled
  latencyMs: integer('latency_ms'),
  detail: text('detail'),
  checkedAt: text('checked_at').notNull(),
});

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    category: text('category').notNull(),
    message: text('message').notNull(),
    dataJson: text('data_json'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_audit_created').on(t.createdAt)],
);

export const kv = sqliteTable('kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
