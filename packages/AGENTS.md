# packages/

## Purpose

Shared libraries for the apps. This is where durable domain rules, external
adapters, persistence, and configuration validation live so the runtime apps
stay thin wiring.

## Ownership

- `config` — the only place environment variables and risk defaults are read
  and validated.
- `core` — pure domain logic: money, sizing, exits, loss streaks, state
  machines, event ordering, recommendation validation.
- `providers` — every outbound integration: leaderboard import and adapter,
  Dawn, Helius, Jupiter, pricing, notifications.
- `db` — Drizzle schema, migrations, repositories, SQLite connection.

## Local Contracts

- **Dependency direction:** `config` → `core` → `providers` → `db` → apps.
  A package may depend on packages to its left only; nothing in
  `packages/` may import from `apps/`.
- Packages publish built output (`dist` with declarations) from `src`. Because
  consumers import the built files, `pnpm build` must succeed before tests that
  cross package boundaries.
- Money is integer micro-USD as a bigint in `core`; it is persisted as text
  micro-USD strings in `db`. Never introduce JS floats for authoritative
  accounting at either layer.
- Each package has a `test/` folder next to `src/`; provider tests use mocks
  and fixtures, never real keys or network calls that cost credits.

## Work Guidance

- Before adding a new trading rule, ask whether it belongs in `core` as a pure
  function. If it needs IO, it belongs in `providers` or `db` and the rule
  itself stays in `core`.
- Keep package `exports` explicit; do not reach into another package's internal
  file paths.
- When a package's public surface changes, update every app that imports it in
  the same change.

## Verification

- Per package: `pnpm --filter @zcode-bot/<pkg> test`.
- Types: `pnpm typecheck` at the root covers every package.
- Whole repo: the root validation gate.

## Child DOX Index

- `config/AGENTS.md` — env/risk validation and repo-root path resolution.
- `core/AGENTS.md` — pure domain logic and invariants.
- `db/AGENTS.md` — schema, migrations, repositories.
- `providers/AGENTS.md` — external integrations and their fail-closed rules.
