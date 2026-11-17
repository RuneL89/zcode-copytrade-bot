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

export const traderCandidates = sqliteTable(
  'trader_candidates',
  {
    candidateId: text('candidate_id').primaryKey(),
    handle: text('handle').notNull(),
    /**
     * fomoapi stable user id (D3 identity: handles change, the user id does
     * not). Null for rows imported before the outlet carried one — SQLite
     * allows many NULLs under a unique index, so old rows stay valid.
     */
    userId: text('user_id'),
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
    // On-chain activity (the same numbers the pre-hire gate enforces). Primary
    // source: free public Solana RPC; Helius is the fallback.
    swaps24h: integer('swaps_24h'),
    lastSwapAt: text('last_swap_at'),
    activityCheckedAt: text('activity_checked_at'),
    // Direction-aware: most recent on-chain BUY within the checker's lookback at
    // ANY age. Null ambiguity ("no buy" vs "check failed") is resolved by
    // activity_check_status ('ok' | 'partial' | 'failed').
    lastBuyAt: text('last_buy_at'),
    // Direction counts within the checker's 24h lookback (public-RPC path only;
    // null when the fallback source could not classify directions). A 'partial'
    // reading is a lower bound from a bounded prefix, not a 24h census.
    buys24h: integer('buys_24h'),
    sells24h: integer('sells_24h'),
    // 'ok' = last complete check succeeded (columns are current); 'partial' =
    // a bounded prefix proved the admission gate but did not census the window;
    // 'failed' = every source errored (older column values were preserved).
    activityCheckStatus: text('activity_check_status'),
    observedAt: text('observed_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('uniq_candidate_user_id').on(t.userId)],
);

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

/**
 * LEGACY (D6): the research pipeline is retired. This table keeps its data for
 * the record; no code reads or writes it, and dropping it is out of scope.
 */
export const researchSnapshots = sqliteTable('research_snapshots', {
  snapshotId: text('snapshot_id').primaryKey(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  sourceFreshnessSeconds: integer('source_freshness_seconds').notNull(),
  hash: text('hash').notNull(),
  payloadJson: text('payload_json').notNull(),
});

/**
 * LEGACY (D6): the research pipeline is retired. This table keeps its data for
 * the record; no code reads or writes it, and dropping it is out of scope.
 */
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

/**
 * LEGACY (D6): the research pipeline is retired. This table keeps its data for
 * the record; no code reads or writes it, and dropping it is out of scope.
 */
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

/**
 * LEGACY (D6): the research pipeline is retired. This table keeps its data for
 * the record; no code reads or writes it, and dropping it is out of scope.
 */
export const recommendationChoices = sqliteTable('recommendation_choices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recommendationId: text('recommendation_id'),
  chosenCandidateId: text('chosen_candidate_id'),
  firedFromCandidateId: text('fired_from_candidate_id'),
  result: text('result').notNull(), // legacy research outcome (ACTIVATE | …)
  skippedJson: text('skipped_json'),
  createdAt: text('created_at').notNull(),
});

export const traderActivations = sqliteTable(
  'trader_activations',
  {
    activationId: text('activation_id').primaryKey(),
    candidateId: text('candidate_id').notNull(),
    /** The book this chair belongs to. Live and paper chairs never mix. */
    mode: text('mode').notNull().default('paper'), // paper|live
    state: text('state').notNull().default('ACTIVE'), // WATCHING|ACTIVE|FIRING|FIRED|REQUIRES_RECONCILIATION
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    endReason: text('end_reason'), // fired|manual|replaced
    lossStreak: integer('loss_streak').notNull().default(0),
    firedReason: text('fired_reason'),
    source: text('source').notNull().default('manual'), // manual|watch_promotion (legacy rows carry retired values)
    /**
     * The activation whose firing this hire replaced (the hand-off hire from
     * `fire()`/`completeBlockedFire()`). Such a hire does not lift the fired
     * trader's re-entry block; an independent later hire still does.
     */
    replacesActivationId: text('replaces_activation_id'),
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
    /** The book this observed event belongs to (for the dashboard tape). */
    mode: text('mode').notNull().default('paper'),
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
    /** The book this position belongs to; exits are refused across books. */
    mode: text('mode').notNull().default('paper'), // paper|live
    mint: text('mint').notNull(),
    mintSymbol: text('mint_symbol'),
    status: text('status').notNull().default('open'), // open|closed|partially_closed|requires_reconciliation
    entryIntentId: text('entry_intent_id'),
    inputMint: text('input_mint').notNull(),
    inputUsdMicro: text('input_usd_micro').notNull(),
    /**
     * Cost basis still deployed. Partial closes reduce this; closed rows are
     * zero. Caps and cash use this, never the original input.
     */
    remainingCostBasisUsdMicro: text('remaining_cost_basis_usd_micro').notNull().default('0'),
    remainingFeesUsdMicro: text('remaining_fees_usd_micro').notNull().default('0'),
    copiedTokenBase: text('copied_token_base').notNull(),
    remainingTokenBase: text('remaining_token_base').notNull(),
    leaderTokenBase: text('leader_token_base'),
    realizedPnlUsdMicro: text('realized_pnl_usd_micro').notNull().default('0'),
    feesUsdMicro: text('fees_usd_micro').notNull().default('0'),
    /** Token decimals captured at entry; exit pricing must not assume 6. */
    mintDecimals: integer('mint_decimals').notNull().default(6),
    inputDecimals: integer('input_decimals').notNull().default(6),
    openedAt: text('opened_at').notNull(),
    closedAt: text('closed_at'),
    closeReason: text('close_reason'), // leader_exit|fire_close_all|emergency|manual
  },
  (t) => [
    index('idx_position_status').on(t.status),
    index('idx_position_activation').on(t.activationId),
    index('idx_position_mode_status').on(t.mode, t.status),
  ],
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
    inputDecimals: integer('input_decimals').notNull().default(6),
    outputDecimals: integer('output_decimals').notNull().default(6),
    minOutputBase: text('min_output_base'),
    slippageBps: integer('slippage_bps'),
    priceImpactBps: integer('price_impact_bps'),
    state: text('state').notNull().default('pending_quote'),
    idempotencyKey: text('idempotency_key').notNull(),
    quoteJson: text('quote_json'),
    /**
     * Budget held from intent creation until the position exists. Counted by
     * every entry cap so two concurrent leader buys cannot overspend.
     */
    reservedUsdMicro: text('reserved_usd_micro').notNull().default('0'),
    /**
     * Durable signing evidence: written BEFORE the network send so a crash or
     * ambiguous send is always reconcilable. The signed bytes are public data.
     */
    txSignature: text('tx_signature'),
    blockhash: text('blockhash'),
    lastValidBlockHeight: integer('last_valid_block_height'),
    signedTxBase64: text('signed_tx_base64'),
    signedAt: text('signed_at'),
    submittedAt: text('submitted_at'),
    submitVia: text('submit_via'), // sender|staked|public
    buildKind: text('build_kind'), // legacy|v0
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_intent_idem').on(t.idempotencyKey),
    index('idx_intent_state').on(t.state),
    index('idx_intent_mode_state').on(t.mode, t.state),
  ],
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

export const fills = sqliteTable(
  'fills',
  {
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
  },
  // One transaction finalizes one intent; reconciliation must be idempotent.
  (t) => [uniqueIndex('uniq_fill_intent').on(t.intentId)],
);

export const realizedPnlLots = sqliteTable('realized_pnl_lots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  positionId: text('position_id').notNull(),
  /** The book this close belongs to (denormalized from the position). */
  mode: text('mode').notNull().default('paper'), // paper|live
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
  /** The book the firing belongs to; re-entry is judged per book. */
  mode: text('mode').notNull().default('paper'), // paper|live
  reason: text('reason').notNull(),
  lossStreak: integer('loss_streak').notNull(),
  positionPolicy: text('position_policy').notNull(),
  firedAt: text('fired_at').notNull(),
  closeCompletedAt: text('close_completed_at'),
  handoffStatus: text('handoff_status').notNull(), // legacy (handoff machinery retired): 'none' for new rows
});

/** LEGACY (D6): the research handoff is retired; the table keeps its data and nothing reads or writes it. */
export const handoffEvents = sqliteTable('handoff_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromCandidateId: text('from_candidate_id'),
  toCandidateId: text('to_candidate_id'),
  status: text('status').notNull(), // LEGACY (D6): the handoff machinery is retired and nothing writes here
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
  /** The book the rejection belongs to. */
  mode: text('mode').notNull().default('paper'),
  rule: text('rule').notNull(),
  limitValue: text('limit_value').notNull(),
  actualValue: text('actual_value').notNull(),
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
});

