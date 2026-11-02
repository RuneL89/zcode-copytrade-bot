# Plan 04 — Watch list, shadow ledger, promotion (D4)

Status: COMPLIANT
Implements: **D4**
Depends on: 03

## /goal

Turn qualified wallets into observed candidates: record their funded buys and
sells, keep a shadow position per buy with our own exits (leader sell or the
8h+3h ceiling at a live Jupiter price), and promote or demote them with the D4
rules — deterministically, with full audit.

## Decided behaviour

- Admission: **≥3 funded buys in 24h, last funded buy ≤24h** (configurable).
- Shadow: notional `clamp(0.25 × leader input, MIN, MAX)` (D1); close on the
  leader's sell; a position reaching `MAX_POSITION_AGE_HOURS` closes at a live
  Jupiter price, with `POSITION_GRACE_HOURS` when the mark is not positive.
- Promotion: **≥8 closed shadow trades, net > $3** (configurable), last funded
  buy **≤4h**, no re-entry ban, a free roster slot, and free capital.
- Re-entry: a fired trader cannot be promoted until a **funded buy is observed
  after the firing time**; no timed cooldown.
- Watch list **20**, bench target **10** (configurable).
- The fomo PnL mark is context only — never the promotion gate.
- One definition of "funded buy" across the scanner and the copier.

## Code changes

### 1. One classifier — `packages/core/src/swap.ts` (new)

- `classifyFundedSwap(summary: LeaderTxSummary): FundedSwap | null`:
  - buy = exactly one non-funding token leg in, no non-funding leg out, and
    exactly one funding leg out (stable or native SOL above dust);
  - sell = the mirror;
  - returns side, mint, token amount (base), decimals, funding amount (base),
    funding decimals/mint, blockTime, signature.
  - This is the **only** definition. `classifyLeaderEvent` in `events.ts`
    delegates to it for buy/sell and keeps its existing skip reasons; the watch
    scanner and the copier both call it.
- Rewrite `measureCopyableActivity` (`activity.ts`) to count **funded buys and
  sells** via this classifier. Consequence: a token inflow with no funding leg
  (creator-fee distribution, airdrop) is **not** an entry. `entries24h` /
  `lastEntryAt` become funded buys / last funded buy; `exits24h` become funded
  sells.
- Update the `candidate-activity` CLI output and the `trader_candidates` columns
  (`buys_24h`, `last_buy_at`) to the funded definition. `swaps_24h`/`last_swap_at`
  remain "copyable coin movements" and may stay broader; the funded fields are
  what admission and promotion use.

### 2. Watch service — `apps/server/src/services/watch.ts` (new)

Constructor gets: db, risk, a `PublicSolanaProvider`/`HeliusProvider` pair, the
price provider (Jupiter), the lifecycle (for promotion), and an audit callback.

- `admit(candidateId, reading)`:
  - requires the funded reading to be fresh;
  - applies `ADMISSION_MIN_BUYS_24H` / `ADMISSION_MAX_LAST_BUY_HOURS`;
  - inserts `watch_wallets` with `status='watching'`; initialises `watch_cursors`
    at the latest signature (no backlog copied on promotion);
  - optional seed: if `SHADOW_BACKFILL_ON_ADMIT` is true, insert the admission
    scan's funded events with their `block_time` and build shadow trades from
    them (config flag, default true; the verification used a 72h backfill).
- `tick()` (every `WATCH_POLL_MS`, 5 min):
  - for each `watching` wallet: read the cursor, poll signatures (public RPC
    first, Helius fallback), fetch details for new signatures only (Helius
    `getTransaction`, 1 credit), classify with `classifyFundedSwap`;
  - insert `watch_events` idempotently; on buy open a `shadow_trades` row
    (entry price = usd/tokens, notional = D1 clamp); on sell close FIFO lots at
    the leader's price;
  - update `watch_wallets.last_funded_buy_at` / `last_funded_sell_at`;
  - advance the cursor;
  - `closeDueCeilings()`: for open shadow trades at/after
    `MAX_POSITION_AGE_HOURS`, quote Jupiter; if the mark is positive close at the
    deadline, else wait for `+POSITION_GRACE_HOURS` and close regardless. Record
    `exit_reason='ceiling'` and the price actually used.
- `evaluate()` (same tick, after `tick()`):
  - demote wallets with no funded buy for `WATCH_EVICTION_DAYS` (archive);
  - demote wallets with a negative record after enough sample (threshold from
    D4; working: the promotion K with net ≤ 0);
  - for each `watching` wallet run `canPromote`; if true and a slot/headroom is
    free, call `lifecycle.hireFromWatch(candidateId)` (plan 04 wires this to the
    existing `activate()`; plan 05 makes it roster-aware).
- `coolingTick()` (every `COOLING_SCAN_MS`, 2h): scan `cooling` wallets for a
  funded buy after `lastFiredAt`; on one, set `status='watching'`. Archive after
  `WATCH_EVICTION_DAYS` without one.

### 3. Pure rules — `packages/core/src/watch.ts` (new)

- `canPromote({ aggregates, lastFundedBuyAt, lastFiredAt, now, config, slotsFree, headroomUsdMicro })`
  → `{ ok, reason }`. Reasons: `FEWER_THAN_K_CLOSED`, `NET_BELOW_THRESHOLD`,
  `LAST_BUY_TOO_OLD`, `REENTRY_BANNED`, `NO_SLOT`, `NO_HEADROOM`.
- `canReenter({ lastFiredAt, lastFundedBuyAt })` → true when there is no fire or
  a funded buy observed after it. Clock source: `observed_at` (local), no skew.
- `ceilingAction({ openedAt, now, maxAgeHours, graceHours, markUsdMicro, entryUsdMicro })`
  → `none | close_now | close_at_grace`.
