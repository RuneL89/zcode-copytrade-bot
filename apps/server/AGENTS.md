# apps/server/

## Purpose

The trading runtime. One process serves the REST + SSE API, the built SPA, and
the background worker that monitors leaders, sizes copies, executes paper/live
swaps, mirrors exits, fires traders, hands off to replacements, and reconciles
unknown outcomes. It also hosts the whitelisted operations console and the
operator CLIs.

## Ownership

- API and transport: `src/http/app.ts`, `src/auth.ts`, `src/index.ts`.
- Worker orchestration: `src/services/` (see
  `src/services/AGENTS.md`).
- Runtime wiring and lifecycle: `src/runtime.ts`, `src/bootstrap.ts`.
- Wallet file handling: `src/wallet.ts` — generation, encryption, secret
  loading, public-key lookup, and file-permission checks. It never signs;
  signing happens only in the executor/withdrawal paths.
- Operator CLIs: `src/cli/` — `wallet-create`, `wallet-send`, `setup-token`,
  `demo`, `fomo-import`, `dawn-lookup`, `candidate-activity` (`--source
public|helius`, free public RPC by default), `wallet-activity` (ad-hoc
  single-wallet check, read-only).
- Demo fixture generation: `scripts/generate-demo-fixtures.ts`.

## Local Contracts

- **Single worker instance.** The worker takes an exclusive lock
  (`data/worker.lock`); a second instance refuses to start. Never bypass or
  auto-delete the lock in code.
- **Auth is mandatory on every state-changing route.** Session cookie +
  `requireCsrf` on POSTs; login has an in-memory rate limit. `/internal/*` is
  token-gated instead, for the research import path.
- **Ops are a fixed whitelist.** `src/services/ops.ts` defines every runnable
  command server-side, with a `danger` level and confirmation word. The client
  may only send an op id and the confirmation word. New ops are added in code
  only, behind auth + CSRF + the single-op mutex.
- **Fail closed.** Unknown signed/submitted outcomes become
  `REQUIRES_RECONCILIATION`; never blind-retry. Stale or ambiguous inputs are
  skipped or rejected, not guessed.
- **Paper never signs.** The live executor is constructed only after explicit
  arming; tests and demo mode never construct it.
- **Every dashboard number is traceable.** `src/services/state.ts` is the SSE /
  REST contract; each figure must trace to fixtures, paper calc, or persisted
  evidence with a source and freshness label.
- **Demo replay is in-memory** (`src/services/demo.ts`); it writes nothing to
  live trading tables.
- **Leader data import is operator-driven.** `fomo-import` and `dawn-lookup`
  follow `docs/FOMO_DAWN_FETCHING.md` exactly: clipboard-verified slugs, no
  guessed URLs, built-in pacing, WAL-safe writes while the server runs.
- Secrets (`.env`, wallet file, encryption secret) are never logged, returned
  by an API, or written into audit rows.

## Work Guidance

- Put deterministic trading rules in `packages/core` and keep this app to
  wiring, IO, and orchestration. If a rule needs a unit test without a
  database, it belongs in core.
- Add a new HTTP route in `src/http/app.ts` with `requireAuth`, plus
  `requireCsrf` when it mutates state, and an audit row when it changes
  trading or config.
- Add a new operator action as an `ops.ts` `OpDef`; never expose a raw command,
  argv, or path from the client.
- CLIs are run from this folder with `pnpm exec tsx src/cli/<name>.ts`; they
  must be safe to run while the server is up (WAL mode, no exclusive locks
  beyond what they need).
- Keep `src/index.ts` cache rules intact: hashed `/assets/*` immutable,
  `index.html` always revalidated, missing `/assets/*` returns 404 (never the
  SPA document).

## Verification

- `pnpm --filter @zcode-bot/server test` — `auth-api`, `engine-flow`,
  `daytrader`, `keys`, `ops`, `reports`, `withdraw` suites.
- `pnpm --filter @zcode-bot/server typecheck`
- End-to-end behavior: `pnpm e2e` (the Playwright config boots this server in
  demo mode with an isolated `DATA_DIR`).
- Root gate: `pnpm format:check && pnpm typecheck && pnpm test && pnpm build`.

## Child DOX Index

- `src/services/AGENTS.md` — worker service layer: copy engine, lifecycle,
  monitor, executors, research, state, ops, control.