export const reconciliationCases = sqliteTable('reconciliation_cases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(), // unknown_execution|close_failed|late_fill|unknown_withdrawal|balance_mismatch|missing_position
  /** The book the case belongs to; only current-mode cases block arming. */
  mode: text('mode').notNull().default('paper'), // paper|live
  intentId: text('intent_id'),
  positionId: text('position_id'),
  /** Present whenever a signature was created, even if confirmation was lost. */
  signature: text('signature'),
  withdrawalId: text('withdrawal_id'),
  status: text('status').notNull().default('open'), // open|resolved
  detail: text('detail'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});

/**
 * Every real-money withdrawal. The row is written before signing, carries the
 * idempotency key, and is the reconciliation anchor for an ambiguous send.
 */
export const withdrawals = sqliteTable(
  'withdrawals',
  {
    withdrawalId: text('withdrawal_id').primaryKey(),
    mode: text('mode').notNull().default('live'), // paper is refused; live only
    asset: text('asset').notNull(), // SOL|USDC
    amountBase: text('amount_base').notNull(),
    /** USDC only: base units equal micro-USD. Null for SOL. */
    amountUsdMicro: text('amount_usd_micro'),
    destination: text('destination').notNull(),
    status: text('status').notNull().default('pending'), // pending|signed|submitted|sent|unknown|failed
    signature: text('signature'),
    blockhash: text('blockhash'),
    lastValidBlockHeight: integer('last_valid_block_height'),
    idempotencyKey: text('idempotency_key').notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    uniqueIndex('uniq_withdrawal_idem').on(t.idempotencyKey),
    index('idx_withdrawal_status').on(t.status),
    index('idx_withdrawal_mode_status').on(t.mode, t.status),
  ],
);

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

