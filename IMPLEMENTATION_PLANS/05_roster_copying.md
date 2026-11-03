# Plan 05 — Roster and copying (T4 / D4 capital rules)

Status: COMPLIANT (AC5 amended 2026-11-03)
Implements: **D4** capital rules and **T4**
Depends on: 04

> **Amendment 2026-11-03 (operator).** A hire is no longer gated on capital:
> AC5's headroom refusal is withdrawn. A wallet that passes the record gates
> takes a free chair even when the pool is fully deployed and copies when room
> frees; capital is enforced per entry instead (`MAX_DEPLOYED_PCT`, which
> downsizes or skips a copy). The "no per-leader budget" part of AC5 stands.
> See DECISIONS.md D4.

## /goal

Replace the single chair with a roster of up to **5 leaders sharing one budget
pool**. Each leader is an independent activation with its own cursor and
positions; a fire frees a slot and the promotion queue fills it; a stuck
reconciliation freezes only its own slot; same-mint bursts are coalesced and the
per-mint cap is configurable (off by default).

## Decided behaviour

- Roster size **5** (configurable 1–10); **shared budget pool**, no per-leader
  slice; first-come.
- A promotion needs a free slot and free capital in the pool (minimum headroom
  configured, working $20).
- One position per mint per leader; same-mint buys within **60 s** are coalesced.
- Per-mint cap across the roster: **configurable, disabled by default**.
- Replacements come from the promotion queue; an empty slot is acceptable.
- A `REQUIRES_RECONCILIATION` activation freezes only its own slot.
- Roster poll every **45 s** per hired wallet.

## Code changes

### Repo — `packages/db/src/repo.ts`

- `listActiveActivations()` (all ACTIVE/FIRING/REQUIRES_RECONCILIATION rows).
- `activeActivationCount()` and `freeRosterSlots(rosterSize)`.
- Keep `activeActivation()` only for legacy callers that plan 06 removes; new
  code must not use it for hiring or monitoring.

### Lifecycle — `apps/server/src/services/lifecycle.ts`

- `activate(...)`: replace the “another trader is already active” refusal with a
  slot check (`count < ROSTER_SIZE`). Keep the eligibility/activity gates, but
  the just-fired exclusion is replaced by `canReenter` from plan 04.
- `hireFromWatch(candidateId)`: the promotion entry point; verifies a free slot
  and the shared-pool headroom (`MIN_HIRE_HEADROOM_USD`), then `activate(...)`.
- `fillRoster()`: loops free slots; takes the top promotable watch wallets by the
  D4 rule; stops when slots or headroom run out or no candidate qualifies.
  Replaces `coldStartHire()` in the runtime; the old ordering path becomes dead
  code for plan 06 to delete.
- `fire(activationId, ...)`: closes that activation's positions (existing
  policy), marks it FIRED, then calls `fillRoster()` instead of
  `resolveReplacement()`. It never blocks another slot.
- `REQUIRES_RECONCILIATION`: a blocked fire leaves its activation in that state;
  `listActiveActivations` continues to include it, but `fillRoster` counts it as
  an occupied slot and the other activations keep trading.
- Disable `rotateIfFlat` in the new path (the board is no longer a universe);
  plan 06 deletes it.

### Monitor — `apps/server/src/services/monitor.ts`

- `tick()`: iterate `listActiveActivations()` instead of one. For each:
  - resolve its Solana address, poll the roster cursor (initialised at hire),
    fetch only new transactions, classify with `classifyFundedSwap`, handle
    buys/sells for that activation's positions;
  - per-activation idle/stall/time-exit discipline as today;
  - one activation failing must not stop the loop for the others (try/catch per
    activation, audit the failure).
- `pollAddress` gains the activation's cursor (the existing `leader_cursors` is
  keyed by address; with one address per candidate that is still correct, but the
  cursor must be initialised when _that_ activation starts, not reused from a
  previous hire of the same address — on activation, reset it to the latest
  signature).
- Shared pool: the engine's `bankrollHeadroom` already sums all open positions;
  no per-leader slice is introduced.

### Engine — `apps/server/src/services/engine.ts`

- Before creating an entry intent:
  - **Coalesce**: if an open position for the same `candidateId` + `mint` was
    opened within 60 s, skip the new copy with reason `COALESCED_SAME_MINT_BURST`
    and an audit line. (No new position; no duplicate spend.)
  - **Per-mint cap**: if `PER_MINT_CAP_USD > 0`, sum the open notional for that
    mint across the roster; skip when adding would exceed it, with
    `PER_MINT_CAP` and the current total. `0` disables the check.
- No other sizing or exit changes.

### Runtime — `apps/server/src/runtime.ts`

