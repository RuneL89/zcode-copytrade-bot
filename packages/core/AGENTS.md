# packages/core/

## Purpose

The deterministic heart of the bot: money math, 0.25x sizing, proportional
exits, loss streaks, order/position state machines, event classification and
ordering-free roster rules, watch/promotion gates, risk evaluation, and the
pure counterfactual replay engine that applies those rules to historic signals.
Pure functions that the server wires to real providers and persistence.

## Ownership

`money`, `sizing`, `exits`, `streak`, `states`, `orderState`, `tx`, `swap`,
`events`, `activity`, `watch`, `eventOrder`, `risk`, `positionAge`, `transfer`,
`freshness`, `budget`, `backfill`, `exitGuard`, `callPattern`, `deskPolicy`,
`swapPrograms`, `liveGate`, `paramSweep`, `weeklyReview`.
Everything is re-exported from `src/index.ts`.

## Local Contracts

- **Money is integer micro-USD (`bigint`)**; token amounts are base-unit
  strings with decimals. Never use JS floats for authoritative accounting.
- **The order state machine is guarded** (`orderState.ts`). There is no
  transition from signed/submitted back to quotable. Do not add escape hatches
  for convenience; unknown outcomes stay unresolved until reconciliation.
  `quoted → confirmed` is the PAPER simulation path only; a live executor must
  walk `pending_sign → signed → submitted` so the durable signature exists
  before the send. A pre-sign failure may go `quoted → failed`.
- **Bankroll input is remaining-basis aware.** `bankrollHeadroom` accepts
  `capitalAdjustmentsUsdMicro` (deposits less sent USDC withdrawals) and
  `reservedEntryUsdMicro` (pending entry reservations). Callers pass remaining
  cost basis/fees, not original input, so a partial close releases room. There
  is no daily-loss/drawdown rule (D7); per-position exits and the deployment
  cap are the safety model.
- **Sender constants live here** (`sender.ts`): the published SWQOS tip
  accounts and 5,000-lamport minimum, shared by the executor and the fee ledger.
- **Copy sizing is 0.25x measured input notional**, then the per-trade ceiling
  (10% of current capital), the per-trader open cap (35% of current capital),
  and the shared deployed cap (80% of capital). Capital grows with realized
  PnL and deposits/withdrawals, so the profile holds at any bankroll; the $2
  per-buy floor is absolute and the remainder under it is skipped.
  Exit quantities are proportional to the copied share. Code exits (stop,
  trail, sell-on-green, 5h plus 1.5h grace) live in `dayTradeExitDecision`.
  The hard stop and trail run before the clock; the unconditional grace
  deadline runs before the partial take-profit, so past
  `MAX_POSITION_AGE_HOURS + POSITION_GRACE_HOURS` the position fully exits and
  a failed partial cannot preempt the force-close.
- **Watch/bench gates return exact, stable reason codes** (`FEWER_THAN_K_CLOSED`,
  `NET_BELOW_THRESHOLD`, `LAST_BUY_TOO_OLD`, `REENTRY_BANNED`).
  The dashboard shows them verbatim; rename only with a coordinated change.
  A fired trader is `REENTRY_BANNED` until another trader is hired after the
  firing, or until `COOLDOWN_HOURS` (default 3) elapse while a roster chair is
  free. His shadow record is kept and the same promotion gates apply; there is
  no repeat-fire archive.
  A hire is not gated on capital (operator decision, 2026-11-03); entries that do
  not fit the deployed-% cap are still skipped by `MAX_DEPLOYED_PCT`.
  `stallDecision` uses the newer of that funded buy and a fresh activity sample.
  A seat younger than `LEADER_STALL_FIRE_HOURS` is not stall-fired.
- **Fail closed by default.** Ambiguous events are skipped, an unpriced mint or
  a missing quote never invents a fill, and an unproven wallet is reported as
  blocked rather than promoted. A shadow lot with no mark gets a terminal
  decision only at/after its grace deadline: confirmed no-route -> close at
  zero; transient/missing decimals -> close at zero only after a 24h backstop.
- **Weekly review math is pure and read-only.** `weeklyReview` groups exits,
  attributes the promised-vs-actual gap, correlates pre-hire shadow stats with
  actual P&L, and resolves ISO weeks/schedules. Missing post-exit prices,
  during-seat shadow records, or comparable actual P&L are reported as unknown,
  never estimated.
- **Helius spend goes through `CreditGovernor`.** Path caps, the 13,600/day
  hard cap, and the 600,000/month ceiling live in `budget.ts`. Roster and exit
  buckets are ring-fenced. `getTransactionsForAddress` is legal only on the
  vetting and agent paths. Timer loops are checked by `callPattern.ts`.
  `backfill.ts` also exports the admission/watch detail burst ceiling
  (`WATCH_DETAIL_PER_MINUTE`); the server reads the same default from
  `risk.WATCH_DETAIL_PER_MINUTE`, applies a stricter 12-detail admission
  per-pass budget, and keeps the governor's daily cap as the hard stop. Since
  2026-11-24 the admission scan pays its pages and detail reads from the
  `vetting` bucket, and `vetting` is deliberately excluded from the 75% amber
  ratio: a day of pre-hire scans is normal funnel work and must not trip the
  ladder that pauses the watch-list fallback (it still stops at its own cap
  and still pauses at red).
- **Exit mode is matched.** `guardExitMode` refuses when the executor mode and
  the position mode differ. A refusal does not invent a paper fill.
- **Purity:** no network, database, filesystem, or clock access. The only
  non-local imports are `zod` and type-only imports from `@zcode-bot/config`.
  Time and IDs come from arguments.
- **Replay reuses the rules.** `paramSweep.ts` calls `sizeCopy`,
  `evaluateEntryRisk` and `dayTradeExitDecision`; never fork a rule into the
  simulator. Signals, hire windows and the linear-path assumption are inputs;
  the module has no DB or provider access.

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
  `activity`, `watch`, `positionAge`, `transfer`, `budget`, `paramSweep`,
  `weeklyReview` suites. The budget suite is the free-tier acceptance bar: nominal day at
  5,796, hard cap 13,600, month ceiling 600,000, dead-stream signature-first,
  watch cap, and the 429 storm. `paramSweep` proves the simulator with current
  defaults reproduces a real historic paper sizing decision and the stop /
  target / time exits.
- `pnpm --filter @zcode-bot/core typecheck`
- Any behavior change must have a test that fails before the change.

## Child DOX Index

None.