// --- watch list / shadow ledger (D3/D4) ---------------------------------------

/** Watch-list membership: one row per watched wallet (D4). */
export const watchWallets = sqliteTable(
  'watch_wallets',
  {
    candidateId: text('candidate_id').primaryKey(),
    userId: text('user_id'),
    address: text('address').notNull(),
    status: text('status').notNull().default('watching'), // watching|cooling|bench|hired|archived
    admittedAt: text('admitted_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    reason: text('reason'),
    lastFundedBuyAt: text('last_funded_buy_at'),
    lastFundedSellAt: text('last_funded_sell_at'),
  },
  (t) => [index('idx_watch_status').on(t.status)],
);

/**
 * Funded swaps observed on a watched wallet. The unique key
 * (candidate, signature, side) makes the insert idempotent: a re-scanned
 * signature can never double-count into the shadow ledger.
 */
export const watchEvents = sqliteTable(
  'watch_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    candidateId: text('candidate_id').notNull(),
    address: text('address').notNull(),
    signature: text('signature').notNull(),
    side: text('side').notNull(), // buy|sell
    mint: text('mint').notNull(),
    tokenAmountBase: text('token_amount_base').notNull(),
    decimals: integer('decimals').notNull(),
    usdMicro: text('usd_micro').notNull(),
    blockTime: integer('block_time').notNull(),
    observedAt: text('observed_at').notNull(),
    source: text('source').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_watch_event').on(t.candidateId, t.signature, t.side),
    index('idx_watch_event_side').on(t.candidateId, t.side, t.observedAt),
  ],
);

/** Shadow (pretend) position opened by a funded buy and closed by a funded sell. */
export const shadowTrades = sqliteTable(
  'shadow_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    candidateId: text('candidate_id').notNull(),
    mint: text('mint').notNull(),
    openedAt: text('opened_at').notNull(),
    entryPriceUsdMicro: text('entry_price_usd_micro').notNull(),
    notionalUsdMicro: text('notional_usd_micro').notNull(),
    status: text('status').notNull().default('open'), // open|closed
    closedAt: text('closed_at'),
    exitReason: text('exit_reason'), // leader_sell|ceiling|unpriceable
    exitPriceUsdMicro: text('exit_price_usd_micro'),
    pnlUsdMicro: text('pnl_usd_micro'),
    /**
     * Provenance: true when the lot was replayed from the admission scan's
     * historical events (the backfill seed). Backfilled lots are ledger
     * evidence but are excluded from the promotion/demotion aggregates, which
     * judge the wallet on forward closes only.
     */
    backfilled: integer('backfilled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('idx_shadow_status').on(t.candidateId, t.status)],
);

/** Watch-side cursor (the roster keeps using `leader_cursors`) — D5, two per wallet. */
export const watchCursors = sqliteTable('watch_cursors', {
  address: text('address').primaryKey(),
  candidateId: text('candidate_id').notNull(),
  lastSignature: text('last_signature').notNull(),
  lastSlot: integer('last_slot').notNull(),
  lastTransactionIndex: integer('last_transaction_index').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});
