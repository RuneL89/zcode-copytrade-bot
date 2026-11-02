# apps/web/e2e/

## Purpose

Black-box browser tests for the dashboard. They drive the real built app
through Playwright and assert what a phone/desktop operator would see.

## Ownership

- Specs: `dashboard.spec.ts`, `mobile.spec.ts`, `pipeline.spec.ts` (the plan-07
  spine: order, counts vs the API payload, themes, reduced motion, states).
- Harness: `playwright.config.ts` (repo root of the app), `global-setup.ts`,
  `helpers.ts`, `paths.ts`.

## Local Contracts

- **Never touch live data.** The suite runs the server in `MODE=demo` with
  `DATA_DIR` pointed at a temp directory (`zcode-bot-e2e-data`) on port 8791.
  `global-setup.ts` deletes and recreates that directory once per run, in its
  own process — never move that cleanup into the config module, because worker
  processes re-load it and would delete live data mid-run.
- **Demo mode only.** No API keys, wallets, signing, or real market calls are
  exercised. Assertions must expect the `FICTIONAL DEMO` banner.
- **Two projects:** `chromium` (Desktop Chrome), `mobile` (Pixel 7, only
  `mobile.spec.ts`). A spec that needs reduced motion calls
  `page.emulateMedia({ reducedMotion: 'reduce' })` itself. The runner is serial
  (`fullyParallel: false`, `workers: 1`, no retries).
- **The setup token shortcut is test-only.** `helpers.ts` reads
  `testSetupToken` from `/api/bootstrap`, which exists only under
  `NODE_ENV=test`. Never enable that field in any other environment.
- **Assert user-visible behavior** — roles, labels, and text — rather than
  component internals or CSS selectors that a refactor would break.

## Work Guidance

- Add a spec for new user-facing flows; extend `helpers.ts` for shared setup
  (login, setup wizard) instead of duplicating it.
- If a flow needs new server state, drive it through the demo replay or the
  public API — never seed the e2e database by hand.
- Keep specs deterministic: no fixed sleeps, use Playwright's web-first
  assertions with explicit timeouts.

## Verification

- `pnpm e2e:install` once per machine (downloads Chromium).
- `pnpm e2e` — Playwright starts the server itself (`reuseExistingServer:
false`) and builds/migrates against the temp data dir.
- Failures keep screenshots and traces (`only-on-failure` /
  `retain-on-failure`).

## Child DOX Index

None.
