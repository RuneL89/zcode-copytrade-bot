# fixtures/

## Purpose

Example and demo data: a manual leaderboard import in the real import shape,
and the fictional 28-second demo timeline the dashboard replays.

## Ownership

- `leaderboard.example.json` — example manual import (`handle`, `weeklyRank`,
  `displayedPnlUsd`, `profileUrl`, `avatarUrl`, `solanaAddresses`, `enabled`,
  `observedAt`) with obviously fake addresses.
- `leaderboard.example.csv` — the same rows in the CSV import shape (`handle`,
  `weekly_rank`, `displayed_pnl_usd`, `profile_url`, `avatar_url`,
  `solana_addresses`, `enabled`, `observed_at`), including a quoted
  `"+$2,960.00"` cell that exercises the numeric parser.
- `demo-timeline.json` — fictional traders, prices, and handoffs for
  `MODE=demo`, including its `fictional: true` meta block and
  "NOT A PERFORMANCE CLAIM" label.

## Local Contracts

- **Everything here is fictional or an example.** No real trader handles,
  wallet addresses, PnL claims, or private data. Example addresses must be
  visibly invalid placeholders.
- **Demo data never reaches live tables.** Demo replay is in-memory in the
  server; `pnpm db:seed` imports the example leaderboard only when explicitly
  run.
- **Keep the shapes in sync with the parsers.** `leaderboard.example.json` and
  `leaderboard.example.csv` must satisfy
  `packages/providers/src/leaderboard/import.ts`; the timeline must satisfy the
  demo replay in `apps/server/src/services/demo.ts`. A parser change that
  invalidates a fixture must update the fixture in the same change.
- **No secrets and no network data.** Fixtures are static files; never paste
  captured API responses containing keys, cookies, or real accounts.
- **Labels are part of the fixture contract.** Do not remove the fictional
  marker or duration metadata from the timeline; the demo banner depends on it.

## Work Guidance

- Regenerate the timeline with
  `pnpm --filter @zcode-bot/server run fixtures:generate` rather than editing
  numbers by hand, then review the diff.
- Add new example rows sparingly; the file is documentation as much as data.

## Verification

- `pnpm db:seed` against a scratch `DATA_DIR` parses the JSON example.
- SETTINGS → manual import accepts `leaderboard.example.csv` through the CSV
  path with no validation warnings.
- `pnpm demo` replays the timeline end to end (fictional banner visible).
- `pnpm e2e` exercises the same demo path in a browser.

## Child DOX Index

None.
