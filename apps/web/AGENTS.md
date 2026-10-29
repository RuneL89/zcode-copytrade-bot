# apps/web/

## Purpose

The mobile-first operator dashboard: equity hero, active-trader card, live
position mirroring, closes chart, candidates, health row, settings/controls,
audit trail, and the OPS console.

## Ownership

- Routing and auth gating: `src/App.tsx`, `src/pages/Auth.tsx`.
- Data transport: `src/api.ts` (the only fetch layer) and
  `src/useDashboard.ts` (SSE subscription).
- Presentation: `src/components/` (reusable cards, charts, overlay) and
  `src/pages/` (Dashboard, Settings, Audit, Operations).
- Design tokens: `src/index.css` (Tailwind v4 `@theme` block).
- Browser tests: `e2e/` (own contract).

## Local Contracts

- **Presentation only.** No trading math, sizing, or eligibility logic here.
  If a number needs deriving, it comes from the server; if a rule is needed, it
  belongs in `packages/core`.
- **Every figure is server-sourced and labeled.** Never synthesize, round-trip,
  or extrapolate a value. Mode labels are strict: `DEMO` banner everywhere in
  demo, `PAPER` for simulated fills, `LIVE` only when the server reports armed
  **and** healthy.
- **SSE is authoritative.** `useDashboard` reconnects with backoff and treats
  the first frame after a connect as the full state; do not replay or invent
  events client-side.
- **Mutations go through `api.ts`** so the CSRF double-submit header and the
  cookie-session self-heal stay in one place. Never call `fetch` directly from
  a component for a mutation.
- **The OPS page sends an op id plus a confirmation word only.** It must never
  construct a command, path, or argv.
- **Tokens come from `index.css`.** Use the declared theme palette/radius;
  don't introduce a parallel palette. Semantic colors are fixed: positive
  green, negative red, muted for secondary text.
- **Mobile-first and accessible.** Layouts must work at phone width first.
  Respect `prefers-reduced-motion` (the Playwright suite asserts it) and keep
  interactive controls keyboard-reachable.

## Work Guidance

- New screens: add a route in `App.tsx`, a page in `src/pages/`, and reuse
  `src/components/` primitives before adding new ones.
- Keep types in `src/types.ts` in lockstep with the server's `state.ts`
  payload. A contract change is one change across both apps.
- Charts are hand-rolled SVG in `charts.tsx`; keep them dependency-free and
  driven by the server series.
- Formatting helpers (`usd`, `signedUsd`, `splitEquity`, `clockFromSeconds`,
  `timeAgo`, `solFromBase`) live in `src/types.ts` and are covered by
  `tests/format.test.ts`; add a test with any new formatter. They must not use
  float math on micro-USD strings.

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
