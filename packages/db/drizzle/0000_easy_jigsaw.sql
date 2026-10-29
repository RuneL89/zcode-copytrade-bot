CREATE TABLE `app_user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_username_unique` ON `app_user` (`username`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `candidate_addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` text NOT NULL,
	`chain` text NOT NULL,
	`address` text NOT NULL,
	`verification` text DEFAULT 'reported' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_candidate_address` ON `candidate_addresses` (`candidate_id`,`chain`,`address`);--> statement-breakpoint
CREATE TABLE `candidate_recommendations` (
	`recommendation_id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`received_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`model_label` text,
	`research_session_id` text,
	`abstain` integer DEFAULT false NOT NULL,
	`abstain_reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`validation_error` text,
	`raw_json` text NOT NULL,
	`normalized_json` text
);
--> statement-breakpoint
CREATE TABLE `candidate_rejections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recommendation_id` text,
	`candidate_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `control_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`detail` text,
	`source` text DEFAULT 'dashboard' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `copied_positions` (
	`position_id` text PRIMARY KEY NOT NULL,
	`activation_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`mint` text NOT NULL,
	`mint_symbol` text,
	`status` text DEFAULT 'open' NOT NULL,
	`entry_intent_id` text,
	`input_mint` text NOT NULL,
	`input_usd_micro` text NOT NULL,
	`copied_token_base` text NOT NULL,
	`remaining_token_base` text NOT NULL,
	`leader_token_base` text,
	`realized_pnl_usd_micro` text DEFAULT '0' NOT NULL,
	`fees_usd_micro` text DEFAULT '0' NOT NULL,
	`opened_at` text NOT NULL,
	`closed_at` text,
	`close_reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_position_status` ON `copied_positions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_position_activation` ON `copied_positions` (`activation_id`);--> statement-breakpoint
CREATE TABLE `execution_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`intent_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`phase` text NOT NULL,
	`request_ref` text,
	`response_ref` text,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fills` (
	`fill_id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`position_id` text,
	`mode` text NOT NULL,
	`tx_signature` text,
	`input_amount_base` text NOT NULL,
	`output_amount_base` text NOT NULL,
	`price_usd_micro` text,
	`fee_estimate_usd_micro` text DEFAULT '0' NOT NULL,
	`balance_evidence_json` text,
	`commitment` text,
	`confirmed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `firing_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activation_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`reason` text NOT NULL,
	`loss_streak` integer NOT NULL,
	`position_policy` text NOT NULL,
	`fired_at` text NOT NULL,
	`close_completed_at` text,
	`handoff_status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `handoff_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_candidate_id` text,
	`to_candidate_id` text,
	`status` text NOT NULL,
	`recommendation_id` text,
	`source` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leader_cursors` (
	`address` text PRIMARY KEY NOT NULL,
	`chain` text DEFAULT 'solana' NOT NULL,
	`activation_id` text NOT NULL,
	`last_signature` text NOT NULL,
	`last_slot` integer NOT NULL,
	`last_transaction_index` integer DEFAULT 0 NOT NULL,
	`last_block_time` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leaderboard_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`handle` text NOT NULL,
	`weekly_rank` integer,
	`displayed_pnl_usd_micro` text,
	`source` text NOT NULL,
	`observed_at` text NOT NULL,
	`import_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_obs_handle` ON `leaderboard_observations` (`handle`);--> statement-breakpoint
CREATE TABLE `loss_streak_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activation_id` text NOT NULL,
	`unit_type` text NOT NULL,
	`unit_ref` text,
	`result` text NOT NULL,
	`pnl_usd_micro` text NOT NULL,
	`streak_after` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observed_leader_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_key` text NOT NULL,
	`activation_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`address` text NOT NULL,
	`signature` text NOT NULL,
	`slot` integer NOT NULL,
	`transaction_index` integer DEFAULT 0 NOT NULL,
	`block_time` integer,
	`kind` text NOT NULL,
	`skip_reason` text,
	`detail_json` text,
	`raw_ref` text,
	`parser_version` text NOT NULL,
	`processed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_event_dedupe` ON `observed_leader_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_event_slot` ON `observed_leader_events` (`slot`);--> statement-breakpoint
CREATE TABLE `order_intents` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`activation_id` text,
	`candidate_id` text,
	`position_id` text,
	`mint` text NOT NULL,
	`input_mint` text NOT NULL,
	`input_amount_base` text NOT NULL,
	`input_usd_micro` text,
	`min_output_base` text,
	`slippage_bps` integer,
	`price_impact_bps` integer,
	`state` text DEFAULT 'pending_quote' NOT NULL,
	`idempotency_key` text NOT NULL,
	`quote_json` text,
	`tx_signature` text,
	`reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intent_idem` ON `order_intents` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_intent_state` ON `order_intents` (`state`);--> statement-breakpoint
CREATE TABLE `provider_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`detail` text,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `realized_pnl_lots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` text NOT NULL,
	`closed_base` text NOT NULL,
	`proceeds_usd_micro` text NOT NULL,
	`cost_basis_usd_micro` text NOT NULL,
	`fees_usd_micro` text DEFAULT '0' NOT NULL,
	`pnl_usd_micro` text NOT NULL,
	`unit_type` text NOT NULL,
	`closed_at` text NOT NULL,
	`signature` text
);
--> statement-breakpoint
CREATE TABLE `recommendation_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recommendation_id` text NOT NULL,
	`rank` integer NOT NULL,
	`candidate_id` text NOT NULL,
	`confidence` text NOT NULL,
	`thesis` text NOT NULL,
	`concerns_json` text DEFAULT '[]' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recommendation_choices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recommendation_id` text,
	`chosen_candidate_id` text,
	`fired_from_candidate_id` text,
	`result` text NOT NULL,
	`skipped_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reconciliation_cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`intent_id` text,
	`position_id` text,
	`signature` text,
	`status` text DEFAULT 'open' NOT NULL,
	`detail` text,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `research_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`source_freshness_seconds` integer NOT NULL,
	`hash` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `risk_rejections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activation_id` text,
	`rule` text NOT NULL,
	`limit_value` text NOT NULL,
	`actual_value` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trader_activations` (
	`activation_id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`state` text DEFAULT 'ACTIVE' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_reason` text,
	`loss_streak` integer DEFAULT 0 NOT NULL,
	`fired_reason` text,
	`source` text DEFAULT 'zcode_shortlist' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activation_candidate` ON `trader_activations` (`candidate_id`);--> statement-breakpoint
CREATE TABLE `trader_candidates` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`weekly_rank` integer,
	`displayed_weekly_pnl_usd_micro` text,
	`profile_url` text,
	`avatar_url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
