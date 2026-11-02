# Plan — unattended 24h-leaderboard refresh + flat-only trader rotation

> **RETIRED (D2/D3/D6, 2026-11-01).** Board-driven rotation, the rank-fire
> rule and the research bridge this plan describes are gone: the board is a
> discovery feed, chairs are filled from the promotion queue, and the research
> pipeline is deleted. Kept for the record only — do not implement any step here.

Status: approved 2026-10-29 (implementation in progress)
Owner: operator
Scope: zcode-bot research loop

## 1. Goal

Make the FOMO 24h-board refresh (`docs/FOMO_DAWN_FETCHING.md`, Procedure A, stage 0)
happen without a human in the loop, triggered by the research pipeline itself, and
add one new behaviour:

> When the 24h leaderboard has been refreshed and the current trader has **no open
> positions**, fire that trader and hire the best candidate from the new roster.

Two things this plan deliberately does **not** do:

- It does not let the MCP server itself fetch. The MCP is a least-privilege file
  bridge (`apps/zcode-mcp/src/index.ts:9-21`); giving it browser access would
  destroy that contract. It gains the _decision_ power (a rotation intent), never
  the ability to click or spawn.
- It does not weaken the fomo.family policy: all board reads happen in the
  operator's normal desktop Chrome via GUI automation
  (`docs/FOMO_DAWN_FETCHING.md:7-24`).

## 2. Why the current loop starved

Evidence from the 2026-10-29 incident:

- Candidate rows kept `observedAt = 2026-10-28T06:32:11Z` for ~30h.
- The snapshot republished every 30 min from those rows, so `createdAt` looked
  fresh while the contents aged (`apps/server/src/services/research.ts:32-111`).
- No import ran in the current DB lifecycle until 13:09Z (`audit_events` 492; the
  audit table is a 100-row window, ids 407-506).
- The subagent's gate used the _snapshot-wide_ freshest `observedAt`, so one fresh
  row would legitimise a stale pool; at 05:01Z the pool was 22.5h old (under the
  24h bar) and was ordered anyway.
- The sweep's staleness check had no freshness term, so it no-op'd every 30 min.
- Ingest accepted a snapshot that had been expired for 90 minutes
  (`b5abe009` validated against `snap_71f82f9b`, built 00:20Z, expired 03:20Z)
  because validation never checks `snapshot.expiresAt`
  (`packages/core/src/recommendation.ts:163-195`).

## 3. Signal flow

```
sweep (every 30 min)
  ├─ read: max(observed_at), last import, last refresh request, recommendation validity
  ├─ if stale (>6h) or request pending:
  │     Procedure A stage 0 in desktop Chrome  → entries.json → fomo-import
  │     snapshot-rebuild CLI                     → fresh snapshot published
  │     control_event 'leaderboard_refresh_done'
  └─ research trigger check → zcode-research
        ├─ per-candidate freshness gate
        └─ if flat + fresh roster → recommendation with rotateIfFlat: true
              → server ingest
                   ├─ flat?  ── no → audit "rotation skipped: open positions"
                   └─ yes → fire(reason, requireFlat) → hire best eligible
```

## 4. Workstream A — tell the truth about freshness

A1. `packages/core/src/recommendation.ts` (`ResearchSnapshot`): add
`oldestObservedAt` and `staleCandidateCount`; redefine `sourceFreshnessSeconds`
in the doc comment to mean **freshest** (it is documented that way today but
computed from the oldest).

A2. `apps/server/src/services/research.ts` (`build`): compute
`sourceFreshnessSeconds` from `Math.max(observedAt)` (not `Math.min`), plus the
two new fields. Rationale: today the field reports 30.6h for a snapshot whose
newest rows are minutes old — exactly the signal the researcher used to abstain.

A3. `observedAt` stays the authoritative per-row age.

## 5. Workstream B — stale-pool signal without a new MCP tool

B1. `.zcode/agents/zcode-research.md`: - Eligibility becomes per candidate: `enabled`, not recently fired, has a
Solana address, **and `observedAt` within 24h**. Require >=3 such candidates. - When that fails, abstain with a machine-readable prefix:
`abstainReason: "POOL_STALE: <one sentence incl. freshest observedAt>"`. - Judge activity freshness by `publicStats.activityCheckedAt`, not
`statsCheckedAt`.

B2. `apps/server/src/services/research.ts` (`ingest`): a validated abstention whose
reason starts with `POOL_STALE` writes
`repo.controlEvent('leaderboard_refresh_request')` plus an audit row. No schema
change; the row is durable and exposed by `GET /api/control-events`.

## 6. Workstream C — the sweep executes Procedure A (stage 0)

C1. Detection, before the existing research check: - `stale` = `max(observed_at) < now - 6h` - `requested` = latest `leaderboard_refresh_request` control event newer than
the latest successful import - run when `stale || requested`, at most **once per 4h**.

