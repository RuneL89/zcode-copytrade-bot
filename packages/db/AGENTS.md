# packages/db/

## Purpose

Persistence: the Drizzle schema, SQL migrations, the SQLite connection (WAL),
the single-worker lock, read-only opening for replay tools, the seed script,
and every repository function the server calls.

## Ownership

- `src/schema.ts` — tables. Current families: dashboard user, candidates and
  addresses, leaderboard observations, research snapshots and recommendations,
  activations and leader cursors, observed events, positions, order intents,
  execution attempts, fills, realized PnL lots, loss streaks, firings,
  handoffs, rejections, reconciliation cases, control events, provider health,
  audit events, key/value.
- `src/repo.ts` — all queries.
- `src/connection.ts` — `openDatabase` (WAL, `synchronous=NORMAL`,
  `foreign_keys=ON`, `busy_timeout=5000`), `openReadOnlyDatabase` (existing
  file only, `query_only=ON`, `readonly: true`, no migration) and the worker
  lock.
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
- **A failed activity check never writes activity columns.**
  `markCandidateActivityFailed` sets only the status and `updated_at`, so the
  last good reading and its freshness stamp survive a provider outage. The
  successful writer (`updateCandidateActivity`) is called for a complete
  reading (`status: 'ok'`) or a bounded prefix that proved the admission gate
  (`status: 'partial'`); a partial reading is a lower bound, never a 24h
  census.
- **Incomplete admission scans defer via `kv`.** `deferCandidateActivity`
  records the failed status plus an `admission.defer:<candidateId>` eligibility
  key; `listAdmissionScanCandidates` excludes an unexpired key, and a later
  successful `updateCandidateActivity` deletes it. The key is not a freshness
  stamp and never changes the activity columns. The query's optional
  `checkedBefore` cutoff filters recently measured rows before the SQL limit,
  so a one-candidate admission tick cannot be consumed by a fresh head row.
- **Read-only consumers use `openReadOnlyDatabase`.** The weekly report, audits
  and ad-hoc inspections must never open the live file read-write, create it, or
  migrate it.
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
- **Replay tools read a snapshot.** `pnpm sweep` uses SQLite's online backup
  API to snapshot a live WAL DB (no side-file copy), then opens the snapshot
  with `openReadOnlyDatabase`. Replay code never migrates, seeds or writes the
  snapshot.

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
