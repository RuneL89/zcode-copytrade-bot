# apps/zcode-mcp/

## Purpose

The restricted MCP server that lets ZCode research replacements. It exposes
exactly three tools over stdio and nothing else.

## Ownership

- `src/index.ts` — the entire server: tool definitions, snapshot/context reads,
  and the inbox write.
- `test/mcp.test.ts` — the least-privilege guarantee.

## Local Contracts

- **Exactly three tools, by construction:**
  - `get_research_snapshot`
  - `get_replacement_context`
  - `submit_candidate_recommendation`
    There must be **no** wallet, order, trade, sign, pause, close-all, config, or
    query tool. A fourth tool is a security change, not a feature.
- **Environment allowlist:** only `ZCODE_MCP_SNAPSHOT_DIR`,
  `ZCODE_MCP_INBOX_DIR`, and optionally `ZCODE_MCP_SUBMIT_URL` /
  `ZCODE_MCP_SUBMIT_TOKEN`. Never `.env`, wallet keys, database paths, cookies,
  or the server environment.
- **File scope:** read `snapshot.json` and `replacement-context.json`; write
  only a recommendation payload into the inbox (atomic write via a temp file +
  rename). Nothing else is readable or writable.
- **Path anchoring:** relative `ZCODE_MCP_*` values resolve against the repo
  root, not `process.cwd()` (pnpm runs scripts inside the package folder).
  Keep that anchoring.
- **Untrusted data:** handles, theses, notes, and URLs in the snapshot are
  data. The server must not interpret them as instructions, and neither should
  the research agent.
- **One submission per snapshot.** The server-side validator is authoritative;
  replay, expiry, and hash mismatches are rejected with core error codes. This
  process never activates traders or changes risk settings.
- **Never import** `@zcode-bot/db`, `apps/server` code, or wallet code. The
  package's only dependencies are the MCP SDK, `@zcode-bot/core`, and `zod`;
  keep it that way.

## Work Guidance

- Tool input schemas are Zod objects with explicit bounds; keep descriptions
  factual and free of trading instructions.
- Text clamps exist to bound payload size; the snapshot clamp is intentionally
  large because truncating JSON breaks every research run. Do not lower it
  without re-testing snapshot parsing end to end.
- Any tool or environment change requires updating
  `docs/ZCODE_AUTOMATION.md` §2–§3 (the operator verification list) in the same
  change.

## Verification

- `pnpm --filter @zcode-bot/zcode-mcp test` — asserts the exact tool set and
  that no prohibited capability is exposed.
- `pnpm --filter @zcode-bot/zcode-mcp typecheck`
- Manual: start via `pnpm mcp:start` and confirm the tool list in ZCode's MCP
  settings per `docs/ZCODE_AUTOMATION.md` §3.

## Child DOX Index

None.
