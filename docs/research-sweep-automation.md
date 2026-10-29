# Research sweep automation (30-minute cadence, owns the leaderboard refresh)

Active automation, recreated with CronCreate (`0,30 * * * *`). It is the only
component allowed to run Procedure A (the 24h FOMO board refresh), and it also
decides when research is needed.

- **title:** `Every 30 minutes ZCode Bot research sweep (event-driven, capped)`
- **cron:** `0,30 * * * *`
- **recurring:** `true`
- **prompt (verbatim):**

```text
Every-30-minutes ZCode Bot research sweep (event-driven with this 30-minute check as the hard cap, and the owner of the leaderboard refresh). Follow exactly:

1. CHEAP CHECK (read-only, no LLM subagents yet): with better-sqlite3 in readonly mode on C:/Users/atavi/Documents/projects/zcode-bot/data/zcode-bot.db determine all of:
   (a) Does a VALID, unexpired recommendation exist (candidate_recommendations.status/expires_at)?
   (b) Any firing_events rows in the last 26 hours (fired_at)?
   (c) How many enabled trader_candidates have a resolved solana address (join candidate_addresses)?
   (d) POOL FRESHNESS: max(trader_candidates.observed_at), the latest successful leaderboard import (audit category fomo-web-manual), and the latest control_events row with type 'leaderboard_refresh_request'.
2. LEADERBOARD REFRESH (Procedure A stage 0, in the operator's desktop Chrome — never Playwright): needed if max(observed_at) is older than 6 hours, or an unfulfilled leaderboard_refresh_request is newer than the last import. Run at most once per 4 hours.
   Steps: open https://fomo.family/leaderboard?range=24h in desktop Chrome; bring it to the front with WScript.Shell.AppActivate (the computer-use API cannot front a background window) and abort if it is not frontmost; screenshot; for each visible row click it, press Ctrl+L then Ctrl+C, read the clipboard with Get-Clipboard, strip any ?r= parameter. NEVER OCR and NEVER guess a slug. Abort WITHOUT importing if fewer than 5 rows were captured, if any URL is not https://fomo.family/profile/<slug>, or if the range chip is not 24H.
   Then write entries.json [{handle, rank, pnlUsd, profileUrl}] and run, from C:\Users\atavi\Documents\projects\zcode-bot\apps\server: pnpm exec tsx src/cli/fomo-import.ts <entries.json>, followed by pnpm exec tsx src/cli/snapshot-rebuild.ts. Verify max(observed_at) advanced, record the result in the audit trail, and close desktop Chrome. Do NOT disable candidates absent from the fresh list (they would be stranded until Dawn resolves wallets). If the refresh fails, report it and skip research this run.
3. Research is NEEDED only if: no valid unexpired recommendation exists, OR a firing event lacks a replacement, OR the pool of address-resolved candidates grew by 3+ since the last submission.
4. If NEEDED: spawn the subagent with the Agent tool, subagent_type "zcode-research", passing the trigger reason and the current UTC time. NEVER call the mcp__zcode-bot-research__* tools from the main session (all research spend flows through the pinned subagent). The subagent abstains with a POOL_STALE reason when the pool is stale; that abstention is what requested the refresh in step 2.
5. If NOT needed: reply exactly "no-op: research not needed (<one-line reason>)" and end — but if max(observed_at) is older than 6 hours, append the pool age to the reason.
6. Budget: this check plus at most ONE subagent run per sweep. If the database is unreadable or the server is down, reply with the error and end.
```

## Why the sweep owns the fetch

The MCP server and the research subagent are deliberately unable to collect data:
the MCP is a least-privilege file bridge with exactly three tools, and the
subagent's contract forbids running fetching CLIs or GUI automation. The sweep runs
in the main-session model, which has computer-use and is allowed to drive the
operator's Chrome — so it is the only actor that can execute Procedure A.

## Rotation after a refresh

When a recommendation is produced from a fresher pool than the current hire, the
researcher sets `rotateIfFlat: true`. On ingest the engine checks the active
trader: if it holds no open position, no reconciliation case and no in-flight entry
intent, and at least one candidate on the new ordering is actually hireable, it
fires the trader and hires from that ordering. Any other state is skipped and
audited. See `PLAN-leaderboard-refresh-and-rotation.md`.

## Operational notes

- The `zcode-research` agent's model pin requires an explicit reasoning level:
  `deepseek-flash$high` (`.zcode/agents/zcode-research.md`).
- Schema facts the sweep depends on: recommendations in
  `candidate_recommendations`; firings in `firing_events.fired_at`; address coverage
  via `trader_candidates ⋈ candidate_addresses`; freshness via
  `trader_candidates.observed_at`; refresh requests in `control_events.type`.
- better-sqlite3 only resolves from inside `zcode-bot/packages/db` (pnpm layout);
  open the DB file by absolute path from there.

## What else runs server-side (no LLM spend)

- Dawn address lookup (6h), Helius activity refresh (6h), snapshot rebuild (30 min),
  anomaly/daily-PnL Telegram reporter (no-op until `TELEGRAM_*` is filled in).
