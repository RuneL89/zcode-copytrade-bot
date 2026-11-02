# Plan 06 — Runtime cadence and retire the research pipeline (D5 / D6)

Status: COMPLIANT
Implements: **D5**, **D6**
Depends on: 05

## /goal

Make the runtime demand-driven with exactly two intentional monitoring clocks
(watch 5 min, roster 45 s), add boot catch-up, and delete the LLM research
pipeline and everything that existed only to serve it — code, UI, automations,
docs and agent configuration.

## Decided behaviour

- **D5:** discovery runs only when a slot is free and promotable < free slots, or
  the bench is below `BENCH_TARGET`; rate-limited. Watch poll 5 min; roster poll
  45 s. When the roster and bench are full, external spend is zero. Boot
  catch-up: discover if thin, poll watched wallets once, re-init roster cursors.
- **D6:** the research pipeline is retired — snapshot, MCP server, pinned agent,
  ordering validation/TTL/replay, handoff, rotation, `paused_for_fresh_research`,
  the 5-minute tick, and the research control events.

## Code changes

### 1. Scheduler — `apps/server/src/runtime.ts`

- Remove `snapshotTimer` (30 min), `snapshotDebounceTimer`,
  `inboxWatcher`/`inboxTimer` (5 s), the `fomoWebTimer` and the boot
  `fomoWebImportNow()` (if plan 03 did not already), and the research/ordering
  triggers.
- Keep exactly two monitoring clocks:
  - `watchTimer` → `WATCH_POLL_MS` (300 000);
  - `rosterTimer` → `ROSTER_POLL_MS` (45 000).
    Health (60 s), fee ledger (10 min), symbol resolution and reports remain
    housekeeping, not discovery/monitoring; document that distinction in the
    runtime comment.
- Add the demand trigger:
  - after a fire / slot free → `fillRoster()`; if it cannot fill, call
    `discovery.syncIfNeeded()` (bench thin or promotable < free slots);
  - on each watch tick → if `promotable < BENCH_TARGET`, `syncIfNeeded()`;
  - rate limit `DISCOVERY_MIN_INTERVAL_MS` (30–60 min).
- Boot catch-up (`start()`):
  1. `discovery.syncIfNeeded()`;
  2. one `watch.tick()` for every watching wallet;
  3. `fillRoster()`;
  4. start the two clocks.

### 2. Delete the research pipeline

Remove code and wiring:

- `apps/server/src/services/research.ts` (`SnapshotService`,
  `RecommendationService`), `apps/server/src/cli/snapshot-rebuild.ts`.
- `apps/zcode-mcp/` (package, src, tests, dist), its workspace references,
  `pnpm-lock` entry, and the `zcode-bot-research` MCP entry in
  `.zcode/config.json`.
- `.zcode/agents/zcode-research.md`.
- `apps/server/src/services/ops.ts`: the snapshot-rebuild / recommendation import
  ops.
- `apps/server/src/http/app.ts`: the research submit endpoint and any
  recommendation import route.
- `packages/core/src/recommendation.ts` (snapshot + payload schemas) if unused
  after the above; `shortlist.ts`, `boardRank.ts` (rank-fire), and the
  `eligibility.ts` pieces used only by the old hire path — **only** remove what
  `grep` proves unused by the roster/watch path.
- `lifecycle.ts`: `resolveReplacement`, `consumeShortlist` usage,
  `deriveJustFiredExclusion`, `rotateIfFlat`, `lastRotationRecommendationId`,
  handoff-event writes, `paused_for_fresh_research`.
- `runtime.ts`: `recommendations.onRotationRequest`,
  `onRecommendationValidated`, `refreshLifecycleRecommendation`,
  `recommendationsAuditRotationError`.
- Control events: stop writing `research_request`, `research_dispatched`,
  `replacement_request`, `leaderboard_refresh_request`.
- Tables `research_snapshots`, `candidate_recommendations`,
  `recommendation_candidates`, `recommendation_choices`, `handoff_events`: no
  code reads or writes them. **Do not drop the data**; mark them legacy in
  `schema.ts` comments. (A destructive migration is out of scope.)
- ZCode automations: delete the “Every 5 minutes research tick” and the
  “30-minute data sweep” automations (CronDelete), and update the docs that
  reference them.

### 3. State and UI

- `state.ts`: remove `activeTrader` (or keep it as `roster[0]` for one release;
  prefer removing it now that the UI uses `roster`), the handoff stage, and the
  `PAUSED_WAITING_FOR_ZCODE` / `PAUSED_FOR_FRESH_RESEARCH` states.
  `appState` becomes: `RUNNING`, `PAUSED_NO_TRADER`, `PAUSED_NEW_ENTRIES`,
  `EMERGENCY_STOPPED`, `REQUIRES_RECONCILIATION`.
