# apps/

## Purpose

The three deployable units of ZCode Bot: the trading runtime and API
(`server`), the operator dashboard (`web`), and the restricted research bridge
(`zcode-mcp`). Each has its own process boundary and its own child contract.

## Ownership

- `apps/server` — the worker, HTTP/SSE API, ops console, and CLIs. The only
  process that monitors leaders, sizes, executes, signs, and reconciles.
- `apps/web` — presentation only. It renders server state and sends user
  intents back as API calls.
- `apps/zcode-mcp` — a thin, least-privilege MCP facade over the research
  snapshot/inbox directories. No trading, no secrets, no database.

## Local Contracts

- **Dependency direction is one-way:** `apps/*` may import from `packages/*`;
  `packages/*` must never import from `apps/*`. Trading rules live in
  `packages/core`, not in an app.
- `apps/server` serves `apps/web/dist` in production (`pnpm start`), so a web
  build must exist before a production start; `pnpm dev:web` proxies `/api`.
- The REST/SSE payload shapes are a contract shared by `apps/server` and
  `apps/web`. Changing `apps/server/src/services/state.ts` or
  `apps/web/src/types.ts` requires updating both sides in the same change.
- `apps/zcode-mcp` is environment-isolated: it receives only the
  `ZCODE_MCP_*` variables and must not import `@zcode-bot/db`, server code, or
  wallet code.
- No app may be used to write demo fixtures into live tables; demo replay is
  in-memory in the server.

## Work Guidance

- Add user-visible behavior in the app that owns it, then push any reusable or
  deterministic rule down into `packages/core` with tests.
- Keep each app's `package.json` scripts consistent with the root scripts that
  call them (`pnpm --filter @zcode-bot/<app> run <script>`).
- `apps/web`'s `build` runs `tsc --noEmit` before `vite build`; do not weaken
  that gate.

## Verification

- Per app: `pnpm --filter @zcode-bot/server test`,
  `pnpm --filter @zcode-bot/web test`,
  `pnpm --filter @zcode-bot/zcode-mcp test`.
- Browser behavior: `pnpm e2e` (see `web/e2e/AGENTS.md`).
- Whole repo: the root validation gate — `pnpm format:check && pnpm typecheck
&& pnpm test && pnpm build`.

## Child DOX Index

- `server/AGENTS.md` — trading runtime, API, worker, ops console, CLIs.
  - `server/src/services/AGENTS.md` — worker service layer.
- `web/AGENTS.md` — dashboard, SSE client, settings/audit/ops pages.
  - `web/e2e/AGENTS.md` — Playwright browser suite.
- `zcode-mcp/AGENTS.md` — restricted research MCP server.