- Unit tests use a fake clock for the operator's scenario: zero-trade at 8h,
  one-trade-closed-at-6h fires at 14h, a fired trader cannot return on the old
  record.

### 4. Wiring — `apps/server/src/runtime.ts`

- Construct `WatchService`; start its watch tick (5 min) and cooling tick (2 h)
  when the app runs in paper or live; stop on shutdown.
- On a roster slot becoming free (plan 05) call `watch.evaluate()` immediately;
  in plan 04, call it on boot and after each watch tick.
- `shouldDiscover()` from plan 03 is called when `promotable < free slots` or
  `watch size < BENCH_TARGET`, rate-limited.

### 5. UI — Watchlist panel

New `apps/web/src/components/WatchlistPanel.tsx`, rendered on the Dashboard
(above the positions panel) and reachable from Operations:

- Rows: handle (link to profile), status chip (`watching` / `cooling` /
  `promoted` / `archived`), last funded buy age, funded buys/sells (24h), closed
  shadow trades, net shadow PnL, open exposure, ceiling exposure, blocked reason.
- Actions: **Promote now** (enabled only when `canPromote` is true; disabled with
  the reason), **Archive** (confirm), **Unarchive** for archived rows.
- Footer: bench count vs target, watch size vs cap, next discovery trigger.
- Empty state: "No wallets on the watch list — discovery runs when the bench is
  below 10."
- The panel reads from a new `watchlist` section in `GET /api/state` (extend
  `DashboardState`); SSE updates it.

### 6. State — `apps/server/src/services/state.ts` / `builder.ts`

- Add `watchlist: { size, benchTarget, rows: [...] }` to `DashboardState`.
- `builder.build()` fills it from `repo.listWatchWallets` + aggregates. Every
  number carries its source (`SHADOW_LEDGER`) and freshness (`last event at`).

### 7. Audit

Every transition writes an audit line: `watch admitted`, `watch promoted`,
`watch demoted (reason)`, `watch archived`, `re-entry blocked (no buy since
fire)`, `ceiling closed at $X` (with the price and age).

## Tests

- `packages/core/test/swap.test.ts`: fee distribution is **not** a buy; routed
  buys with no funding leg are not buys; exact one-token/one-funding buys are;
  sells mirror.
- `packages/core/test/watch.test.ts`: promotion truth table (K, net, recency,
  re-entry, slot, headroom); `canReenter` requires a post-fire buy; ceiling
  decision at 8h/11h.
- `apps/server/test/watch.test.ts` (mock providers, fake clock):
  - admission writes `watching`; cursor initialised;
  - a buy opens a shadow trade; a sell closes it at the leader's price;
  - a buy with no sell closes at the ceiling at the quoted price;
  - 3 closed + net > 0 + last buy ≤4h promotes; each failing condition blocks
    with the right reason;
  - re-entry: fired at T, no buy since → `REENTRY_BANNED`; a buy observed after
    T → allowed;
  - eviction after 14 days of inactivity;
  - restart: events/positions/cursors persist and the tick resumes.
- `apps/web` component test or e2e: the panel renders rows and the disabled
  reason; Promote now calls the API only when enabled.

## Acceptance criteria

- **AC1** — There is exactly one funded-swap classifier; the copier
  (`classifyLeaderEvent`), the activity measure and the watch scanner all use
  `classifyFundedSwap`. A synthetic creator-fee distribution is not counted as a
  buy anywhere.
- **AC2** — Admission requires ≥3 funded buys/24h and a last buy ≤24h
  (configurable); a wallet failing either never enters `watching`.
- **AC3** — Every watched buy opens exactly one `shadow_trades` row with
  notional `clamp(0.25×input, MIN, MAX)` and entry price `usd/tokens`.
- **AC4** — A leader sell closes FIFO lots at the leader's price; partial sells
  close proportionally; a sell before admission (no lot) is ignored.
- **AC5** — A position open at `MAX_POSITION_AGE_HOURS` with a positive Jupiter
  mark closes at the deadline; a negative mark rides to
  `MAX_POSITION_AGE_HOURS + POSITION_GRACE_HOURS` and then closes; the exit
  reason is `ceiling` and the price used is stored.
- **AC6** — Promotion requires all of: ≥K closed, net > threshold, last funded
  buy ≤4h, no re-entry ban, a free slot, and free capital. Each failing condition
  produces its specific audit/blocked reason.
- **AC7** — Re-entry: a fired trader with no funded buy observed after
  `firing_events.fired_at` cannot be promoted; a post-fire buy re-admits him.
- **AC8** — Eviction: 14 days without a funded buy archives the wallet; a
  negative record with enough sample demotes it.
- **AC9** — Events are idempotent: the same signature+side never creates two
  shadow trades.
- **AC10** — Restart-safe: after a process restart, cursors, events, open
  positions and statuses are intact and the next tick resumes without replaying.
- **AC11** — The Watchlist panel shows status, last buy age, buys/sells, closed,
  net, open, ceiling and the blocked reason; Promote now is disabled unless
  `canPromote` is true; Archive works.
- **AC12** — `watchlist` is in `DashboardState` and updates via SSE; every number
  carries a source/freshness label.
- **AC13** — The scenario tests pass: 0 trades → 8h idle; one trade closed at 6h
  → 14h idle; a fired trader is not re-promoted on the old record.
- **AC14** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`
  pass; the dashboard e2e passes.
- **AC15** — No divergence from D4: fomo PnL is not a gate; the shadow uses our
  exits; the four-hour recency and the re-entry rule are enforced.

## Out of scope

- Multi-leader roster and shared pool (plan 05).
- Removing the research pipeline (plan 06).
- Paid price history; the ceiling uses a live Jupiter quote at the deadline.

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/04_watchlist_shadow.md`.
