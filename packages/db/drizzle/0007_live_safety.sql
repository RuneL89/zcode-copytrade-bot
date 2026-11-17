CREATE TABLE `withdrawals` (
	`withdrawal_id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'live' NOT NULL,
	`asset` text NOT NULL,
	`amount_base` text NOT NULL,
	`amount_usd_micro` text,
	`destination` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`signature` text,
	`blockhash` text,
	`last_valid_block_height` integer,
	`idempotency_key` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_withdrawal_idem` ON `withdrawals` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_withdrawal_status` ON `withdrawals` (`status`);--> statement-breakpoint
CREATE INDEX `idx_withdrawal_mode_status` ON `withdrawals` (`mode`,`status`);--> statement-breakpoint
ALTER TABLE `copied_positions` ADD `mode` text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE `copied_positions` ADD `remaining_cost_basis_usd_micro` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `copied_positions` ADD `remaining_fees_usd_micro` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `copied_positions` ADD `mint_decimals` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `copied_positions` ADD `input_decimals` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_position_mode_status` ON `copied_positions` (`mode`,`status`);--> statement-breakpoint
ALTER TABLE `firing_events` ADD `mode` text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE `observed_leader_events` ADD `mode` text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `input_decimals` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `output_decimals` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `reserved_usd_micro` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `blockhash` text;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `last_valid_block_height` integer;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `signed_tx_base64` text;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `signed_at` text;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `submitted_at` text;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `submit_via` text;--> statement-breakpoint
ALTER TABLE `order_intents` ADD `build_kind` text;--> statement-breakpoint
CREATE INDEX `idx_intent_mode_state` ON `order_intents` (`mode`,`state`);--> statement-breakpoint
ALTER TABLE `realized_pnl_lots` ADD `mode` text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE `reconciliation_cases` ADD `mode` text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE `reconciliation_cases` ADD `withdrawal_id` text;--> statement-breakpoint
ALTER TABLE `risk_rejections` ADD `mode` text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE `trader_activations` ADD `mode` text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_fill_intent` ON `fills` (`intent_id`);--> statement-breakpoint
-- Backfill: every existing row belongs to the paper book. Positions infer it
-- from their entry intent where that intent exists.
UPDATE `copied_positions`
SET `mode` = COALESCE(
  (SELECT `mode` FROM `order_intents` WHERE `intent_id` = `copied_positions`.`entry_intent_id`),
  'paper'
);--> statement-breakpoint
UPDATE `realized_pnl_lots`
SET `mode` = COALESCE(
  (SELECT `mode` FROM `copied_positions` WHERE `position_id` = `realized_pnl_lots`.`position_id`),
  'paper'
);--> statement-breakpoint
UPDATE `firing_events`
SET `mode` = COALESCE(
  (SELECT `mode` FROM `trader_activations` WHERE `activation_id` = `firing_events`.`activation_id`),
  'paper'
);--> statement-breakpoint
UPDATE `observed_leader_events`
SET `mode` = COALESCE(
  (SELECT `mode` FROM `trader_activations` WHERE `activation_id` = `observed_leader_events`.`activation_id`),
  'paper'
);--> statement-breakpoint
UPDATE `risk_rejections`
SET `mode` = COALESCE(
  (SELECT `mode` FROM `trader_activations` WHERE `activation_id` = `risk_rejections`.`activation_id`),
  'paper'
);--> statement-breakpoint
UPDATE `reconciliation_cases`
SET `mode` = COALESCE(
  (SELECT `mode` FROM `order_intents` WHERE `intent_id` = `reconciliation_cases`.`intent_id`),
  (SELECT `mode` FROM `copied_positions` WHERE `position_id` = `reconciliation_cases`.`position_id`),
  'paper'
);--> statement-breakpoint
-- Remaining cost basis: original input minus everything already booked as a
-- lot cost. A closed row is fully released; never negative.
UPDATE `copied_positions`
SET `remaining_cost_basis_usd_micro` = CASE
  WHEN `status` = 'closed' THEN '0'
  ELSE CAST(
    MAX(
      CAST(`input_usd_micro` AS INTEGER) - COALESCE(
        (SELECT SUM(CAST(`cost_basis_usd_micro` AS INTEGER)) FROM `realized_pnl_lots`
         WHERE `position_id` = `copied_positions`.`position_id`),
        0
      ),
      0
    ) AS TEXT
  )
END;--> statement-breakpoint
UPDATE `copied_positions`
SET `remaining_fees_usd_micro` = CASE
  WHEN `status` = 'closed' OR CAST(`copied_token_base` AS INTEGER) <= 0 THEN '0'
  ELSE CAST(
    (CAST(`fees_usd_micro` AS INTEGER) * CAST(`remaining_token_base` AS INTEGER))
    / CAST(`copied_token_base` AS INTEGER)
    AS TEXT
  )
END;--> statement-breakpoint
UPDATE `copied_positions`
SET `input_decimals` = CASE
  WHEN `input_mint` = 'So11111111111111111111111111111111111111112' THEN 9
  ELSE 6
END;--> statement-breakpoint
UPDATE `order_intents`
SET `input_decimals` = CASE
  WHEN `input_mint` = 'So11111111111111111111111111111111111111112' THEN 9
  ELSE 6
END;--> statement-breakpoint
UPDATE `order_intents`
SET `reserved_usd_micro` = CASE
  WHEN `kind` = 'entry'
   AND `state` IN ('pending_quote', 'quoted', 'pending_sign', 'signed', 'submitted')
  THEN COALESCE(`input_usd_micro`, '0')
  ELSE '0'
END;
