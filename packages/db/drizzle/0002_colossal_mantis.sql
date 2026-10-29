ALTER TABLE `trader_candidates` ADD `pnl_24h_usd` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `pnl_7d_usd` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `pnl_30d_usd` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `pnl_all_time_usd` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `rank_24h` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `rank_7d` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `rank_all_time` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `trades_total` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `volume_usd` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `recent_buys` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `recent_sells` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `coins_traded` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `last_trade_age_hours` real;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `swaps_24h` integer;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `last_swap_at` text;--> statement-breakpoint
ALTER TABLE `trader_candidates` ADD `activity_checked_at` text;