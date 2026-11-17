ALTER TABLE `trader_activations` ADD `replaces_activation_id` text;--> statement-breakpoint
ALTER TABLE `shadow_trades` ADD `backfilled` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Provenance for existing lots: the admission backfill replayed buys/sells whose
-- block time precedes the wallet's admission. New rows set the flag explicitly.
UPDATE `shadow_trades`
SET `backfilled` = true
WHERE `opened_at` < (
	SELECT `admitted_at` FROM `watch_wallets`
	WHERE `watch_wallets`.`candidate_id` = `shadow_trades`.`candidate_id`
);--> statement-breakpoint
-- The denormalised last-funded stamps carried the ingestion time; restore the
-- leader's on-chain block time for every wallet that has a usable event.
UPDATE `watch_wallets`
SET `last_funded_buy_at` = (
	SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(`block_time`), 'unixepoch')
	FROM `watch_events`
	WHERE `watch_events`.`candidate_id` = `watch_wallets`.`candidate_id`
		AND `watch_events`.`side` = 'buy'
		AND `watch_events`.`block_time` > 0
)
WHERE EXISTS (
	SELECT 1 FROM `watch_events`
	WHERE `watch_events`.`candidate_id` = `watch_wallets`.`candidate_id`
		AND `watch_events`.`side` = 'buy'
		AND `watch_events`.`block_time` > 0
);--> statement-breakpoint
UPDATE `watch_wallets`
SET `last_funded_sell_at` = (
	SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(`block_time`), 'unixepoch')
	FROM `watch_events`
	WHERE `watch_events`.`candidate_id` = `watch_wallets`.`candidate_id`
		AND `watch_events`.`side` = 'sell'
		AND `watch_events`.`block_time` > 0
)
WHERE EXISTS (
	SELECT 1 FROM `watch_events`
	WHERE `watch_events`.`candidate_id` = `watch_wallets`.`candidate_id`
		AND `watch_events`.`side` = 'sell'
		AND `watch_events`.`block_time` > 0
);--> statement-breakpoint
-- The old archive rule judged a partial, backfilled sample. Re-admit those rows
-- so the forward-only gate can judge them on their own observed closes.
UPDATE `watch_wallets`
SET `status` = 'watching',
	`reason` = 're-admitted: forward-only shadow gate',
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` = 'archived'
	AND `reason` = 'negative shadow record with a full sample';
