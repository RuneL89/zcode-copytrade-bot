# apps/server/src/services/

## Purpose

The worker's service layer. Each file owns one slice of runtime behavior and
the whole set is constructed and scheduled by `runtime.ts`.

| File              | Owns                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`       | The copy engine: classifies leader events, sizes 0.25x copies, evaluates entry risk, plans mirrored exits, records intents. |
| `lifecycle.ts`    | Activation, atomic firing/handoff, replacement, day-trader activity gates, board-presence hire guard (no cooldowns).        |
| `monitor.ts`      | Leader polling timer, cursor persistence, dedupe, restart reconciliation.                                                   |
| `dawn-targets.ts` | Pure Dawn target ordering: walletless-first (freshest board rows), then stale-stats oldest-first.                           |
| `executors.ts`    | The execution boundary: paper simulation vs the armed live signer.                                                          |
| `builder.ts`      | `StateBuilder`: composes the dashboard state from persisted evidence, with source and freshness labels.                     |
| `research.ts`     | Snapshot publication, inbox intake, recommendation validation via `packages/core`.                                          |
| `state.ts`        | `DashboardState` payload contract plus the `StateStore` publish/subscribe used by SSE.                                      |
| `control.ts`      | Pause, emergency stop, close-all, arm/disarm flags.                                                                         |
| `readiness.ts`    | The live-readiness checklist.                                                                                               |
| `demo.ts`         | The in-memory 28-second fictional replay.                                                                                   |
| `reports.ts`      | Server-side Telegram notifications (anomalies + daily PnL); no-op when unconfigured.                                        |
| `withdraw.ts`     | Wallet withdrawal flow and its guards.                                                                                      |
| `ops.ts`          | The fixed whitelisted operations runner.                                                                                    |

Timers are owned by `runtime.ts` (inbox watch, health sampling, snapshot
refresh with the rank watch and the throttled auto-Dawn, activity refresh,
optional adapters) and `monitor.ts` (leader polling). `engine.ts` is called, it
does not schedule itself.

## Ownership

The worker owns all time-sensitive work. ZCode is the research agent only: it
never monitors, sizes, exits, fires, signs, or reconciles.

## Local Contracts

- **Timer ownership is explicit.** Scheduled work starts only in `runtime.ts`
  or `monitor.ts`; other services expose functions and must not start their own
  unbounded loops. `engine.ts` is invoked per event, never on its own timer.
- **Firing is transactional.** Mark `FIRING` and cancel unsigned intents
  atomically, then apply position policy, cooldown, and shortlist consumption
  in that order. A crash must not leave a half-fired trader.
- **Cursor rules.** The monitor sets the leader cursor at activation; activity
  before activation is never copied. Restart resumes forward from the saved
  cursor, and events older than `MAX_COPY_EVENT_AGE_SECONDS` are rejected.
  Dedupe key is `(chain, leader, signature, leg)`.
- **Signing only in `executors.ts`.** No other service may construct a signed
  transaction. Paper fills are simulated and labeled PAPER; live requires armed
  state and readiness.
- **Emergency stop** blocks new entries and non-risk-reducing signing, and
  keeps monitoring/reconciliation running. It cannot recall submitted
  transactions; neither code nor UI may imply otherwise.
- **Research intake is fail-closed.** `research.ts` validates through
  `packages/core/src/recommendation.ts` and rejects with the exact core code
  (`SNAPSHOT_MISMATCH`, `EXPIRED`, `REPLAYED_RECOMMENDATION_ID`, …). An
  exhausted or stale shortlist pauses to `PAUSED_WAITING_FOR_ZCODE`; it never
  invents a trader.
- **`state.ts` is a public contract.** Every field it emits is consumed by the
  dashboard and must carry source + freshness. Do not emit an unlabeled
  estimate.
- **`ops.ts` accepts no command text.** Only an op id and a confirmation word
  from the client; everything else is a server constant. Runs are serialized
  by one mutex.
- **Demo never writes live tables**; `demo.ts` is in-memory and labels every
  emitted state as fictional.

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
  cover their services.
- `pnpm --filter @zcode-bot/server typecheck`
- Root gate before closeout.

## Child DOX Index

None. Nested docs are not warranted at this depth; this file owns the whole
service layer.
