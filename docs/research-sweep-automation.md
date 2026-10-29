# Hourly research sweep automation (currently PAUSED)

Paused at the operator's request until setup completes (Telegram QR scan, Telegram
push credentials). Recreate when resuming with CronCreate using exactly:

- **title:** `Hourly ZCode Bot research sweep (event-driven, capped)`
- **cron:** `0 * * * *`
- **recurring:** `true`
- **prompt (verbatim):**

```text
Hourly ZCode Bot research sweep (event-driven with this hourly check as the hard cap). Follow exactly:

1. CHEAP STALENESS CHECK (read-only, no LLM subagents yet): from directory C:\Users\atavi\Documents\projects\zcode-bot, use Bash with better-sqlite3 in readonly mode on ./data/zcode-bot.db to determine all of:
   (a) Does a VALID, unexpired recommendation exist? Check the latest recommendation's status and expires_at (table: candidate_recommendations; ordering rows in recommendation_candidates — inspect schema with a pragma query if column names differ).
   (b) Were there any firing_events rows in the last 26 hours (a fired trader may need replacement)?
   (c) How many enabled trader_candidates have a resolved solana address in candidate_addresses? Compare against what the last submitted recommendation used (rough count is fine).
2. Research is NEEDED only if: no valid unexpired recommendation exists, OR a firing event lacks a replacement (no valid recommendation newer than the firing), OR the pool of address-resolved candidates grew by 3+ since the last submission (material new supply).
3. If NEEDED: spawn the subagent with the Agent tool, subagent_type "zcode-research", passing a short dispatch message: the trigger reason, the current UTC time, and instruction to follow its own procedure (read snapshot via MCP, submit once). NEVER call the mcp__zcode-bot-research__* tools from the main session (workspace AGENTS.md forbids it — all research spend must flow through the pinned subagent).
   - If the pool is STALE (ranks old, candidates missing wallets), do NOT fetch data yourself and do not ask the subagent to: fetching follows the canonical method in `zcode-bot/docs/FOMO_DAWN_FETCHING.md` (desktop-Chrome GUI for fomo.family, dawn-lookup CLI for wallets) and is a MAIN-SESSION operation. The subagent will abstain on a stale pool by design; report the staleness as the sweep's finding instead.
4. If NOT needed: reply exactly "no-op: research not needed (<one-line reason>)" and end.
5. Budget: this check plus at most ONE subagent run per sweep. If the database is unreadable or the server is down, reply with the error and end.
```

## Operational notes from the first (failed) sweep

- The `zcode-research` agent's model pin requires an explicit reasoning level:
  `deepseek-flash$high` (fixed in `.zcode/agents/zcode-research.md`, commit 45502e8).
- Schema facts the sweep depends on: recommendations live in
  `candidate_recommendations` (columns `status`, `expires_at`); firings in
  `firing_events.fired_at`; address coverage via
  `trader_candidates ⋈ candidate_addresses` on `candidate_id`.
- better-sqlite3 only resolves from inside `zcode-bot/packages/db` (pnpm layout);
  open the DB file by absolute path from there.

## What stays running while the sweep is paused (server-side, no LLM spend)

- Fomo leaderboard fetch + Dawn address lookup (6h schedules; both gated on
  their one-time logins), snapshot rebuild (30 min), anomaly/daily-PnL
  Telegram reporter (no-op until `TELEGRAM_*` is filled in `zcode-bot/.env`).