C2. GUI runbook: 1. `start "" "https://fomo.family/leaderboard?range=24h"`. 2. Raise Chrome (`WScript.Shell.AppActivate`) — the computer-use API cannot
front a background window on Windows. Abort if not frontmost. 3. Screenshot; locate visible rows (>=5). 4. Per row: click, `Ctrl+L`, `Ctrl+C`, `Get-Clipboard`, strip `?r=...`.
Never OCR, never guess a slug. 5. Abort without importing on <5 rows, a non-`/profile/<slug>` URL, or a
non-24H range chip. 6. Write `entries.json`; `pnpm exec tsx src/cli/fomo-import.ts <file>`. 7. Run `src/cli/snapshot-rebuild.ts`, verify `max(observed_at)` advanced, write
`leaderboard_refresh_done`, close Chrome.

C3. New `apps/server/src/cli/snapshot-rebuild.ts` replaces the "delete
`research_snapshots` + restart `launch.bat`" step, which an unattended loop
must not do.

C4. Procedure step 7 (disable candidates not in the fresh list) stays out of the
automation: with stage 0 only it would strand the pool.

## 7. Workstream D — flat-only rotation

### D1. Intent field

Add `rotateIfFlat?: boolean` (default false) to both schemas:

- `packages/core/src/recommendation.ts` (strict payload schema)
- `apps/zcode-mcp/src/index.ts` (tool input zod — it strips unknown keys)

No new MCP tool: the count stays three, so the "exactly three" docs and tests stay
valid.

### D2. Who sets it

`zcode-research` sets `rotateIfFlat: true` when ordering (not abstaining), an
active trader exists, and the snapshot's freshest `observedAt` is newer than that
activation's `started_at` (read-only SQLite query). The subagent still cannot fire
or activate.

### D3. Server execution

`RecommendationService.ingest`, after a validated recommendation is saved, emits a
rotation request. `TraderLifecycle.rotateIfFlat` then:

1. resolves the active activation (none -> no-op);
2. checks flatness scoped to it: no `open`/`partially_closed` positions, no
   `requires_reconciliation` position (excluded by `repo.openPositions`, checked
   separately), and no entry intents in
   `pending_quote|quoted|pending_sign|submitted|confirmed`;
3. requires at least one candidate on the fresh ordering that passes eligibility and
   the pre-hire activity gate (prevents firing into an empty chair);
4. calls `fire(activationId, 'rotation: leaderboard refreshed while flat', { requireFlat: true })`.

`fire()` gains `{ requireFlat }`, re-checking flatness **inside** the existing
mark-FIRING transaction and returning `skipped_not_flat`.

### D4. Never rotate into an empty chair

Fresh stage-0 rows have no Solana address until Dawn resolves them. Rotation is
therefore skipped when no candidate on the new ordering is hireable
(`rotation skipped: no hireable candidate on the fresh roster`). With board-only
refreshes, rotation stays skipped until Procedure B runs.

### D5. Fix the shortlist walk (prerequisite)

`resolveReplacement` activates the first eligible candidate and, if `activate()`
rejects it, never tries ranks 2..N while still writing an `activated` handoff row.
Loop until one succeeds; write handoff/choice rows only after the outcome is known.

### D6. Bounds

One rotation per `recommendationId`; the fired candidate enters the 24h
`FIRED_TRADER_COOLDOWN_MS` bucket; manual `POST /api/fire` and `/api/activate`
remain escape hatches.

## 8. Tests

- Core: `rotateIfFlat` accepted / wrong type rejected / absent defaults false;
  freshness now derives from the freshest row.
- Server (`rotation.test.ts`, patterned on `engine-flow.test.ts`): flat rotates;
  open position does not; `requires_reconciliation` does not; pending confirmed
  intent does not; no hireable candidate does not.
- Research: `POOL_STALE:` writes the control event; a plain abstention does not.
- MCP: tool set is still exactly three.

## 9. Documentation

`FOMO_DAWN_FETCHING.md` (who executes, stage 0 only, rebuild CLI, step 7 not
automated), `research-sweep-automation.md` (fetch step + guards),
`ZCODE_AUTOMATION.md` (`POOL_STALE`, `rotateIfFlat`), `RUNBOOK.md` (rotation + kill
switch).

## 10. Rollout

1. A + B + C, prove one forced refresh on a scratch DB.
2. D with tests green; enable and watch two refresh cycles.
3. Keep manual fire/activate as escape hatches.

## 11. Risks and mitigations

| Risk                                             | Mitigation                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Chrome focus stolen mid-refresh                  | refresh only when pool >6h, max once/4h, abort if not frontmost              |
| Layout drift breaks clicks                       | abort on <5 rows or any non-profile URL; never a partial import              |
| Rotation strands the bot                         | hireable-candidate gate; skip instead of firing                              |
| Race: leader buy during rotation                 | flat re-check inside the FIRING transaction; entry intents count as not-flat |
| Stuck `requires_reconciliation` looks flat       | explicit status check before firing                                          |
| Fresh roster lacks wallets                       | rotation skipped until Dawn runs; documented                                 |
| Snapshot lag after import                        | rebuild CLI publishes immediately, no restart                                |
| Researcher keeps abstaining after a real refresh | A2 fixes the misleading number; B1 checks per candidate                      |
