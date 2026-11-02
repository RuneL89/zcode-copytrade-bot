# Plan 03 — Discovery inlet (D3)

Status: COMPLIANT
Implements: **D3** (+ the demand-trigger predicate that D5 requires)
Depends on: 02

## /goal

Make the fomoapi leaderboard the only automatic discovery inlet: union the 24h,
7d and 30d boards plus the alerts feed, upsert traders by stable `userId` and
wallet, and stop using the native desktop-Chrome capture and Dawn in the loop.
The service must be callable on demand (CLI + Ops action) and must never call the
API without a key or without a reason.

## Decided behaviour

From D3:

- Sources: `GET /v2/leaderboard/{24h|7d|30d}?limit=150` and the alerts feed.
  Free tier only: 250,000 credits/month, 250 credits per leaderboard request,
  ~125 per alerts request.
- Each leaderboard row gives `userId`, handle, window `pnlUsd`, and
  `wallets.solana` (verified). Wallets come from the row; Dawn is a fallback for
  handles outside the boards, not part of the loop.
- `trades` and `volumeUsd` are lifetime and must **not** be used as activity
  signals. Activity/copyability comes from the funded-swap scan (plan 04).
- Candidate identity: `userId` first, wallet second; dedupe by wallet. Handles
  are labels and may change.
- The service reports itself degraded sometimes; the chain remains the truth.

## Code changes

### Provider — `packages/providers/src/fomoapi.ts`

New `FomoApiClient`:

- Constructor `{ baseUrl, apiKey, timeoutMs = 15_000, fetchImpl? }`.
- `leaderboard(window: '24h'|'7d'|'30d', limit = 150)`:
  - `GET {base}/v2/leaderboard/{window}?limit={limit}`,
    `authorization: Bearer <key>`; accept the documented `x-api-key` fallback.
  - Returns `{ rows, creditsCost, creditsRemaining, etag }` from the response
    headers (`x-credits-cost`, `x-credits-remaining`, `etag`).
  - Handles `401` (no key), `402` (credits exhausted), `429` (rate limit),
    non-JSON bodies, and timeouts; each throws a typed error, never returns
    empty rows silently.
  - Sends `If-None-Match` when an ETag is supplied; a `304` returns
    `{ rows: [], notModified: true, creditsCost: 0 }`.
- `alerts(limit = 50)`: `GET {base}/v2/alerts?limit={limit}`; returns
  `{ alerts, creditsCost, creditsRemaining }`. Each alert carries `trader`,
  `userId`, `token`, `usdValue`, `ts`. **No wallet** — alerts only discover
  traders; wallets come from the leaderboard union.
- A `configured` getter (key non-empty).
- No retries on 401/402; bounded retry (max 2) on 429/5xx with backoff.
- Export the client and its types from `packages/providers/src/index.ts`.

### Env — `packages/config/src/env.ts`

- `FOMOAPI_KEY: z.string().optional()`.
- `FOMOAPI_BASE_URL: z.string().default('https://api.fomoapi.io')`.
- Never log the key. The `.env.example` gets both keys documented.

### Service — `apps/server/src/services/discovery.ts`

- `syncDiscovery()`:
  1. Requires `FOMOAPI_KEY`; otherwise audit `discovery skipped: FOMOAPI_KEY not configured` and return without a network call.
  2. Fetch the three boards (24h, 7d, 30d). One failure must not abort the
     others; record which succeeded.
  3. Union rows by `userId` (fallback: wallet, then lowercased handle).
     Upsert candidates (`upsertCandidateByUser`) with handle, wallet, window
     PnL, `observed_at`. Dedupe by wallet: if a wallet already belongs to a
     different candidate, merge the label and keep one identity.
  4. Fetch alerts (best effort); upsert any new trader as a walletless candidate
     (it enters the pool but is not scannable until a wallet appears).
  5. Write an audit line: windows fetched, rows, new traders, merged, credits
     spent/remaining.
- `shouldDiscover()`: pure predicate, exported for plan 04/06:
  - `true` when `promotable watch wallets < free roster slots`, or
    `watch list size < BENCH_TARGET`;
  - `false` when both the roster and the bench are full.
  - Rate limit: at most one discovery run per 30–60 minutes (`DISCOVERY_MIN_INTERVAL_MS`).
  - In plan 03 the watch table is empty, so this predicate is **not wired** to a
    timer; the service runs on boot catch-up and on demand. Plan 04 wires it.
- Audit line on every call and on every skip (reason).

### Disable the old inlets in the loop

`apps/server/src/runtime.ts`:

- Remove the `fomoWebTimer` (scheduled Playwright adapter) and the boot
  `fomoWebImportNow()` call. Leave the `fomoWeb` provider constructible for a
  manual fallback only (it is already disabled by `FOMO_LEADERBOARD_URL` being
  commented out; do not re-enable it).
