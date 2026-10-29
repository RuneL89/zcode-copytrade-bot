ALTER TABLE `trader_candidates` ADD `avg_hold_hours` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `trades_count_7d` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `win_rate_pct` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `realized_onchain_usd` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `stats_checked_at` text;