- `builder.ts`: remove `lastHandoff`, the handoff-driven paused states, the
  snapshot/recommendation fields.
- `apps/web/src/components/HandoffOverlay.tsx`: delete.
- `apps/web/src/components/HiringPipeline.tsx`: either becomes the promotion
  queue from plan 05 or is deleted; no research/ordering content remains.
- `apps/web/src/pages/Settings.tsx`: remove the “ZCode recommendation” import
  card and any snapshot count. Keep the manual FOMO import labelled “fallback”.
- `apps/web/src/pages/Operations.tsx`: remove snapshot rebuild/recommendation
  actions.
- E2E: delete the fired-handoff animation tests; add/adjust for the roster and
  watch panels.

### 4. Docs and config

- `AGENTS.md`: rewrite the “What this is” and architecture bullets — no ZCode
  research agent, no MCP, no snapshots/orderings; the roster/watch/shadow design.
- `README.md`: same, plus the two clocks and the demand trigger.
- `docs/ZCODE_AUTOMATION.md` and `docs/research-sweep-automation.md`: delete (or
  replace with a one-paragraph “retired” note pointing at `DECISIONS.md` D6).
- `docs/FOMO_DAWN_FETCHING.md`: native capture and Dawn are fallback procedures.
- `docs/RUNBOOK.md`: roster operations, demand trigger, boot catch-up.
- `.env.example`: remove `FOMO_LEADERBOARD_URL` guidance that implies an
  automation path; keep it documented as disabled/fallback.
- `launch.bat`: unchanged; document “do not sleep while the server runs”.

## Tests

- `apps/server/test/runtime-cadence.test.ts` (fake timers): only `watchTimer`
  and `rosterTimer` poll external providers; a full roster + full bench produces
  zero discovery calls; a free slot with a thin bench triggers exactly one,
  rate-limited.
- `apps/server/test/boot-catchup.test.ts`: boot syncs, ticks the watch once and
  fills the roster before starting the clocks.
- Delete/replace `apps/server/test/rotation.test.ts`, `engine-flow.test.ts`
  handoff cases, `research-signal.test.ts`, and any test that imported the
  removed modules.
- E2E: dashboard without the handoff overlay; roster and watchlist panels render;
  no “waiting for ZCode” state is reachable.

## Acceptance criteria

- **AC1** — `apps/zcode-mcp` no longer exists; no workspace/package/config
  reference to it remains; `pnpm install` and `pnpm build` still succeed.
- **AC2** — `.zcode/agents/zcode-research.md` is gone; `.zcode/config.json` has no
  `zcode-bot-research` entry; the two ZCode automations are deleted.
- **AC3** — No code imports `SnapshotService`, `RecommendationService`,
  `validateRecommendation`, `recommendationPayloadSchema`, `consumeShortlist`,
  `evaluateRankStability`, `rotateIfFlat`, `deriveJustFiredExclusion`,
  `resolveReplacement`, or writes handoff/research control events. `grep`
  evidence is required.
- **AC4** — The runtime has exactly two monitoring timers (`watchTimer`,
  `rosterTimer`); no `snapshotTimer`, `inboxTimer`, `fomoWebTimer` or research
  trigger remains. Housekeeping timers (health, fee ledger, symbols, reports) are
  allowed and documented.
- **AC5** — A full roster and a full bench produce **zero** discovery calls in a
  simulated hour; a free slot with a thin bench produces exactly one, then none
  until the rate limit expires.
- **AC6** — Boot catch-up runs discovery (if thin), one watch tick and
  `fillRoster()` before the clocks start; a boot with no key or no API still
  starts and audits the skip.
- **AC7** — `appState` no longer contains `PAUSED_WAITING_FOR_ZCODE` or
  `PAUSED_FOR_FRESH_RESEARCH`; the handoff overlay is gone; no UI text mentions
  ZCode ordering, snapshots or MCP.
- **AC8** — The Settings recommendation import and the Operations
  snapshot/recommendation actions are gone; the manual FOMO import remains as a
  labelled fallback.
- **AC9** — `AGENTS.md`, `README.md`, `docs/*` and `.env.example` describe the
  roster/watch/shadow flow and the two clocks; no doc instructs running the
  retired sweep or the research agent.
- **AC10** — The legacy tables still exist and still contain their data; nothing
  reads or writes them; dropping them is explicitly out of scope.
- **AC11** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm e2e` pass.
- **AC12** — No divergence from D5/D6: the demand trigger, the bench target, the
  two clocks, the boot catch-up, and the full retirement list are implemented.

## Out of scope

- Dropping legacy tables or deleting historical data.
- Any change to the roster/watch logic from plans 04/05.
- Moving the server off the operator's laptop.

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/06_runtime_retire_research.md`.