- Dawn is already out of the server's timers; do not add it back. The `dawn-lookup`
  CLI remains the manual fallback.
- Add a boot call to `syncDiscovery()` (catch-up) guarded by `shouldDiscover()`.

### CLI + Ops

- `apps/server/src/cli/discovery-sync.ts`: runs `syncDiscovery()`, prints counts
  and credits, exits non-zero on a fatal error.
- `apps/server/src/services/ops.ts`: add a whitelisted op
  `discovery-sync-now`, server-side constant only, with the repo's confirmation
  word pattern.
- `apps/server/src/http/app.ts`: no new route if the Ops action covers it; the
  existing `/api/ops/run` path applies.

### UI

- **Operations** (`apps/web/src/pages/Operations.tsx`): add a "Sync discovery
  now" button wired to the Ops action, with a busy state and a result line
  (traders added / merged / credits).
- **Settings → Keys** (`Settings.tsx`): show `fomoapi: configured / not
configured` (never the key). No input field for the key — it is entered in
  `.env` locally.
- **Settings → Imports**: relabel the manual FOMO leaderboard import as
  "fallback only"; it is no longer part of the loop.
- **Dashboard**: the pool/candidate counts must reflect the API-synced pool; no
  new panel is required in this plan.

### Docs

- `docs/FOMO_DAWN_FETCHING.md`: the native capture and Dawn become **fallback
  procedures**; the primary inlet is the fomoapi leaderboard.
- `docs/research-sweep-automation.md`: mark the 30-minute sweep as retired by
  D3/D6 (plan 06 deletes the file's remaining references).
- `docs/ZCODE_AUTOMATION.md`: the research agent no longer receives discovery
  data; the inlet is the API.
- `.env.example`: document `FOMOAPI_KEY` and `FOMOAPI_BASE_URL`.

## Tests

- `packages/providers/test/fomoapi.test.ts` (mock `fetch`):
  - correct URL per window and `limit=150`;
  - Bearer header; `x-api-key` fallback accepted;
  - 401/402/429/timeout throw typed errors;
  - 304 returns `notModified` and 0 credits;
  - response headers parsed into `creditsCost`/`creditsRemaining`.
- `apps/server/test/discovery.test.ts`:
  - union of three boards deduped by `userId`;
  - same wallet under two handles merges into one candidate;
  - alerts add walletless candidates without failing the run;
  - missing key → no fetch, audit skip;
  - partial board failure still upserts the successful windows;
  - `shouldDiscover()` truth table (bench thin / slot free / both full).
- `apps/server/test/ops.test.ts`: `discovery-sync-now` is whitelisted and requires
  its confirmation word.

## Acceptance criteria

- **AC1** — `FomoApiClient.leaderboard('24h'|'7d'|'30d', 150)` calls
  `GET /v2/leaderboard/{window}?limit=150` with `authorization: Bearer <key>`
  and parses `x-credits-cost` / `x-credits-remaining`.
- **AC2** — 401, 402, 429 and a timeout each surface a typed error; no call
  returns an empty result silently.
- **AC3** — A `304` is treated as unchanged (no rows, 0 credits) and does not
  overwrite the pool.
- **AC4** — `syncDiscovery` unions all three boards and upserts candidates by
  `userId`; a wallet seen under two handles collapses to one candidate.
- **AC5** — The alerts feed adds traders that are not on any board, without a
  wallet, and does not fail the run when alerts fail.
- **AC6** — With `FOMOAPI_KEY` empty, the service makes **zero** network calls
  and writes the skip audit line.
- **AC7** — `shouldDiscover()` returns false when the roster and the bench are
  full, and true when the bench is below `BENCH_TARGET`.
- **AC8** — The runtime no longer starts `fomoWebTimer` and no longer calls the
  native fetch on boot; the manual `fomo-import` path still exists.
- **AC9** — Dawn is not called anywhere in the automatic discovery path.
- **AC10** — The Operations page has a working "Sync discovery now" action whose
  result line reports added/merged/credits.
- **AC11** — Settings shows the fomoapi key as configured/not configured and
  never renders the key.
- **AC12** — The docs and `.env.example` describe the API as the primary inlet and
  the native capture/Dawn as fallback.
- **AC13** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- **AC14** — No divergence from D3: `userId` identity, verified wallets from the
  rows, lifetime `trades`/`volumeUsd` not used as activity, free tier only.

## Out of scope

- The funded-swap scan and watch list (plan 04).
- Removing the research pipeline (plan 06).
- Any paid fomoapi tier.

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/03_discovery_inlet.md`.
