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
2. LEADERBOARD REFRESH — ALWAYS, EVERY RUN (Procedure A stage 0, in the operator's desktop Chrome — never Playwright). There is NO staleness condition and NO once-per-N-hours cap: every 30-minute run fetches the current 24h leaderboard exactly once, unconditionally, whether or not a valid recommendation exists and whether or not research is needed.
   Steps: open https://fomo.family/leaderboard?range=24h in desktop Chrome; bring it to the front with WScript.Shell.AppActivate (the computer-use API cannot front a background window) and abort if it is not frontmost; screenshot; for each visible row click it, press Ctrl+L then Ctrl+C, read the clipboard with Get-Clipboard, strip any ?r= parameter. NEVER OCR and NEVER guess a slug. Abort WITHOUT importing if fewer than 5 rows were captured, if any URL is not https://fomo.family/profile/<slug>, or if the range chip is not 24H.
   Then write entries.json [{handle, rank, pnlUsd, profileUrl}] and run, from C:\Users\atavi\Documents\projects\zcode-bot\apps\server: pnpm exec tsx src/cli/fomo-import.ts <entries.json>, followed by pnpm exec tsx src/cli/snapshot-rebuild.ts. Verify max(observed_at) advanced, record the result in the audit trail, and close desktop Chrome. Do NOT disable candidates absent from the fresh list. DAWN NEEDS NO SWEEP ACTION: the server auto-runs Dawn after the rebuild whenever the fresh board contains a trader not yet in the master list (walletless enabled candidates), so every new face gets its Solana wallet resolved in the same cycle. If the refresh fails, report it and skip research this run (a failed capture is not a scan; strikes do not advance).
3. Research is NEEDED only if: no valid unexpired recommendation exists, OR a firing event lacks a replacement, OR a control_events row with type 'research_request' exists that is NEWER than the newest recommendation's created_at AND no 'research_dispatched' row is newer than that request (a dispatched request is already being handled by the 5-minute dispatcher; that row means the bot paused hiring because its ordering predated the latest board scan — it wants a fresh ordering now), OR the pool of address-resolved candidates grew by 3+ since the last submission.
4. If NEEDED: spawn the subagent with the Agent tool, subagent_type "zcode-research", passing the trigger reason and the current UTC time. NEVER call the mcp__zcode-bot-research__* tools from the main session (all research spend flows through the pinned subagent). The subagent abstains with a POOL_STALE reason when the pool is stale; that abstention is what requested the refresh in step 2.
5. If NOT needed: reply exactly "no-op: research not needed (<one-line reason>)" and end — mention the board age if the latest import is unusually old.
6. Budget: this check plus at most ONE subagent run per sweep. If the database is unreadable or the server is down, reply with the error and end.
```

## Research dispatcher (5-minute, idle/reactive)

A second automation makes the post-fire research **immediate** instead of waiting
for the next 30-minute sweep. It does nothing unless the bot actually asked for
research, so it costs nothing in steady state.

- **title:** `Every 5 minutes ZCode Bot research dispatcher (only when requested)`
- **cron:** `*/5 * * * *`
- **behaviour:** read-only DB check. If a `control_events` row of type
  `research_request` is NEWER than the newest recommendation's `created_at` and no
  `research_dispatched` row is newer than that request, then (1) run
  `pnpm exec tsx src/cli/candidate-activity.ts --limit 30` from `apps/server`
  (fresh Helius 24h activity for the shortlist), (2) run
  `pnpm exec tsx src/cli/snapshot-rebuild.ts`, (3) write
  `research_dispatched` into `control_events`, and (4) spawn `zcode-research`
  once with the trigger. Otherwise reply `no-op: research not requested`.
  The sweep's trigger (step 3 above) skips requests that were already
  dispatched, so the two automations never double-spend.

Latency from fire to research is therefore one dispatcher interval (≤5 min)
instead of one sweep interval (≤30 min). Research still reads the newest captured
board scan; the dispatcher refreshes on-chain activity first so the activity gate
and the 24h PnL stamps are minutes old, not hours.

## Why the sweep owns the fetch

The MCP server and the research subagent are deliberately unable to collect data:
the MCP is a least-privilege file bridge with exactly three tools, and the
subagent's contract forbids running fetching CLIs or GUI automation. The sweep runs
in the main-session model, which has computer-use and is allowed to drive the
operator's Chrome — so it is the only actor that can execute Procedure A (the board
refresh). Wallet resolution needs no sweep involvement: the runtime runs Dawn once
2 minutes after every boot and then every 6 hours, with an audit line for every
outcome, so it self-heals after restarts. A dead Telegram session is the one state
that needs a human (scan the QR once). Since 2026-10-30 the runtime also
auto-triggers a Dawn run after any snapshot rebuild that sees walletless enabled
candidates (throttled to one auto-run per 20 minutes), so a trader newly seen on
the board gets his wallet resolved within the same cycle.

## Rotation after a refresh

Rotation is only evaluated in the sweep that follows a board refresh: the engine
requires a `board.refreshed_at` marker written within the last 45 minutes, and
skips while the incumbent sits in the top-3 of the latest captured scan. Within
that window, when the researcher sets `rotateIfFlat: true`, the engine checks the
active trader: if it holds no open position, no reconciliation case and no
in-flight entry intent, and at least one candidate on the new ordering is actually
hireable, it fires the trader and hires from that ordering. Any other state is
skipped and audited. Since 2026-10-29 this is enabled in live mode
(`ROTATE_ON_REFRESH=true`); remove that line to return to paper-only. See
`PLAN-leaderboard-refresh-and-rotation.md`.

## Rank-fire rule (server-side, no sweep action needed)

Each snapshot rebuild runs the rank watch: the active trader is fired when absent
from the latest captured scan once, or outside displayed top-3 in two consecutive
scans; both branches stand down when the latest scan is older than 2 hours. Every
hire requires board presence on the latest scan, and there is no fired-trader
cooldown anymore. Audit category `rank-watch`; details in `docs/RUNBOOK.md`.

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

- Dawn address lookup (boot +2 min, then 6h, plus an auto-run after any rebuild
  that sees walletless candidates, throttled to one per 20 min; every run audited
  — `lookup run starting`, `resolved N address(es)`, or `Telegram session needs
login; QR login window opened`), Helius activity refresh (6h + boot), snapshot
  rebuild (30 min) with the rank watch and observation pruning,
  anomaly/daily-PnL Telegram reporter (no-op until `TELEGRAM_*` is filled in).
