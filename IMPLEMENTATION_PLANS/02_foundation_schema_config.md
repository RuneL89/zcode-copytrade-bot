# Plan 02 — Foundation: schema, identity, config

Status: COMPLIANT
Implements: the storage and configuration that **D3/D4/D5** require
Depends on: 01

## /goal

Add the persistent state the new pipeline needs — watch events, shadow trades,
watch membership, per-wallet cursors, and the candidate identity — plus the
configurable thresholds from D4. No runtime behaviour changes yet: the app must
boot and behave exactly as before, with the new tables empty and the new settings
inert.

## Decisions implemented

- **D3** identity: candidates keyed by the fomoapi `userId` (and deduped by
  wallet), not by handle.
- **D4** thresholds, configurable in risk settings:
  - admission `N = 3` buys / `X = 24h`
  - promotion `K = 8` closed / net `> $3`
  - watch list `20`, bench target `10`
  - roster `5`
  - per-mint cap `0` (disabled)
  - watch poll `300000 ms`, roster poll `45000 ms`
  - cooling scan `7200000 ms`, eviction `14 days`
  - minimum hire headroom `$20`
- **D5** two cursors per wallet (watch and roster) — the watch cursor is created
  here; the roster cursor remains the existing `leader_cursors`.

## Code changes

### Schema — `packages/db/src/schema.ts`

Add to `trader_candidates`:

- `user_id text` (fomoapi `userId`), with a **unique index** (SQLite allows
  multiple NULLs, so pre-existing rows are unaffected). Keep `handle` as a label.

New tables:

| Table           | Columns                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch_wallets` | `candidate_id` PK, `user_id`, `address`, `status` (`watching`/`cooling`/`promoted`/`archived`), `admitted_at`, `updated_at`, `reason`, `last_funded_buy_at`, `last_funded_sell_at`; index on `status`                                                                              |
| `watch_events`  | `id` PK autoincrement, `candidate_id`, `address`, `signature`, `side` (`buy`/`sell`), `mint`, `token_amount_base`, `decimals`, `usd_micro`, `block_time`, `observed_at`, `source`; **unique** (`candidate_id`, `signature`, `side`); index (`candidate_id`, `side`, `observed_at`) |
| `shadow_trades` | `id` PK autoincrement, `candidate_id`, `mint`, `opened_at`, `entry_price_usd_micro`, `notional_usd_micro`, `status` (`open`/`closed`), `closed_at`, `exit_reason` (`leader_sell`/`ceiling`), `exit_price_usd_micro`, `pnl_usd_micro`; index (`candidate_id`, `status`)             |
| `watch_cursors` | `address` PK, `candidate_id`, `last_signature`, `last_slot`, `last_transaction_index`, `updated_at`                                                                                                                                                                                |

### Migration — `packages/db/drizzle/`

- Generate `0005_*.sql` with the repo's drizzle workflow; update
  `packages/db/drizzle/meta/_journal.json`.
- The migration must be additive only: no dropped columns, no rewritten rows.
  Existing `data/zcode-bot.db` must migrate in place.
- `pnpm db:migrate` applies it to `DATA_DIR`.

### Repo — `packages/db/src/repo.ts`

Add (names are the contract; exact signatures may follow repo style):

- Candidates: `findCandidateByUserId`, `findCandidateByWallet`,
  `upsertCandidateByUser` (upsert on `user_id`, sets handle/wallet/observed_at).
- Watch membership: `upsertWatchWallet`, `getWatchWallet`,
  `listWatchWallets(status?)`, `setWatchStatus(candidateId, status, reason)`.
- Events: `insertWatchEvent` (idempotent on the unique key),
  `listWatchEvents(candidateId, limit)`, `lastFundedBuyAt(candidateId)`,
  `lastFundedSellAt(candidateId)`.
- Shadow: `openShadowTrade`, `closeShadowTrade`, `listOpenShadowTrades`,
  `shadowAggregates(candidateId)` → `{ closedCount, netPnlUsdMicro, lastClosedAt }`.
- Cursors: `getWatchCursor(address)`, `setWatchCursor(...)`.
- Firing history: `lastFiredAt(candidateId)` from `firing_events`.
- Roster (for plan 05): `listActiveActivations()`, `activeActivationCount()`.

### Config — `packages/config/src/risk.ts`

Add to `riskConfigSchema`, `DEFAULT_RISK` and `settingsPatchSchema`:

```
ADMISSION_MIN_BUYS_24H      3      (positive int)
ADMISSION_MAX_LAST_BUY_HOURS 24    (positive int)
PROMOTION_MIN_CLOSED         8     (positive int)
PROMOTION_MIN_NET_USD        3     (positive int)
WATCH_LIST_SIZE              20    (positive int)
BENCH_TARGET                 10    (positive int)
ROSTER_SIZE                  5     (positive int, 1..10)
PER_MINT_CAP_USD             0     (non-negative int; 0 = disabled)
WATCH_POLL_MS                300000 (positive int, >= 60000)
ROSTER_POLL_MS               45000  (positive int, >= 15000)
WATCH_DETAIL_PER_MINUTE      120    (positive int; Helius detail burst)
WATCH_EVICTION_DAYS          14    (positive int)
SHADOW_BACKFILL_ON_ADMIT     true  (boolean)
DISCOVERY_MIN_INTERVAL_MS    1800000 (positive int, >= 600000)
```

Validation rules: `BENCH_TARGET <= WATCH_LIST_SIZE`; `ROSTER_SIZE` 1–10;
`PER_MINT_CAP_USD` may be 0; `WATCH_POLL_MS >= 60000`; `ROSTER_POLL_MS >= 15000`;
`DISCOVERY_MIN_INTERVAL_MS >= 600000`.

### UI — `apps/web/src/pages/Settings.tsx`

- Add the new numeric fields to `EDITABLE_NUMBER_FIELDS` so they render in the
  Risk tab.
- The generic save loop currently rejects `n <= 0`; `PER_MINT_CAP_USD` must be
  allowed to be **0 (disabled)**. Add a per-field exception and a short help line
  under Risk: "0 disables the per-mint cap".
- Add a small section heading note that these are the D4 watch/promotion
  thresholds, so an operator knows what they control.
- No new API route is needed: `/api/settings` already accepts patches validated
  by `settingsPatchSchema`.

## Tests

- `packages/db/test/db.test.ts`: migration on a fresh file creates the four tables
  and the `user_id` column/index; inserting the same event twice is idempotent;
  shadow aggregates sum correctly; cursor round-trip.
- `packages/config/test/config.test.ts`: defaults equal the table above; each
  field is patchable; invalid values rejected (`BENCH_TARGET > WATCH_LIST_SIZE`,
  `ROSTER_SIZE = 0`, negative `PER_MINT_CAP_USD`, `WATCH_POLL_MS < 60000`).
- `apps/server/test/settings-api.test.ts`: a patch with the new fields persists
  and survives a reload; `PER_MINT_CAP_USD=0` is accepted.

## Acceptance criteria

- **AC1** — `0005_*.sql` exists, is additive, and `pnpm db:migrate` applies it to
  a copy of `data/zcode-bot.db` without error or data loss.
- **AC2** — `watch_wallets`, `watch_events`, `shadow_trades`, `watch_cursors`
  exist with the exact columns, types and indexes listed above.
- **AC3** — `trader_candidates.user_id` exists with a unique index; existing rows
  keep NULL and still load.
- **AC4** — inserting the same `watch_events` row twice leaves exactly one row.
- **AC5** — `shadowAggregates` returns the correct closed count and net sum for a
  seeded set of trades.
- **AC6** — `lastFundedBuyAt`/`lastFundedSellAt` return the newest `observed_at`
  for the side, and null when none exists.
- **AC7** — `lastFiredAt` returns the newest `firing_events.fired_at` for the
  candidate, and null when never fired.
- **AC8** — `DEFAULT_RISK` contains exactly the values in the table above, and the
  Settings API returns them.
- **AC9** — `settingsPatchSchema` accepts every new field and rejects
  `BENCH_TARGET > WATCH_LIST_SIZE`, `ROSTER_SIZE = 0`, a negative
  `PER_MINT_CAP_USD`, and `WATCH_POLL_MS < 60000`.
- **AC10** — Saving the new fields from the Settings UI persists them; reloading
  the page shows the saved values; `PER_MINT_CAP_USD = 0` saves and displays.
- **AC11** — No runtime behaviour changes: the app boots, the monitor still runs,
  and every pre-existing test passes unchanged.
- **AC12** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- **AC13** — No divergence from D4's decided thresholds or from D3's `userId`
  identity.

## Out of scope

- Using the tables (plan 03/04).
- Any UI panel other than the Settings fields.
- Removing the old research tables.

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/02_foundation_schema_config.md`.
