# packages/db/

## Purpose

Persistence: the Drizzle schema, SQL migrations, the SQLite connection (WAL),
the single-worker lock, the seed script, and every repository function the
server calls.

## Ownership

- `src/schema.ts` — tables. Current families: dashboard user, candidates and
  addresses, leaderboard observations, research snapshots and recommendations,
  activations and leader cursors, observed events, positions, order intents,
  execution attempts, fills, realized PnL lots, loss streaks, firings,
  handoffs, rejections, reconciliation cases, control events, provider health,
  audit events, key/value.
- `src/repo.ts` — all queries.
- `src/connection.ts` — `openDatabase` (WAL, `synchronous=NORMAL`,
  `foreign_keys=ON`, `busy_timeout=5000`) and the worker lock.
- `src/migrate.ts`, `drizzle/` — migrations and drizzle-kit metadata.
- `src/seed.ts` — research dirs + optional example leaderboard import.

## Local Contracts

- **Schema changes are migrations.** Change `schema.ts`, then generate SQL with
  `pnpm db:generate`; never hand-edit an applied migration or the journal.
  Every schema change must keep `pnpm db:migrate` idempotent on an existing
  database.
- **Money is stored as text micro-USD** (`*_usd_micro` / `*_micro` columns),
  matching `packages/core` bigints. Never store a float for an authoritative
  amount.
- **No business logic here.** Repositories read and write; decisions belong in
  `packages/core` and the server services.
- **The worker lock is exclusive** (`data/worker.lock`). Do not add a second
  locking mechanism; the server refuses to start when the lock is held by a
  live PID.
- **Demo fixtures never touch live tables.** `seed` creates the research
  directories and imports `fixtures/leaderboard.example.json` when that file
  exists; the fictional demo timeline is never seeded — demo replay is
  in-memory in the server.
- **Paths anchor at the repo root** (`findRepoRoot` / `resolveDataDir`), not
  `process.cwd()`, because pnpm runs scripts inside this package folder.
- **WAL backups need the side files.** When copying the database, include
  `-wal` and `-shm`, or stop the server first.

## Work Guidance

- Add a table: schema + generated migration + repository functions + a test in
  `test/db.test.ts`, all in one change.
- Name new audit-bearing tables consistently with the existing `*_events` /
  `*_cases` families so the Audit page and state builder can surface them.
- Keep queries parameterized through Drizzle; no string-built SQL.

## Verification

- `pnpm --filter @zcode-bot/db test` — `db.test.ts` (schema/repository
  round-trips on a temp database).
- `pnpm db:migrate` against a fresh `DATA_DIR` and against an existing one.
- `pnpm db:seed` on a scratch data dir.
- Root gate before closeout.

## Child DOX Index

None.
