# packages/core/

## Purpose

The deterministic heart of the bot: money math, 0.25x sizing, proportional
exits, loss streaks, order/position state machines, event classification and
ordering, recommendation validation, eligibility, and risk evaluation. Pure
functions that the server wires to real providers and persistence.

## Ownership

`money`, `sizing`, `exits`, `streak`, `states`, `orderState`, `recommendation`,
`eligibility`, `shortlist`, `events`, `eventOrder`, `risk`, `positionAge`,
`transfer`. Everything is re-exported from `src/index.ts`.

## Local Contracts

- **Money is integer micro-USD (`bigint`)**; token amounts are base-unit
  strings with decimals. Never use JS floats for authoritative accounting.
- **The order state machine is guarded** (`orderState.ts`). There is no
  transition from signed/submitted back to quotable. Do not add escape hatches
  for convenience; unknown outcomes stay unresolved until reconciliation.
- **Copy sizing is 0.25x measured input notional**, bounded by the configured
  per-buy, per-position, exposure, and daily limits. Exit quantities are
  proportional to the copied share.
- **Recommendation validation returns exact, stable codes**
  (`SNAPSHOT_MISMATCH`, `EXPIRED`, `REPLAYED_RECOMMENDATION_ID`, …). The server
  and the audit UI depend on these strings; rename only with a coordinated
  change.
- **Fail closed by default.** Ambiguous events are skipped, stale
  recommendations rejected, and exhausted shortlists reported as exhausted
  rather than filled with an invented candidate.
- **Purity:** no network, database, filesystem, or clock access. The only
  non-local imports are `zod`, `node:crypto` (`createHash` for the snapshot
  digest), and type-only imports from `@zcode-bot/config`. Time and IDs come
  from arguments.

## Work Guidance

- New trading rules start here as a pure function with unit tests; the server
  only calls them.
- Keep modules single-purpose and re-export through `index.ts`; consumers
  import `@zcode-bot/core`, never deep paths.
- When changing a rule, update the tests in the same folder and check the
  operator-facing docs (`docs/RUNBOOK.md`, `.env.example`) for a stale
  description.

## Verification

- `pnpm --filter @zcode-bot/core test` — `sizing`, `recommendation`,
  `events`, `positionAge`, `transfer` suites.
- `pnpm --filter @zcode-bot/core typecheck`
- Any behavior change must have a test that fails before the change.

## Child DOX Index

None.
