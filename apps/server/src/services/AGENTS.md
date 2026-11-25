# apps/server/src/services/

## Purpose

The worker's service layer. Each file owns one slice of runtime behavior and
the whole set is constructed and scheduled by `runtime.ts`.

| File                   | Owns                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`            | The copy engine: classifies leader events, sizes 0.25x copies, evaluates entry risk, plans mirrored exits, records intents, reserves budget atomically, and reconciles signed/submitted outcomes from chain evidence.                                                                                                                                          |
| `locks.ts`             | In-process `TradingLocks`: entries per activation, exits per position, firing per activation, the budget reservation lock and withdrawals. Lock order is activation → budget/position; never reverse.                                                                                                                                                          |
| `lifecycle.ts`         | Activation (roster chairs), atomic firing, roster refill from the bench, the D4 bench gate, the re-entry block (`canReenter` + `COOLDOWN_HOURS`), hand-off replacement tagging (`replacesActivationId`), and the seat-open webhook.                                                                                                                            |
| `monitor.ts`           | Signature-first roster polling, risk-reducing code exits on ACTIVE and reconciling seats, completion of blocked fires after a full code exit, cursor persistence per hire, dedupe, restart reconciliation.                                                                                                                                                     |
| `rosterStream.ts`      | Push filter: swap-program logs only, and the 60s outage switch back to the signature-first poll.                                                                                                                                                                                                                                                               |
| `heliusStream.ts`      | Live Helius `logsSubscribe` for five seats, hot spare, roster-bucket byte meter, capped gap-fill (60s lookback, 4 transactions, 6 Helius calls per minute), a seat hired later is subscribed without waiting for the safety poll, and the outage poll switch.                                                                                                  |
| `agentHooks.ts`        | Hire decision and tighten-only exit plan. Neither route can arm, sign, or withdraw.                                                                                                                                                                                                                                                                            |
| `discovery.ts`         | The fomoapi discovery inlet and the D5 demand trigger (bench/target, rate limit, credits audit) plus the fomo credit governor: the run interval is paced from `credits remaining × 95% ÷ time left in the calendar month` (core `discoveryBudget`), clamped to [`DISCOVERY_MIN_INTERVAL_MS`, 24h], so the monthly plan is never exhausted early.               |
| `watch.ts`             | The watch list and shadow ledger: admission, funded-swap application, ceilings, bench admission/demotion, cooling re-admission.                                                                                                                                                                                                                                |
| `dawn-targets.ts`      | Pure Dawn target ordering: walletless-first (freshest board rows), then stale-stats oldest-first.                                                                                                                                                                                                                                                              |
| `activity-check.ts`    | One candidate-wallet activity reading: free public RPC primary, Helius fallback; shared by the runtime refreshes and the CLIs.                                                                                                                                                                                                                                 |
| `executors.ts`         | The execution boundary: paper simulation vs the armed live signer. Live validates/builds/simulates, persists signed/submitted evidence through hooks, checks entry balances, submits through `sendPath.ts`, and confirms with the signed transaction's blockhash. Pre-submission failures are retryable `failed`; ambiguous sends/confirmations are `unknown`. |
| `sendPath.ts`          | The live send ladder. A provider signature must equal the locally signed signature; a transport error after the request leaves the process is `unknown` and stops the ladder. Already-processed is sent; preflight/simulation rejection is definitively failed.                                                                                                |
| `txBuild.ts`           | Validates and assembles a Jupiter Swap v2 `/build` body: known Jupiter program, wallet as sole signer/fee payer, compute-unit limit, fresh blockhash, v0/lookup-table resolution, Sender tip, 1,232-byte limit. Partial/instruction-less builds are rejected.                                                                                                  |
| `builder.ts`           | `StateBuilder`: composes the dashboard state from persisted evidence, with source and freshness labels.                                                                                                                                                                                                                                                        |
| `state.ts`             | `DashboardState` payload contract plus the `StateStore` publish/subscribe used by SSE.                                                                                                                                                                                                                                                                         |
| `control.ts`           | Pause, emergency stop, auto-pause, arm/disarm/lock-wallet flags. Disarm/emergency block entries but keep exits signable.                                                                                                                                                                                                                                       |
| `readiness.ts`         | Async live-readiness checklist: mode/ACK/LIVE_TRADING, wallet, provider health, SOL/USDC, cash reconciliation vs the book, pending orders/withdrawals, worker, clock, DB integrity. Blockers gate arming; warnings do not.                                                                                                                                     |
| `demo.ts`              | The in-memory 28-second fictional replay.                                                                                                                                                                                                                                                                                                                      |
| `reports.ts`           | On-demand Telegram report facts for `/status` and `/weekly` plus the pure message/positions formatting. It owns no timers and pushes nothing (2026-11-18: shutdown and fix-worthy issue alerts only).                                                                                                                                                          |
| `weeklyReview.ts`      | Read-only weekly "promised vs actual" report: DB queries, gap attribution, exit groups, hiring-rule/fired-trader checks, markdown/JSON, and the Monday 08:00 scheduler. Never writes trading state or calls providers.                                                                                                                                         |
| `telegram-commands.ts` | Read-only Telegram commands (`/status`, `/weekly`, `/positions`, `/help`): long-polls `getUpdates`, answers only the operator chat, audits every command. Its loop is started and stopped by `runtime.ts`.                                                                                                                                                     |
| `withdraw.ts`          | Live-only, serialized, idempotent wallet withdrawals: a `withdrawals` row written before signing, signed evidence, unknown → reconciliation case, sent USDC reduces capital, chain reconciler.                                                                                                                                                                 |
| `paramSweep.ts`        | Read-only counterfactual replay: maps a DB copy to signals/hire windows, runs the real sizing/risk/exit/promotion rules with alternate parameters, splits train/test, and renders Markdown/JSON. Never applies a parameter.                                                                                                                                    |
| `ops.ts`               | The fixed whitelisted operations runner.                                                                                                                                                                                                                                                                                                                       |

Timers are owned by `runtime.ts`: exactly two monitoring clocks (the watch
list every `WATCH_POLL_MS`, the roster every `ROSTER_POLL_MS`) plus housekeeping
(health, dashboard marks, fee ledger, activity refresh, the 30-second
pre-signature exit retry, the weekly review Monday 08:00, the Telegram command
poll). Dashboard marks refresh
every minute so the builder's five-minute display freshness window does not
expire between 15-minute health samples.
Discovery is demand-driven, not scheduled. Dawn and the native board capture are
manual fallbacks only.
`engine.ts` is called, it does not schedule itself.

## Ownership

The worker owns all time-sensitive work, discovery included: the pipeline is
deterministic (fomoapi → watch list → shadow ledger → bench → roster) with
no LLM in the loop (D6).

## Local Contracts

- **Timer ownership is explicit.** Scheduled work starts only in `runtime.ts`
  or `monitor.ts`; other services expose functions and must not start their own
  unbounded loops. `engine.ts` is invoked per event, never on its own timer.
- **Firing is transactional.** Mark `FIRING` and cancel unsigned intents
  atomically, then apply the position policy and `fillRoster()` in that
  order. A fired trader is blocked until another trader is hired after the
  firing, or until `COOLDOWN_HOURS` (default 3) elapse with a free roster
  chair; his shadow record is kept and the normal promotion gates apply.
  Manual activation obeys the same block. The hand-off hire that fills the
  fired chair is tagged with `replaces_activation_id` and does **not** lift
  the fired trader's block; a later independent hire still does.
  `HIRE_APPROVAL=agent` leaves the seat empty and posts the seat-open webhook
  instead of hiring. A crash must not leave a half-fired trader. A fire blocked
  by failed closes writes a `close_failed` summary case tagged with its
  activation. When the exit-queue retry later fills a `fire_close`, the engine
  callback calls `completeBlockedFire`; a **full code exit on the reconciling
  seat** does the same from the monitor, and startup recovery covers a
  position that is already closed. Signed, unknown, or attributable open
  cases keep it blocked. `fire()` applies only to an `ACTIVE` chair: a
  `FIRING` or `REQUIRES_RECONCILIATION` chair refuses a second fire
  (`SKIPPED_NOT_ACTIVE`) and finishes only through `completeBlockedFire`, so
  a close-out's own losing unit cannot schedule another firing. Startup repair
  also resolves a marked summary whose activation already reached `FIRED` and
  holds nothing.
- **Risk-reducing code exits also run on a frozen seat.** The monitor's
  position sweep runs for `ACTIVE` and `REQUIRES_RECONCILIATION` so a blocked
  fire cannot leave its bag unmanaged past the time/stop rules. The idle and
  stall watchers stay `ACTIVE`-only: calling `fire()` on a blocked activation
  could bypass the signed/unknown case checks.
  A velocity fire (incident 2026-11-25) runs for every ACTIVE seat on
  every tick: more than LEADER_MAX_EVENTS_PER_10MIN observed leader events
  in 10 minutes fires the seat through the normal transactional path
  (an event machine at 54 events/min burned ~350 roster credits per 5
  minutes and stopped the desk). The runtime ingest path backs this with a
  per-address 10-minute limiter (ingestWindow) that drops detail fetches
  past the same ceiling until the window rolls, and it resolves the owning
  activation BEFORE any paid fetch so pushes for non-seats cost nothing.
- **The shadow gate is forward-only.** Admission-replayed events are written
  with `source='backfill'` and their lots with `backfilled=1`;
  `shadowAggregates` excludes backfilled lots by default. Promotion/demotion
  judge forward closes only. A negative archive also requires **zero open
  lots** ("full sample" means the forward record is complete). The funded-buy
  stamps and `lastFundedBuyAt` use the leader's on-chain block time, never the
  ingestion time; a missing block time fails closed rather than reading an old
  buy as fresh. A coin-for-coin rotation (side `swap`, operator decision
  2026-11-22) mirrors both legs at one price: the incoming coin's USD value
  closes the outgoing lots FIFO and opens the incoming lot; an unpriceable
  incoming coin leaves the ledger untouched. The engine mirrors rotations the
  same way (`handleLeaderRotate`): a stale or unpriced rotation trades
  neither leg and records `MAX_COPY_EVENT_AGE_SECONDS` / `ROTATION_UNPRICED`
  rejections; otherwise the outgoing position exits through the normal
  leader-exit path (proportional, no-op when not held) and the incoming coin
  enters through the normal leader-buy path sized at 0.25x of its swap-time
  USD value inside every existing cap — while entries are paused the exit
  still mirrors and the entry records the gate's skipped intent.
- **Cursor rules.** The monitor sets the leader cursor at activation; activity
  before activation is never copied. Restart resumes forward from the saved
  cursor, and events older than `MAX_COPY_EVENT_AGE_SECONDS` are rejected.
  Dedupe key is `(chain, leader, signature, leg)`.
- **Pre-signature exit failures are retried safely.** An exit that fails before
  a signature is written to `exit.queue:<positionId>` with its original plan.
  `runtime.ts` drains the queue every 30 seconds. A retry requires the intent to
  still be `failed` with no `tx_signature`, the position to be open or
  partially closed, and the remaining base to equal the queued base. It retries
  at most `EXIT_QUEUE_MAX_ATTEMPTS` (4) with 30/60/120-second backoff, then
  audits exhaustion and leaves the code exits as the backstop — the monitor
  sweeps a `REQUIRES_RECONCILIATION` seat too. A signed,
  submitted, unknown, or reconciliation-owned intent is never retried; a retry
  never freezes the chair. A signed transaction that the chain proves expired
  (past `lastValidBlockHeight + 150`, no status) is archived in the intent
  reason and may be retried; a status read failure leaves it pending.
- **Reconciliation is chain-evidence based.** `engine.reconcileSignedIntents`
  processes signed, submitted and signature-bearing `requires_reconciliation`
  intents; `withdraw.ts` does the same for withdrawals. The runtime runs both at
  boot and every 30 s. A confirmed transaction is booked from actual token
  deltas; an on-chain failure releases the position for the monitor; a live
  blockhash stays pending.
- **Admission reads fail closed, but a busy wallet is not disqualified.** A
  failed signature page or transaction detail read marks the activity check
  failed via `markCandidateActivityFailed`; the last good activity columns and
  `activity_checked_at` stay intact. Admission is paid from the `vetting`
  credit path (the pre-hire budget — never `watch`, so a day of deep scans can
  neither drain nor pause the watch-list fallback), uses the strict page and
  pages backwards to the 24h cutoff, and scans one candidate per watch tick.
  It idles while the watch list is full (audited once on the flip, not per
  tick) — scanning to be turned away spends pre-hire credits for nothing. A
  window that fits the detail budget is detailed in full and written as `ok`;
  a busier wallet (or one that does not fit in three pages) gets a bounded
  newest-prefix reading instead: the newest 24 in-window signatures, deepened
  in 12-detail batches beyond that only while the base window's buy rate can
  still reach `ADMISSION_MIN_BUYS_24H` and buys keep appearing (a run of
  24 reads without a new buy stops the deepening), up to
  `ADMISSION_MAX_DETAILS_PER_SCAN` (default 60) and stopping the moment the
  gate is proven. A proven prefix admits the wallet and is written as
  `partial` — a lower bound, never an `ok` census. A wallet still below the
  gate keeps the last good columns and defers on an escalating ladder
  (30 min, 2h, 8h, 24h) tracked by an `admission.attempts:<candidateId>` key
  in `kv`; `updateCandidateActivity` clears the counter when a real reading is
  recorded, and a complete census below the gate records the census first (a
  trading wallet is not re-read at full depth every round-robin), while a
  genuinely empty (complete) read records `ok` zeros and rejoins the pool's
  normal rotation. The scan also stores the wallet's newest on-chain
  signature (`admission.tip:<candidateId>`): an unchanged tip — nothing new
  on-chain since the scan that found it below the gate — answers the reading
  from the free signature page without paying a single detail read. Every
  detail read goes through `helius.transactionParty`, so the scan knows WHY it
  could not prove the gate and says so in the defer audit: the wallet signed
  the transaction, only owns the balances that moved (third-party/bot
  execution — real trade evidence since 2026-11-22), or is no party at all.
  When two full batches are readable and none of them is the wallet's own,
  the pattern is established: the scan stops early (platform-style trading
  account whose trades live on executor hot wallets — unprovable from this
  address) and the ladder backs off. A credit-governor refusal is not the
  candidate's fault: the whole admission scan rests 15 minutes
  (`admissionSuspendedUntil`) because no candidate can spend; a 429 backoff
  or the per-pass `WATCH_DETAIL_PER_MINUTE` budget waits ten minutes on the
  candidate; any other thrown scan backs that candidate off on a private
  10 min → 30 min → 2h → 8h ladder. Freshness
  is filtered in SQL before the one-candidate limit, so a recently checked
  head row cannot consume the tick.
- **The watch list is a funnel cap, not a seat for life.** On every tick, a
  watching wallet that has not bought for longer than admission's own
  freshness rule (`ADMISSION_MAX_LAST_BUY_HOURS`) — with no open shadow lot —
  is _released_ via `repo.releaseWatchWallet`: the membership row, cursor and
  admission bookkeeping are deleted and the slot returns to the queue, while
  the observed events and lots stay so a later re-admission continues the same
  forward record. This is distinct from the eviction archive (irreversible,
  `WATCH_EVICTION_DAYS`) and from the negative-sample demotion; releasing
  cannot lose promotable evidence and keeps admitted-but-stale wallets from
  clogging the cap (`admission failed: watch list is full`).
- **Watch-list detail reads are public-only by default.** Helius is a bounded
  15-read/minute safety valve only for watched wallets with an open shadow
  position or a funded buy inside the last hour; idle watchers retry on the
  next 5-minute watch poll. The roster push stream's safety backstop is 10
  minutes and only advances cursors; the outage poll remains 45 seconds and may
  inspect the newest 25 fresh details per tick.
- **An unpriceable shadow lot has a terminal state.** At/after
  `MAX_POSITION_AGE_HOURS + POSITION_GRACE_HOURS`, a confirmed Jupiter no-route
  closes the lot at `exit_reason='unpriceable'`, `exit_price_usd_micro='0'`,
  `pnl_usd_micro=-notional`, plus an audit row. A transient failure (429/5xx/
  network) or missing decimals stays open and retries; it closes at zero only
  after a 24-hour wall-clock backstop past the grace deadline. Closing updates
  the lot before the next tick, so it cannot double-close.
- **Shadow exit audits label the actual decision.** `closeDueCeilings` writes
  `shadow exit <decision> at $<price> after <age>h (max …, grace …)` and puts
  `decision` + `ageHours` in the audit data. Never hardcode a ceiling label for
  a stop, trail, green, bounce or grace-expired close.
- **Signing only in `executors.ts`.** No other service may construct a signed
  transaction. Paper fills are simulated and labeled PAPER; live requires armed
  state and readiness. The live executor validates the build, persists
  `signed`/`submitted` evidence through hooks before the send, and re-checks the
  seat/armed/pause state before signing and again before submitting.
- **Books are mode-scoped.** Engine, lifecycle, monitor, builder, withdrawals
  and reports pass the current mode. A live engine cannot close a paper
  position (and vice versa); paper rows never count toward live equity, caps or
  seats. Live starts with a clean book.
- **Entry caps are reservations.** The budget lock recomputes exposure, sizes,
  checks the per-mint/trader/bankroll caps and inserts the intent with
  `reserved_usd_micro` atomically. Exposure includes remaining cost basis/fees,
  pending reservations and unresolved entries. Partial closes release basis.
- **Arming is a gate.** Readiness is async and includes chain balances plus cash
  reconciliation; `restoreLiveArming` re-runs it, mounts the executor for exits
  even when disarmed, and boot-disarms entries if a blocker remains. Disarm and
  emergency stop keep exits signable; `lock-wallet` (flat only) forgets the key.
- **Withdrawals are live-only and idempotent.** `withdraw.ts` refuses paper
  mode, serializes with the withdraw lock, writes the `withdrawals` row before
  signing, and turns an unknown broadcast into a reconciliation case that blocks
  further withdrawals. Sent USDC reduces capital.
- **Emergency stop** blocks new entries, disarms and keeps exits signable plus
  monitoring/reconciliation running. It cannot recall submitted transactions;
  neither code nor UI may imply otherwise. Clearing it does not re-arm.
- **Nothing external writes trading state.** The retired research intake is gone (D6); the only writers are the worker's own services and the dashboard's authenticated, CSRF-guarded routes.
- **`state.ts` is a public contract.** Every field it emits is consumed by the
  dashboard and must carry source + freshness. Do not emit an unlabeled
  estimate. The redesigned dashboard's additive read-only fields are
  `roster[].series` (cumulative realized/live PnL), `positions[].exitPlan`
  (the effective tightened plan, or null), `pipeline.hiresToday`,
  `watchlist.rows[].reason` and `activity[].leaderHandle`; the `/api/rejections`
  response also returns `candidateRejections` with handles resolved. These are
  display evidence only — no trading behavior reads them.
- **`ops.ts` accepts no command text.** Only an op id and a confirmation word
  from the client; everything else is a server constant. Runs are serialized
  by one mutex.
- **Demo never writes live tables**; `demo.ts` is in-memory and labels every
  emitted state as fictional.
- **Replay services are read-only.** `paramSweep.ts` opens a DB snapshot with
  `openReadOnlyDatabase`, makes no provider calls, writes no trading row, and
  never applies a parameter. Its only output is a report the operator reads.

## Work Guidance

- Change behavior in the owning service; put cross-cutting sequencing in
  `lifecycle.ts` or `engine.ts` rather than duplicating it.
- Never import `ops.ts` into the engine — the engine must not be able to run
  shell operations.
- New trading rules go to `packages/core` as pure functions with tests; wire
  them here.
- When a service gains a new persisted artifact or audit event, update
  `packages/db/src/schema.ts` and the repository in the same change.

## Verification

- `pnpm --filter @zcode-bot/server test` — `engine-flow.test.ts` covers the
  lifecycle, firing, and handoff; `ops.test.ts`, `withdraw.test.ts`,
  `reports.test.ts`, `daytrader.test.ts`, `auth-api.test.ts`, `keys.test.ts`
  cover their services; `param-sweep.test.ts` covers the read-only mapping,
  report and empty-DB path; `live-safety.test.ts` covers build validation, send
  classification, durable signed state + chain reconciliation, readiness cash
  reconciliation and mode-scoped exits; `live-send.test.ts` covers the signer
  and send ladder with stubs.
- `pnpm --filter @zcode-bot/server typecheck`
- Root gate before closeout.

## Child DOX Index

None. Nested docs are not warranted at this depth; this file owns the whole
service layer.
