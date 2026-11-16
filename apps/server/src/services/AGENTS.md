# apps/server/src/services/

## Purpose

The worker's service layer. Each file owns one slice of runtime behavior and
the whole set is constructed and scheduled by `runtime.ts`.

| File                   | Owns                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`            | The copy engine: classifies leader events, sizes 0.25x copies, evaluates entry risk, plans mirrored exits, records intents.                                                                                                                                     |
| `lifecycle.ts`         | Activation (roster chairs), atomic firing, roster refill from the bench, the D4 bench gate, `canReenter` plus `COOLDOWN_HOURS`, repeat-fire archive, and the seat-open webhook.                                                                                 |
| `monitor.ts`           | Signature-first roster polling, code exits on every tick, cursor persistence per hire, dedupe, restart reconciliation.                                                                                                                                          |
| `rosterStream.ts`      | Push filter: swap-program logs only, and the 60s outage switch back to the signature-first poll.                                                                                                                                                                |
| `heliusStream.ts`      | Live Helius `logsSubscribe` for five seats, hot spare, roster-bucket byte meter, capped gap-fill (60s lookback, 4 transactions, 6 Helius calls per minute), a seat hired later is subscribed without waiting for the safety poll, and the outage poll switch.   |
| `agentHooks.ts`        | Hire decision and tighten-only exit plan. Neither route can arm, sign, or withdraw.                                                                                                                                                                             |
| `discovery.ts`         | The fomoapi discovery inlet and the D5 demand trigger (bench/target, rate limit, credits audit).                                                                                                                                                                |
| `watch.ts`             | The watch list and shadow ledger: admission, funded-swap application, ceilings, bench admission/demotion, cooling rotation.                                                                                                                                     |
| `dawn-targets.ts`      | Pure Dawn target ordering: walletless-first (freshest board rows), then stale-stats oldest-first.                                                                                                                                                               |
| `activity-check.ts`    | One candidate-wallet activity reading: free public RPC primary, Helius fallback; shared by the runtime refreshes and the CLIs.                                                                                                                                  |
| `executors.ts`         | The execution boundary: paper simulation vs the armed live signer. Live submits through `sendPath.ts` (Sender, metered staked send, public RPC) and confirms. Pre-submission failures are retryable `failed`; only ambiguous sends/confirmations are `unknown`. |
| `sendPath.ts`          | The live send ladder. A transport error after the request leaves the process is `unknown` and is not retried.                                                                                                                                                   |
| `txBuild.ts`           | Assembles a Jupiter Swap v2 `/build` body into a legacy transaction and appends the SWQOS tip. Lookup-table messages skip Sender.                                                                                                                               |
| `builder.ts`           | `StateBuilder`: composes the dashboard state from persisted evidence, with source and freshness labels.                                                                                                                                                         |
| `state.ts`             | `DashboardState` payload contract plus the `StateStore` publish/subscribe used by SSE.                                                                                                                                                                          |
| `control.ts`           | Pause, emergency stop, close-all, arm/disarm flags.                                                                                                                                                                                                             |
| `readiness.ts`         | The live-readiness checklist.                                                                                                                                                                                                                                   |
| `demo.ts`              | The in-memory 28-second fictional replay.                                                                                                                                                                                                                       |
| `reports.ts`           | Server-side Telegram notifications (anomalies + daily/weekly summary) and the pure message/positions formatting; no-op when unconfigured.                                                                                                                       |
| `weeklyReview.ts`      | Read-only weekly "promised vs actual" report: DB queries, gap attribution, exit groups, hiring-rule/fired-trader checks, markdown/JSON, and the Monday 08:00 scheduler. Never writes trading state or calls providers.                                          |
| `telegram-commands.ts` | Read-only Telegram commands (`/status`, `/weekly`, `/positions`, `/help`): long-polls `getUpdates`, answers only the operator chat, audits every command. Its loop is started and stopped by `runtime.ts`.                                                      |
| `withdraw.ts`          | Wallet withdrawal flow and its guards.                                                                                                                                                                                                                          |
| `paramSweep.ts`        | Read-only counterfactual replay: maps a DB copy to signals/hire windows, runs the real sizing/risk/exit/promotion rules with alternate parameters, splits train/test, and renders Markdown/JSON. Never applies a parameter.                                     |
| `ops.ts`               | The fixed whitelisted operations runner.                                                                                                                                                                                                                        |

Timers are owned by `runtime.ts`: exactly two monitoring clocks (the watch
list every `WATCH_POLL_MS`, the roster every `ROSTER_POLL_MS`) plus housekeeping
(health, fee ledger, activity refresh, Telegram reports, the weekly review
Monday 08:00, the Telegram command poll).
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
  order. A fired trader also waits out `COOLDOWN_HOURS` (default 36) and
  needs a funded buy observed after the firing. `HIRE_APPROVAL=agent` leaves
  the seat empty and posts the seat-open webhook instead of hiring. A crash
  must not leave a half-fired trader.
- **Cursor rules.** The monitor sets the leader cursor at activation; activity
  before activation is never copied. Restart resumes forward from the saved
  cursor, and events older than `MAX_COPY_EVENT_AGE_SECONDS` are rejected.
  Dedupe key is `(chain, leader, signature, leg)`.
- **Admission reads fail closed.** A failed signature page or transaction
  detail read (including a deferred detail) marks the activity check failed
  via `markCandidateActivityFailed`. The last good activity columns and
  `activity_checked_at` stay intact, no watch row is created, and the
  candidate remains first in line for the next tick. Admission uses the
  strict Helius page and pages backwards to the 24h cutoff; if it cannot prove
  coverage or the in-window detail set exceeds the bounded cap, it fails the
  scan instead of recording a truncated reading. Only a complete read writes
  `ok`; a genuinely empty read still records `ok` zeros and advances the
  queue.
- **Signing only in `executors.ts`.** No other service may construct a signed
  transaction. Paper fills are simulated and labeled PAPER; live requires armed
  state and readiness.
- **Emergency stop** blocks new entries and non-risk-reducing signing, and
  keeps monitoring/reconciliation running. It cannot recall submitted
  transactions; neither code nor UI may imply otherwise.
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
  report and empty-DB path.
- `pnpm --filter @zcode-bot/server typecheck`
- Root gate before closeout.

## Child DOX Index

None. Nested docs are not warranted at this depth; this file owns the whole
service layer.
