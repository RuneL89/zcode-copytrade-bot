CREATE TABLE `shadow_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` text NOT NULL,
	`mint` text NOT NULL,
	`opened_at` text NOT NULL,
	`entry_price_usd_micro` text NOT NULL,
	`notional_usd_micro` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_at` text,
	`exit_reason` text,
	`exit_price_usd_micro` text,
	`pnl_usd_micro` text
);
--> statement-breakpoint
CREATE INDEX `idx_shadow_status` ON `shadow_trades` (`candidate_id`,`status`);--> statement-breakpoint
CREATE TABLE `watch_cursors` (
	`address` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`last_signature` text NOT NULL,
	`last_slot` integer NOT NULL,
	`last_transaction_index` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watch_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` text NOT NULL,
	`address` text NOT NULL,
	`signature` text NOT NULL,
	`side` text NOT NULL,
	`mint` text NOT NULL,
	`token_amount_base` text NOT NULL,
	`decimals` integer NOT NULL,
	`usd_micro` text NOT NULL,
	`block_time` integer NOT NULL,
	`observed_at` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_watch_event` ON `watch_events` (`candidate_id`,`signature`,`side`);--> statement-breakpoint
CREATE INDEX `idx_watch_event_side` ON `watch_events` (`candidate_id`,`side`,`observed_at`);--> statement-breakpoint
CREATE TABLE `watch_wallets` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`address` text NOT NULL,
	`status` text DEFAULT 'watching' NOT NULL,
	`admitted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`reason` text,
	`last_funded_buy_at` text,
	`last_funded_sell_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_watch_status` ON `watch_wallets` (`status`);--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `user_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_candidate_user_id` ON `trader_candidates` (`user_id`);