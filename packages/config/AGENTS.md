# packages/config/

## Purpose

The single source of truth for runtime configuration: Zod-validated environment
variables, risk defaults, mode rules, and repo-root path resolution used by
every package and app.

## Ownership

- `src/env.ts` — the environment schema and defaults. This is the only place
  `process.env` is parsed.
- `src/risk.ts` — mode schema, `DEFAULT_RISK`, and the shared risk types.
- `src/paths.ts` — `findRepoRoot` / `resolveDataDir`.

## Local Contracts

- **`.env` is the only configuration surface.** No secrets, keys, or operator
  settings are read from code, chat, or the database. Values are entered
  locally by the operator.
- **Fail fast.** Invalid values abort at boot with the Zod error; never
  silently coerce or fall back to an unvalidated value. Defaults are only for
  genuinely optional settings (`MODE=paper`, `PORT=8787`,
  `HOST=127.0.0.1`).
- **`SESSION_SECRET` must be ≥ 32 characters** and has no default; the server
  must refuse to start without it.
- **Paper is the default mode.** Live-only settings stay optional and inert
  until readiness + arming. `AGENT_LIVE_CONTROL` (default false) gates agent
  fire/exit requests while `MODE=live`.
- **No portfolio daily-loss key.** `MAX_DAILY_REALIZED_LOSS_USD` was removed by
  the operator (D7); the loader ignores it and no code reads it. Do not
  reintroduce it without a new decision. Per-position stops and
  `MAX_DEPLOYED_PCT` are the safety model.
- **Paths anchor at the repo root.** `pnpm --filter` runs scripts with cwd set
  to the package folder, so anything using `process.cwd()` for `.env` or
  `DATA_DIR` lands in the wrong place. Use `findRepoRoot(import.meta.url)` and
  `resolveDataDir`, which work identically from `src` (tsx/vitest) and `dist`
  (node).
- **Risk defaults are conservative and typed.** New trading limits get a Zod
  field, a default, and a `DEFAULT_RISK` entry in the same change; apps never
  hardcode limits.

## Work Guidance

- Add a new setting to `envSchema` with a default and a comment naming the
  consumer, then document it in `.env.example` (placeholders only).
- Keep `modeSchema` a closed enum (`demo` | `paper` | `live`); new modes
  require updating the server's readiness and the dashboard labels.
- Do not import provider SDKs here; this package stays dependency-light
  (`zod` only).

## Verification

- `pnpm --filter @zcode-bot/config test` — `config.test.ts` (env parsing,
  defaults, rejections) and `paths.test.ts` (repo-root resolution from
  different cwds).
- `pnpm typecheck` at the root.

## Child DOX Index

None.
