# Research fast tick (5 minutes; research immediately on fire, board every ~30 min)

Active automation, recreated with CronCreate (`*/5 * * * *`). It is the only
component allowed to run Procedure A (the 24h FOMO board refresh), and the actor
that turns the engine's `research_request` into a research run.

Two duties, cheapest path first:

1. **Research-first (the immediate post-fire trigger).** When a
   `research_request` control row is newer than the newest recommendation and has
   no newer `research_dispatched` claim, the tick writes the claim and spawns
   `zcode-research` immediately — no board refresh in that tick. Latency from a
   fire to research therefore is at most one tick (≤5 min) instead of the old
   ≤30 min. If the run fails to produce a recommendation, the claim is deleted so
   the next tick retries.
2. **Board refresh, about every 30 minutes.** Procedure A runs when the newest
   captured scan is older than 25 minutes. The refresh cadence is unchanged from
   the old 30-minute sweep; only the check cadence is faster. A scan is never
   skipped just because a recommendation exists.

An abstention newer than the request is respected: research re-arms only after a
new board import (or 30 minutes later), so a thin pool cannot burn a run every
5 minutes.

**Research is hire-time only (2026-10-30).** Research runs when the engine wants
to hire and has no spendable ordering — nothing else. Concretely: the post-fire
request above, a paused cold start with no valid ordering, or a firing whose
handoff never produced a replacement. There are deliberately NO speculative
triggers: an expired ordering while a trader is active does NOT re-run research
(it would refill a shelf the freshness guard refuses to spend from), and pool
growth does not either (the next hire-time run sees the bigger pool). This made
rotation dormant: `rotateIfFlat` arrives inside research orderings, and no
speculative research means no rotation while a trader is active — the rank-fire
rule is the momentum mechanism that remains. An abstention newer than the
request re-arms research only after a new board import (or 30 minutes), so a
thin pool cannot burn a run every 5 minutes.

- **title:** `Every 5 minutes ZCode Bot fast tick (research immediately on fire, board every ~30 min)`
- **cron:** `*/5 * * * *`
- **recurring:** `true`

## Why the tick owns the fetch

The MCP server and the research subagent are deliberately unable to collect data:
the MCP is a least-privilege file bridge with exactly three tools, and the
subagent's contract forbids running fetching CLIs or GUI automation. The fast tick runs
in the main-session model, which has computer-use and is allowed to drive the
operator's Chrome — so it is the only actor that can execute Procedure A (the board
refresh). Wallet resolution needs no tick involvement: the runtime runs Dawn once
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
