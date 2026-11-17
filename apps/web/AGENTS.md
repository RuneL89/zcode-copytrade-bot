# apps/web/

## Purpose

The mobile-first operator dashboard, rebuilt to the approved dark mockup: a
top status header (mode badge, KPIs, provider dots), four screens —
**Line** (funnel, arena, equity, succession, live feed), **Seats &
positions**, **Credits**, and **Risk settings** — a desktop tab bar, a mobile
bottom nav, seat/watch drawers, and a fire modal. Auth, the Ops console, the
Audit log, provider-key/import entry, and the read-only weekly review remain
reachable.

## Ownership

- Routing and auth gating: `src/App.tsx` (four redesign routes plus legacy
  `ops`, `audit`, `weekly`, `legacy-settings`), `src/pages/Auth.tsx`.
- Data transport: `src/api.ts` (the only fetch layer), `src/useDashboard.ts`
  (SSE subscription), `src/redesign/useRemote.ts` (read-only 30–60 s polling).
- Redesign shell and screens: `src/redesign/` — `Redesign.tsx`, `Header.tsx`,
  `LinePage.tsx`, `SeatsPage.tsx`, `CreditsPage.tsx`, `RiskPage.tsx`,
  `Funnel.tsx`, `Arena.tsx`, `Drawers.tsx`, `Charts.tsx`, `model.ts`,
  `format.ts`.
- Redesign styles: `src/redesign.css` (scoped port of the approved mockup)
  and `src/redesign-extra.css`. Legacy/auth styling stays in `src/index.css`.
- Legacy operator surfaces: `src/pages/Operations.tsx`, `Audit.tsx`,
  `WeeklyReview.tsx`, and `Settings.tsx` (reached via `#/legacy-settings`; its
  Risk tab is hidden, but the **Live** tab remains the arm/disarm/lock-wallet
  control and shows the readiness blockers).
- Screenshots: `docs/screenshots/redesign/` — committed desktop/mobile
  captures of every main screen plus the PIN, seat/watch drawer and fire-modal
  states.
- Browser tests: `e2e/` (own contract).

## Local Contracts

- **Presentation only.** No trading math, sizing, or eligibility logic here.
  Derived display values live in `src/redesign/model.ts`; any rule belongs in
  `packages/core` and any authoritative number comes from the server.
- **Every figure is server-sourced.** Never synthesize, round-trip, or
  extrapolate a value. Unavailable data gets an honest empty or "not tracked
  yet" state — the Helius 7-day history, Jupiter lane rates, Fomo monthly cap
  and fee-wallet balance are the current examples. The demo banner is the only
  fictional-data banner; it appears only when the state is fictional, and the
  mockup's "example data" banner must never ship.
- **Equity is account value.** The header KPI and the Desk equity headline use
  `equity.rollingUsdMicro` (cash + live marks of open positions), not the
  realized book `equity.currentUsdMicro`. The realized book drives the
  closed-lot series; a position that is up must raise equity before it closes.
- **The redesign is the approved mockup**: dark palette, desktop shell up to
  1680 px, desktop tabs and a four-item mobile bottom nav (Line / Seats /
  Credits / Risk), no horizontal page overflow at phone width, and the same
  funnel/arena/credits/risk information architecture.
- **No fake controls.** The mockup's "Pause sim" and "Simulate firing" are not
  shipped as simulators: the toolbar has the real Pause/Resume entries and
  Fire a seat… actions. The hire-mode segment is read-only (`HIRE_APPROVAL`),
  and there is **no** arm-live control in the redesign.
- **One risk editor.** `RiskPage` is the only editable risk form. It sends the
  existing validated `PATCH /api/settings` and shows the PIN prompt only when
  the change increases risk; the server still enforces the PIN. The legacy
  Settings risk/live tabs are not rendered.
- **Read-only additions only.** The redesign adds no mutating endpoints. New
  data is additive and read-only: `roster[].series`, `positions[].exitPlan`,
  `pipeline.hiresToday`, `watchlist.rows[].reason`, `activity[].leaderHandle`,
  and `candidateRejections` on `GET /api/rejections`.
- **SSE is authoritative.** `useDashboard` reconnects with backoff and treats
  the first frame after a connect as the full state; do not replay or invent
  events client-side. Mutations go through `api.ts` so CSRF and the cookie-
  session self-heal stay in one place.
- **Legacy pages keep their old surface.** Ops, Audit, Weekly review, and the
  keys/imports Settings view render with the legacy layout; the `.cdx` wrapper
  scopes the redesign CSS so the two systems cannot collide.
- **Accessibility and mobile first.** Interactive targets stay keyboard-
  reachable; the mobile bottom nav and drawer actions work at 390 px without
  page overflow. The redesign is dark-only, matching the approved mockup.

## Work Guidance

- Add a redesign screen as a component under `src/redesign/` and a route in
  `App.tsx`; reuse `model.ts`/`format.ts` before adding helpers.
- `#/weekly` is the read-only weekly performance review. The Audit page links
  to it; the page fetches `GET /api/reports/weekly` and renders the server's
  markdown. It performs no client-side P&L math and sends no mutations.
- Keep `src/types.ts` in lockstep with the server's `state.ts` payload. A
  contract change is one change across both apps.
- Use the existing test ids (`desk-line`, `desk-seats`, `desk-credits`,
  `desk-risk`, `funnel-stage-*`, `seat-*`, `risk-*`, drawers/modals) for e2e.
- Regenerate the committed screenshots from a paper-mode dev server after UI
  changes; `e2e/pipeline-screens.spec.ts` captures the same routes into
  `test-results/` for review.
- The old `Dashboard.tsx`, `Desk.tsx`, `RosterPanel.tsx`, and pipeline-spine
  components are legacy/not routed; do not extend them.

## Verification

- `pnpm --filter @zcode-bot/web test` — Vitest unit tests.
- `pnpm --filter @zcode-bot/web typecheck` and `build` (build runs
  `tsc --noEmit` before Vite).
- `pnpm e2e` — Playwright against the server in demo mode; covers the Line,
  Seats, Credits and Risk surfaces at desktop and phone widths, the PIN flow,
  the seat drawer, the demo banner and the security invariants.
- Root gate before closeout.

## Child DOX Index

- `e2e/AGENTS.md` — Playwright browser suite: isolated data dir, demo mode,
  desktop and mobile projects.
