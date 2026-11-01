# apps/web/

## Purpose

The mobile-first operator dashboard, dark-only and compact: equity hero,
fused "now copying" card with the hire/fire pipeline, open positions,
activity tape, closes chart (recharts), candidate roster, status drawer,
tabbed Operations and Settings consoles, live audit trail, and auth screens.

## Ownership

- Routing and auth gating: `src/App.tsx` (bottom tab bar + skeleton loading),
  `src/pages/Auth.tsx`.
- Data transport: `src/api.ts` (the only fetch layer) and
  `src/useDashboard.ts` (SSE subscription).
- Presentation: `src/components/` (cards, charts, overlays, primitives) and
  `src/pages/` (Dashboard, Settings, Audit, Operations).
- Design tokens: `src/index.css` (Tailwind v4 `@theme` block — the single
  source of the dark palette).
- Brand: `public/favicon.svg` + `src/components/Logo.tsx` (keep both in sync).
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
- **Tokens come from `index.css`.** Dark-only theme: charcoal base, frosted
  glass (`.card`/`.panel`), cyan accent, neon pos/neg pair. Use the declared
  theme colors (`text-ink`, `text-muted`, `text-pos`, `bg-posdim`, …); do not
  hardcode hex values in components.
- **Typography:** sentence-case labels (`.label`); uppercase mono (`.tag`) is
  reserved for state badges/chips; `.mono` for numerics and log output. Body
  text ≥ 11px. Do not reintroduce tiny 8px uppercase annotation text.
- **Charts:** the closes chart uses recharts (operator-released the
  dependency-free rule, 2026-10-31); the equity sparkline and avatars stay
  hand-rolled in `charts.tsx`. Keep chart data derived from the server series
  only.
- **Mobile-first and accessible.** Layouts must work at phone width first
  (≥1024px widens the column to 600px). Respect `prefers-reduced-motion` (the
  Playwright suite asserts it) and keep interactive controls keyboard-reachable;
  the tab bar targets are 44px high.
- **Danger actions use word-confirmation dialogs** (`ConfirmDialog` /
  Operations' `ConfirmModal`), never native `confirm()`.

## Work Guidance

- New screens: add a route in `App.tsx`, a page in `src/pages/`, and reuse
  `src/components/` primitives before adding new ones. Internal sections use
  `PageTabs`/`TabPanel`.
- Keep types in `src/types.ts` in lockstep with the server's `state.ts`
  payload. A contract change is one change across both apps.
- The hire/fire pipeline (`HiringPipeline.tsx`) always renders inside the
  "Now copying" card — also while positions are open.
- The candidates panel (`CandidatesPanel.tsx`) polls `GET /api/candidates`
  (30s) and merges it with the SSE recommendation to show the researcher's
  ordering plus display-only pre-hire gate checks (board presence, address
  verification, Dawn/Helius stamp freshness, active-buy window, positive
  day). Gates are informational: the engine re-verifies everything live at
  hire time, and gate thresholds in the UI must mirror `packages/core/src/
eligibility.ts` + the researcher ranking gates, never invent new ones.
  The board rows carry direction chips from the wallet refresh — `BUY <age>`
  (pos ≤ `ACTIVE_BUY_WINDOW_HOURS`, warn outside), sell-heavy `s>b` marker,
  `0b · Ns`, and explicit unknown states (`CHECK FAILED`, `NO DATA` — unknown
  is never rendered as "quiet"); the `BOARD n/m bought` pulse strip and the
  buyer-first row sort mirror the researcher's tiering.
- Formatting helpers (`usd`, `signedUsd`, `splitEquity`, `clockFromSeconds`,
  `timeAgo`, `solFromBase`) live in `src/types.ts` and are covered by
  `tests/format.test.ts`; add a test with any new formatter. They must not
  use float math on micro-USD strings. Display-only chart values may convert
  to numbers.
- The header badges open `StatusDrawer` (system status, pause reason, health,
  freshness); the footer is a one-line summary, not the status surface.

## Verification

- `pnpm --filter @zcode-bot/web test` — Vitest unit tests (formatting).
- `pnpm --filter @zcode-bot/web typecheck` and `build` (build runs `tsc
--noEmit` before Vite).
- `pnpm e2e` — Playwright against the server in demo mode; covers desktop,
  Pixel 7, and reduced-motion projects.
- Root gate before closeout.

## Child DOX Index

- `e2e/AGENTS.md` — Playwright browser suite: isolated data dir, demo mode,
  mobile and reduced-motion projects.
