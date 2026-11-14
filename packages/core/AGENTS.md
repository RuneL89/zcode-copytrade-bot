# packages/core/

## Purpose

The deterministic heart of the bot: money math, 0.25x sizing, proportional
exits, loss streaks, order/position state machines, event classification and
ordering-free roster rules, watch/promotion gates, and risk evaluation. Pure
functions that the server wires to real providers and persistence.

## Ownership

`money`, `sizing`, `exits`, `streak`, `states`, `orderState`, `tx`, `swap`,
`events`, `activity`, `watch`, `eventOrder`, `risk`, `positionAge`, `transfer`,
`freshness`, `budget`, `exitGuard`, `callPattern`, `deskPolicy`, `swapPrograms`,
`liveGate`.
Everything is re-exported from `src/index.ts`.

## Local Contracts

- **Money is integer micro-USD (`bigint`)**; token amounts are base-unit
  strings with decimals. Never use JS floats for authoritative accounting.
- **The order state machine is guarded** (`orderState.ts`). There is no
  transition from signed/submitted back to quotable. Do not add escape hatches
  for convenience; unknown outcomes stay unresolved until reconciliation.
- **Copy sizing is 0.25x measured input notional**, then the per-trade ceiling
  ($10), the per-trader open cap ($40), and the shared deployed cap (80% of
  the $100 bankroll, so $80). A remainder under the $2 floor is skipped.
  Exit quantities are proportional to the copied share. Code exits (stop,
  trail, sell-on-green, 5h plus 1.5h grace) live in `dayTradeExitDecision`.
- **Watch/bench gates return exact, stable reason codes** (`FEWER_THAN_K_CLOSED`,
  `NET_BELOW_THRESHOLD`, `LAST_BUY_TOO_OLD`, `REENTRY_BANNED`).
  The dashboard shows them verbatim; rename only with a coordinated change.
  A hire is not gated on capital (operator decision, 2026-11-03); entries that do
  not fit the deployed-% cap are still skipped by `MAX_DEPLOYED_PCT`.
- **Fail closed by default.** Ambiguous events are skipped, an unpriced mint or
  a missing quote never invents a fill, and an unproven wallet is reported as
  blocked rather than promoted.
- **Helius spend goes through `CreditGovernor`.** Path caps, the 13,600/day
  hard cap, and the 600,000/month ceiling live in `budget.ts`. Roster and exit
  buckets are ring-fenced. `getTransactionsForAddress` is legal only on the
  vetting and agent paths. Timer loops are checked by `callPattern.ts`.
- **Exit mode is matched.** `guardExitMode` refuses when the executor mode and
  the position mode differ. A refusal does not invent a paper fill.
- **Purity:** no network, database, filesystem, or clock access. The only
  non-local imports are `zod` and type-only imports from `@zcode-bot/config`.
  Time and IDs come from arguments.

## Work Guidance

- New trading rules start here as a pure function with unit tests; the server
  only calls them.
- Keep modules single-purpose and re-export through `index.ts`; consumers
  import `@zcode-bot/core`, never deep paths.
- When changing a rule, update the tests in the same folder and check the
  operator-facing docs (`docs/RUNBOOK.md`, `.env.example`) for a stale
  description.

## Verification

- `pnpm --filter @zcode-bot/core test` — `sizing`, `swap`, `events`,
  `activity`, `watch`, `positionAge`, `transfer`, `budget` suites. The budget
  suite is the free-tier acceptance bar: nominal day at 5,796, hard cap
  13,600, month ceiling 600,000, dead-stream signature-first, watch cap, and
  the 429 storm.
- `pnpm --filter @zcode-bot/core typecheck`
- Any behavior change must have a test that fails before the change.

## Child DOX Index

None.
