# apps/web/

## Purpose

The mobile-first operator dashboard in **dark + light parity**: context row,
equity hero, the **pipeline spine** (Discovery → Pool → Watch → Roster →
Exits with the Fired → Watch return lane), a five-seat roster grid, the
positions/watch working area with the watch rail (watch list / activity /
audit tabs), secondary detail (closes chart, candidates), status drawer,
tabbed Operations and Settings consoles, and auth screens.

## Ownership

- Routing and auth gating: `src/App.tsx` (bottom tab bar + skeleton loading),
  `src/pages/Auth.tsx`.
- Data transport: `src/api.ts` (the only fetch layer) and
  `src/useDashboard.ts` (SSE subscription).
- Presentation: `src/components/` (cards, charts, overlays, primitives) and
  `src/pages/` (Dashboard, Settings, Audit, Operations).
- Design tokens: `src/index.css` (Tailwind v4 `@theme` block — the single
  source of both palettes; the light block re-tunes the same semantic names).
- Theme: `src/theme.tsx` (`system | dark | light`, persisted, applied as
  `data-theme` on `<html>`); `index.html` runs the same resolution pre-paint.
- Brand: `public/favicon.svg` + `src/components/Logo.tsx` (keep both in sync;
  the mark reads `--color-brand-*` tokens, no hex in the component).
- Browser tests: `e2e/` (own contract).

## Local Contracts

- **Presentation only.** No trading math, sizing, or eligibility logic here.
  If a number needs deriving, it comes from the server; if a rule is needed,
  it belongs in `packages/core`.
- **Every figure is server-sourced and labeled.** Never synthesize,
  round-trip, or extrapolate a value. Mode labels are strict: the demo banner
  in demo, PAPER for simulated fills, LIVE only when the server reports
  armed **and** healthy.
- **SSE is authoritative.** `useDashboard` reconnects with backoff and treats
  the first frame after a connect as the full state; do not replay or invent
  events client-side.
- **Mutations go through `api.ts`** so the CSRF double-submit header and the
  cookie-session self-heal stay in one place. Never call `fetch` directly
  from a component for a mutation.
- **The OPS page sends an op id plus a confirmation word only.** It must
  never construct a command, path, or argv.
- **Tokens come from `index.css`.** Dark + light parity: charcoal base
  (dark) / paper base (light), frosted glass (`.card`/`.panel`), cyan accent,
  semantic pos/neg pair. Use the declared theme colors (`text-ink`, `text-pos`,
  `bg-posdim`, `text-flow`, …); a component must not hardcode a hex — the
  theme switch is one `data-theme` attribute, and every surface, border, text
  tier and semantic color must follow it.
- **Typography:** sentence-case labels (`.label`); uppercase mono (`.tag`) is
  reserved for state badges/chips; `.mono` for numerics and log output. Body
  text ≥ 11px. Do not reintroduce tiny 8px uppercase annotation text.
- **Charts:** the closes chart uses recharts (operator-released the
  dependency-free rule, 2026-10-31); the equity sparkline and avatars stay
  hand-rolled in `charts.tsx`. Keep chart data derived from the server series
  only.
- **Mobile-first and accessible.** Layouts must work at phone width first:
  the container is 600px below 900px and widens to 1080px at ≥900px (the hero
  and text columns stay capped at 600px inside it). The pipeline is a
  horizontal spine at ≥900px and a scrollable five-stage stepper below, with no
  horizontal page overflow; interactive controls are ≥44px tall at phone width.
  Respect `prefers-reduced-motion` (the Playwright suite asserts it) and keep
  every stage, seat and action keyboard-reachable; the tab bar targets are 44px
  high.
- **The pipeline renders server numbers verbatim.** Every stage count, edge
  volume and seat status comes from `DashboardState.pipeline` (built in
  `apps/server/src/services/builder.ts`); the dashboard never derives, rounds or
  extrapolates one.
- **Danger actions use word-confirmation dialogs** (`ConfirmDialog` /
  Operations' `ConfirmModal`), never native `confirm()`.

## Work Guidance

- New screens: add a route in `App.tsx`, a page in `src/pages/`, and reuse
  `src/components/` primitives before adding new ones. Internal sections use
  `PageTabs`/`TabPanel`.
- Keep types in `src/types.ts` in lockstep with the server's `state.ts`
  payload. A contract change is one change across both apps.
- `RosterPanel.tsx` renders the five-seat grid (one `RosterSeat` per chair from
  `pipeline.roster`, joined with `roster` for the streak strip): handle, seat
  status (BUYING / SELLING / IDLE / RECONCILING), realized and unrealized PnL,
  open positions, last-signal age, streak, and a per-seat FIRE action that names
  the activation; the API refuses an ambiguous fire when several leaders are
  active. An empty chair is the dashed "Open seat" state — an accepted outcome.
  A filled seat is itself a button whose accessible name carries its figures
  (`@handle, STATUS, realized …`), with the visual layer `aria-hidden` and the
  FIRE action a sibling button, so both stay keyboard-reachable.
- The pipeline components live in `src/components/pipeline/`
  (`PipelineFlow` + `StageNode` / `FlowEdge` / `CandidateChip`, with pure layout
  math in `layout.ts` covered by `tests/pipeline-layout.test.ts`). Transitions
  spawn one chip per grown edge (max 3 concurrent) and pulse the target node;
  under `prefers-reduced-motion` neither happens — the counts still update.
- `WatchRail.tsx` owns the working area's right column: watch list / activity /
  audit tabs. Each tab renders its own card (the panels keep their own states
  and test ids).
- The candidates panel (`CandidatesPanel.tsx`) polls `GET /api/candidates`
  (30s) and shows the pool with display-only screens (address verification,
  activity/stamp freshness, funded-buy window). The screens are informational:
  the promotion gate and the engine decide, and the UI must mirror the D4
  thresholds (`PACKAGES/config/src/risk.ts`), never invent new ones.
  The board rows carry direction chips from the wallet refresh — `BUY <age>`
  (pos ≤ `ACTIVE_BUY_WINDOW_HOURS`, warn outside), sell-heavy `s>b` marker,
  `0b · Ns`, and explicit unknown states (`CHECK FAILED`, `NO DATA` — unknown
  is never rendered as "quiet"); the `BOARD n/m bought` pulse strip and the
  buyer-first row sort mirror the watch list's funded-buy screen.
- Formatting helpers (`usd`, `signedUsd`, `splitEquity`, `clockFromSeconds`,
  `timeAgo`, `solFromBase`) live in `src/types.ts` and are covered by
  `tests/format.test.ts`; add a test with any new formatter. They must not
  use float math on micro-USD strings. Display-only chart values may convert
  to numbers.
- The header badges open `StatusDrawer` (system status, pause reason, health,
  freshness); the footer is a one-line summary, not the status surface.

## Verification

- `pnpm --filter @zcode-bot/web test` — Vitest unit tests (formatting,
  watchlist helpers, pipeline layout math).
- `pnpm --filter @zcode-bot/web typecheck` and `build` (build runs `tsc
--noEmit` before Vite).
- `pnpm e2e` — Playwright against the server in demo mode; covers desktop and
  Pixel 7 projects.
- Root gate before closeout.

## Child DOX Index

- `e2e/AGENTS.md` — Playwright browser suite: isolated data dir, demo mode,
  desktop and mobile projects.