- The monitor owns the roster tick (`ROSTER_POLL_MS`).
- On fire completion, `fillRoster()` runs immediately (not on a timer).
- On boot: `fillRoster()` after the watch list loads (catch-up).
- Disable the rank-watch check for the roster path (it was board-based); plan 06
  deletes it.

### State and UI

> The panels below are the **interim functional layout**. Plan 07
> (`07_pipeline_dashboard.md`) replaces the visual layer with the pipeline
> dashboard and roster seats; the data contracts added here are what it renders.

- `DashboardState`: add
  `roster: Array<{ activationId, candidateId, handle, avatarUrl, status, realizedPnlUsdMicro, unrealizedPnlUsdMicro, openPositions, lastSix, streak, fireAfter, sinceIso }>`;
  keep `activeTrader` as `roster[0]` for one release if the web build needs it,
  then remove it in plan 06.
- `builder.build()` fills `roster` from `listActiveActivations()` + per-activation
  aggregates.
- **Roster panel** (`apps/web/src/components/RosterPanel.tsx`, new): a card per
  leader with handle, status, realized/unrealized, open positions count, streak,
  and a **Fire** action. Replaces `ActiveTraderCard` on the Dashboard.
- **Positions** (`PositionsPanel.tsx`): group by leader; each group shows that
  leader's positions and PnL.
- **Promotion queue** (`HiringPipeline.tsx` or the Watchlist panel from plan 04):
  show the ranked promotable wallets and why the next one is not promoted
  (no slot / no headroom / below K).
- **Operations**: `POST /api/fire` and `POST /api/activate` must address a
  specific activation/candidate (not “the active one”). Add a slot/candidate
  selector in the UI; the API rejects an ambiguous call.

### Docs

- `docs/RUNBOOK.md`: roster operations (fire one leader, fill a slot, shared
  pool), reconciliation isolation.
- `AGENTS.md`: the runtime section’s “single worker, one trader” wording updated
  to the roster.

## Tests

- `apps/server/test/roster.test.ts`:
  - activating 5 succeeds; the 6th is refused with `NO_SLOT`;
  - a fire frees a slot and `fillRoster` hires the top promotable wallet;
  - no promotable wallet → slot stays empty, no error;
  - a `REQUIRES_RECONCILIATION` activation does not block the other four;
  - shared pool: a second hire is refused when headroom < `MIN_HIRE_HEADROOM_USD`.
- `apps/server/test/coalesce.test.ts`: 6 same-mint buys in 6 s produce **one**
  position and five `COALESCED_SAME_MINT_BURST` skips; a buy after 60 s creates a
  second position; the per-mint cap skips at the configured total and is a no-op
  at `0`.
- `apps/server/test/monitor-roster.test.ts`: the tick processes two activations
  independently; one provider failure does not stop the other.
- `apps/web` e2e: the roster panel renders five cards; Fire asks for
  confirmation; the positions panel groups by leader.

## Acceptance criteria

- **AC1** — `activate` allows up to `ROSTER_SIZE` active activations and refuses
  the next with a clear `NO_SLOT` reason; the limit is configurable.
- **AC2** — `fillRoster` fills every free slot from the promotion queue, in D4
  rank order, and stops on no candidate or no headroom.
- **AC3** — A fire frees exactly one slot, closes only that leader’s positions,
  and triggers `fillRoster` immediately.
- **AC4** — A stuck `REQUIRES_RECONCILIATION` activation freezes one slot; the
  other activations keep being monitored and can be fired/replaced.
- **AC5** — Shared pool: there is no per-leader budget; a hire is refused when
  the pool headroom is below `MIN_HIRE_HEADROOM_USD`.
- **AC6** — Six same-mint buys within 60 s produce one position and five
  `COALESCED_SAME_MINT_BURST` skip records; a buy after 60 s is copied.
- **AC7** — `PER_MINT_CAP_USD=0` disables the cap; a positive value skips entries
  that would exceed the total across the roster, with a `PER_MINT_CAP` record.
- **AC8** — The monitor iterates all active activations; one provider failure is
  audited and does not stop the others.
- **AC9** — A roster cursor is initialised at hire; a re-hire of the same address
  does not replay the previous hire’s backlog.
- **AC10** — `DashboardState.roster` carries per-leader realized/unrealized PnL,
  open positions, streak and status; the dashboard renders it.
- **AC11** — Fire and activate API calls address a specific activation/candidate;
  an ambiguous call is rejected.
- **AC12** — The positions panel groups by leader and the promotion queue shows
  the blocked reason.
- **AC13** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm e2e` pass.
- **AC14** — No divergence from D4/T4: 5 leaders, shared pool, one position per
  mint per leader, 60 s coalescing, cap configurable and off by default, empty
  slot acceptable, reconciliation isolation.

## Out of scope

- Removing the research pipeline and the old handoff code (plan 06).
- Changing the engine’s entry gates or exit rules.
- Paid price history.

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/05_roster_copying.md`.
