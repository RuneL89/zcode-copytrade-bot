# apps/web/e2e/

## Purpose

Black-box browser tests for the redesigned dashboard. They drive the real
built app through Playwright and assert what a phone/desktop operator sees:
the Line/funnel and arena, the Seats/Credits/Risk screens, the PIN-gated risk
editor, the seat drawer, the demo banner and the security invariants.

## Ownership

- Specs: `dashboard.spec.ts` (setup, tabs/routes, risk editor + PIN, CSRF/auth),
  `desk.spec.ts` (phone layout and four tabs), `mobile.spec.ts` (375 px fit),
  `pipeline.spec.ts` (Line structure, seat drawer, pause/resume, demo banner),
  `pipeline-screens.spec.ts` (review captures at 390/1280), `weekly.spec.ts`
  (the read-only weekly report page and the Audit link).
- Harness: `playwright.config.ts`, `global-setup.ts`, `helpers.ts`, `paths.ts`.

## Local Contracts

- **Never touch live data.** The suite runs the server in `MODE=demo` with
  `DATA_DIR` pointed at a temp directory (`zcode-bot-e2e-data`) on port 8791.
  `global-setup.ts` deletes and recreates that directory once per run, in its
  own process — never move that cleanup into the config module, because worker
  processes re-load it and would delete live data mid-run.
- **Demo mode only.** No API keys, wallets, signing, or real market calls are
  exercised. Assertions must expect the fictional demo banner.
- **The replay is a 28 s story.** `completeSetup` clicks the banner's Replay
  button (the CSRF-authenticated POST the app uses) and waits for the arena;
  a test that takes longer than the story must restart it rather than inherit
  the empty state.
- **Settings and controls persist in the data dir.** `completeSetup` resets the
  risk overrides through the validated `PATCH /api/settings` (using the
  test-only `RISK_PIN`) so every test starts from the shipped defaults. The
  pause flag is normalised by the test that exercises it.
- **Two projects:** `chromium` (Desktop Chrome) and `mobile` (Pixel 7, only
  `mobile.spec.ts`). The runner is serial (`fullyParallel: false`,
  `workers: 1`, no retries).
- **The setup token shortcut is test-only.** `helpers.ts` reads
  `testSetupToken` from `/api/bootstrap`, which exists only under
  `NODE_ENV=test`. Never enable that field in any other environment.
- **Assert user-visible behavior** — roles, labels, test ids and text — rather
  than component internals or unstable CSS selectors.

## Work Guidance

- Add a spec for new user-facing flows; extend `helpers.ts` for shared setup
  instead of duplicating it.
- Use the redesign's stable test ids (`desk-line`, `funnel-stage-*`, `seat-*`,
  `risk-*`, drawers/modals). New screens should add ids alongside their
  accessible names.
- If a flow needs new server state, drive it through the demo replay or the
  public API — never seed the e2e database by hand. The old `/api/test/seed-watch`
  route is no longer used by this suite; watch coverage lives in the server
  integration tests and the committed paper-mode screenshots.
- Keep behavioral specs web-first; visual-capture specs may settle briefly
  (300–800 ms) before a screenshot.

## Verification

- `pnpm e2e:install` once per machine (downloads Chromium).
- `pnpm e2e` — Playwright starts the server itself (`reuseExistingServer:
false`) and builds/migrates against the temp data dir.
- Failures keep screenshots and traces (`only-on-failure` /
  `retain-on-failure`).

## Child DOX Index

None.
