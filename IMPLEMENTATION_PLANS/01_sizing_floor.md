# Plan 01 — Sizing floor (D1)

Status: COMPLIANT
Implements: **D1**
Depends on: —

## /goal

Make `MIN_PER_BUY_USD` a hard floor instead of a skip filter. Every copied leader
buy produces at least the floor, even when `0.25 × leader input` is below it.
`MAX_PER_BUY_USD` remains a ceiling. The only skip left is invalid input.

## Decided behaviour

From D1:

```
final = clamp(leader_input × COPY_SCALE, MIN_PER_BUY_USD, MAX_PER_BUY_USD)
```

then clamped by the bankroll headroom (`MAX_DEPLOYED_PCT`). A leader buy whose
scaled copy is below the floor is copied **at the floor**, not skipped. The D1
sub-case is decided too: even when the leader's own buy is below the floor (e.g.
$4), the copy places the floor.

Current behaviour (wrong): `computeCopyNotional` returns `skip_below_min` whenever
`desired < min` because the engine passes `allowBelowMinRoundUp: false`. That
makes the floor a veto on the leader's trade size: every leader buy below $20 is
skipped.

## Code changes

### `packages/core/src/sizing.ts`

- `computeCopyNotional`:
  - `desired = floor(leaderInputUsdMicro × num / den)` (unchanged).
  - `desired > max` → `copy`, `final = max`, `applied = 'capped_at_max'` (unchanged).
  - `desired < min` → `copy`, `final = min`, `applied = 'rounded_up_to_min'`
    (was `skip_below_min`).
  - `leaderInput <= 0` or invalid scale → `skip_invalid` (unchanged).
- `SizingAction`: remove `'skip_below_min'`.
- `SizingResult.applied`: remove `'below_min'`.
- Remove `allowBelowMinRoundUp` from `SizingInput` and the function (no caller
  should need it after this; if a stronger reason to keep it appears, it must
  default to `true` and the plan must be amended).
- Update the doc comment: the floor is absolute; the 0.25× ceiling yields to it.

### `packages/config/src/risk.ts`

- Add a validation that `MAX_PER_BUY_USD >= MIN_PER_BUY_USD`, with a clear error
  message. Both remain configurable in Settings; an inverted pair must be refused
  at parse time, not discovered at order time.

### `apps/server/src/services/engine.ts`

- In `handleLeaderBuy`, call `computeCopyNotional` without
  `allowBelowMinRoundUp`.
- Remove the `sizing.action !== 'copy'` branch that logs
  `'below MIN_PER_BUY_USD (not rounded up)'` and the accompanying
  `MIN_PER_BUY_USD` risk rejection. Keep the branch only for `skip_invalid`
  (`'invalid input'`), if it is reachable.
- Confirm no other code path produces a `MIN_PER_BUY_USD` risk rejection for a
  normal buy.

### UI

`apps/web/src/pages/Settings.tsx`:

- The `MIN_PER_BUY_USD` field help text must say it is a hard floor: "Every
  copied buy is at least this. Leader buys that scale below it are copied at the
  floor." It must not say "minimum to copy" or anything implying a skip.
- No new field is needed; `EDITABLE_NUMBER_FIELDS` keeps `MIN_PER_BUY_USD`.

### Docs

- Grep `README.md`, `docs/RUNBOOK.md`, `docs/AGENTS.md` and `AGENTS.md` for text
  describing a below-minimum skip; update it to the floor semantics.

## Tests

- `packages/core/test/sizing.test.ts`:
  - leader $4.00 → copy $5.00 (`rounded_up_to_min`).
  - leader $7.86 → copy $5.00.
  - leader $19.99 → copy $5.00.
  - leader $20.00 → copy $5.00.
  - leader $21.00 → copy $5.25 (`none`).
  - leader $40.00 → copy $10.00 (`capped_at_max`).
  - leader $0 and negative → `skip_invalid`.
  - no result has `skip_below_min`.
- `packages/config/test/config.test.ts`: `MAX_PER_BUY_USD < MIN_PER_BUY_USD` is
  rejected; equal values are accepted.

## Acceptance criteria

- **AC1** — `computeCopyNotional` with a $4.00 leader input returns `copy`,
  `finalUsdMicro = 5_000_000`, `applied = 'rounded_up_to_min'`.
- **AC2** — $7.86 and $19.99 leader inputs both return `final = $5.00`, not a skip.
- **AC3** — $20.00 returns `final = $5.00`; $21.00 returns $5.25; $40.00 returns
  $10.00; $100.00 returns $10.00.
- **AC4** — zero and negative leader inputs return `skip_invalid`.
- **AC5** — no code path in `packages/core` can return `skip_below_min`, and the
  string no longer appears in `sizing.ts`.
- **AC6** — `engine.handleLeaderBuy` passes no `allowBelowMinRoundUp` argument, and
  no normal buy produces a `MIN_PER_BUY_USD` risk rejection. Only invalid input
  can skip.
- **AC7** — `riskConfigSchema` rejects `MAX_PER_BUY_USD < MIN_PER_BUY_USD` with a
  clear message; equal values pass.
- **AC8** — the Settings UI help text states the floor semantics and does not
  imply a skip.
- **AC9** — docs that described the old skip are updated; no stale "below
  minimum, not rounded up" text remains in the repo.
- **AC10** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build` all
  pass.
- **AC11** — no divergence from D1, including the sub-case: a leader buy below $5
  is copied at $5.

## Out of scope

- Changing `capToHeadroom` (it already treats the minimum as a floor).
- Changing the bankroll or deployment rules.
- Any change to the copy engine's entry gates, exits or sizing source.

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/01_sizing_floor.md`.
