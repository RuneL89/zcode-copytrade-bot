# Plan 07 — Pipeline dashboard redesign (UI)

Status: COMPLIANT
Implements: the design-interview vision (challenged standards included)
Depends on: 06

## /goal

Redesign the dashboard as a **streaming dataset pipeline**: candidates flow from
the API inlets into the pool, through the watch/filter stage, into five roster
seats where each leader's activity (buying / selling / idle) and PnL are visible;
fired seats drain to a fired lane while replacements flow back in. The equity and
PnL focus stays above the fold, and the whole interface ships in **dark and light
parity**.

## Design vision (captured in the interview)

- **Product & audience:** internal operator console, one operator, live money,
  mobile-first.
- **Deliverable:** dashboard redesign with the pipeline as the spine.
- **Visual direction:** tech-heavy illustrative; a streaming dataset, not a static
  diagram.
- **Theme & density:** dark + light parity; comfortable density, dense numerics.
- **Skills applied:** `saas-product-ui-system`, `saas-ui-ux-designer-with-flex`,
  `typography-flex`, `ui-ux-design-system`.

### Challenged project standards (operator kept their choice)

1. `apps/web/AGENTS.md` and `index.css` declare a **dark-only** system. This plan
   introduces `[data-theme="light"]` with parity and updates both files.
2. `apps/web/AGENTS.md` says the hire/fire pipeline **always renders inside the
   "Now copying" card**. This plan makes the pipeline the dashboard spine and the
   "Now copying" card becomes a roster seat inside it.
3. The desktop column is capped at **600px**. This plan widens the dashboard
   container to **1080px at ≥900px** so the horizontal pipeline can breathe; the
   hero and text columns stay bounded. Mobile remains the primary target.

## Visual references (patterns, not dependencies)

- **shadcn.io data-pipeline block** — source→destination stage flow, throughput
  numbers, status dots, dark mode: <https://www.shadcn.io/blocks/dashboard-data-pipeline>
- **Kedro-Viz** — node graph with light/dark themes and focus mode:
  <https://github.com/kedro-org/kedro-viz>
- **ApexCharts dark-mode dashboard** and **ApexSankey** — Sankey/funnel ribbon
  thickness and CSS-variable theming:
  <https://apexcharts.com/showcase/dark-mode-dashboard>,
  <https://github.com/apexcharts/apexsankey>
- **Prefab themes** — dark presentation palettes for data:
  <https://prefab.prefect.io/docs/styling/themes>
- **Initial State tiles** — real-time streaming tiles with a light/dark toggle:
  <https://www.initialstate.com/docs/articles/360003879391/>

Borrowed patterns: left-to-right stages, particle/dash flow along connectors,
ribbon thickness = volume, pulsing active nodes, red failure glow, monospace
tabular numerics, one bright accent on a neutral canvas.

## Information architecture

**Desktop (≥900px), top to bottom:**

1. **Context row** — mode badge (PAPER/LIVE), armed state, last sync, theme
   toggle, refresh/connectivity.
2. **Equity hero** — equity, today's PnL, deployed %, open positions, buying
   power. Unchanged data, new composition; always above the fold.
3. **Pipeline spine** — five stage nodes in a horizontal flow, with a return lane:
   `Discovery → Pool → Watch → Roster → Exits/Fired`, plus `Fired → Watch`
   (replacement).
4. **Roster grid** — five seat cards; each card is the old "Now copying" card,
   now one seat among five.
5. **Working area** — positions grouped by leader (left, 2/3) and the watch rail
   (right, 1/3; tabs: watchlist, activity, audit).
6. **Activity tape** — the existing feed, fed by SSE.

**Mobile (<900px), top to bottom:**

1. Context row (compact).
2. Equity hero.
3. **Pipeline stepper** — a horizontal, scrollable 5-stage strip with counts and a
   tap-to-focus detail; the full canvas is not shown at phone width.
4. **Roster** — horizontal snap carousel of seat cards (or 2-column grid at
   ≥480px).
5. Positions, watch list (tab), activity.

## The pipeline model

Each stage is a node with a label, a primary count, a rate ("+N/24h"), and a
health dot. Edges carry the 24h transition count; thickness encodes volume.

| Stage     | Primary count     | Secondary                                                            |
| --------- | ----------------- | -------------------------------------------------------------------- |
| Discovery | new handles today | source chips (24h / 7d / 30d / alerts), credits remaining, last sync |
| Pool      | candidates        | with wallet, funded buyers in 24h, last scan                         |
| Watch     | watching          | promotable vs bench target 10, cooling count                         |
| Roster    | filled seats / 5  | per-seat status: BUYING / SELLING / IDLE / RECONCILING / EMPTY       |
| Exits     | fired in 24h      | replacements in 24h, closed PnL                                      |

Edges: `discovery→pool` (new), `pool→watch` (qualified), `watch→roster`
(promoted), `roster→exits` (fired), `exits→watch` (replacement pool). A single
event (candidate admitted / promoted / hired / fired) animates one chip along its
edge, capped at 3 concurrent chips; with `prefers-reduced-motion` the chips do
not move and the counts update.

## Visual language

### Tokens — `apps/web/src/index.css`

- Keep the existing dark tokens. Add a light theme under
  `:root[data-theme='light']` (or `@media (prefers-color-scheme: light)` when the
  operator chooses "system"), with the same semantic names:
  `page`, `page-elev`, `glass`, `glassborder`, `ink`, `muted`, `faint`, `accent`,
  `pos`, `neg`, `warn`, `info`. Example values: page `#f5f6f8`, elev `#ffffff`,
  ink `#12141a`, muted `#5b6270`, accent `#0891b2`, pos `#059669`, neg `#dc2626`.
- No component may hardcode a hex value; everything uses the tokens.
- Add `--color-flow` and `--color-flowdim` for pipeline edges (accent-derived).

### Theme switching

- `apps/web/src/theme.tsx`: `ThemeProvider` with `system | dark | light`,
  persisted to `localStorage`, sets `document.documentElement.dataset.theme`.
- Inline pre-paint script in `index.html` to avoid a flash on load.
- Header toggle (sun/moon/system) with an accessible label; the Playwright suite
  sets the theme explicitly.

### Typography (from the system references)

- Families: keep Geist Sans / Geist Mono.
- Roles: page title 24–30 semibold; section title 18–20 semibold; card title 16
  medium/semibold; body 14; label 12 medium; overline 10–11 mono with +0.06em
  tracking; numerics mono tabular.
- Hierarchy by size, weight, color, spacing — not by extra colors.
- No text below 11px; no 8px annotations (existing rule).

### Nodes, seats and edges

- Stage node: 12px radius, 1px border, glass fill, inner highlight; active node
  gets a 1.5s pulse ring (static ring under reduced motion).
- Roster seat: avatar + handle, status chip (mono tag), realized/unrealized PnL
  (pos/neg), open-position count, last signal age, streak dots, fire action.
- Empty seat: dashed border, "Open seat — fills from the promotion queue".
- Edge: 1.5px Bézier, low-opacity; active flow dashed and animated; thickness
  `1 + log(1 + count24h)`; arrowless (Sankey convention), with a small direction
  chevron near the target.
- Fired lane: red-tinted edge and a compact list of the last 5 fired seats with
  reason and replacement status.

## Code changes

### Server (small, data accuracy)

- `apps/server/src/services/state.ts`: add `pipeline` to `DashboardState`:
  ```
  pipeline: {
    asOf: string;
    discovery: { lastSyncAt: string | null; newHandles24h: number; creditsRemaining: number | null; sources: string[] };
    pool: { total: number; withWallet: number; fundedBuyers24h: number };
    watch: { watching: number; cooling: number; promotable: number; benchTarget: number };
    roster: Array<{ activationId: string; candidateId: string; handle: string; status: string; realizedPnlUsdMicro: string; unrealizedPnlUsdMicro: string; openPositions: number }>;
    exits: { fired24h: number; replacements24h: number };
    edges: Array<{ from: string; to: string; count24h: number }>;
  }
  ```
  All counts are DB-derived (transitions from `watch_wallets`, `firing_events`,
  activations, `shadow_trades`). No client-side synthesis.
- `apps/server/src/services/builder.ts`: fill it. Reuse the roster/watchlist data
  from plans 04/05; count transitions in the last 24h.

### Web components

- `src/components/pipeline/PipelineFlow.tsx` — layout, edges, stage nodes; pure
  layout math in `pipeline/layout.ts` (unit-tested).
- `src/components/pipeline/StageNode.tsx`, `RosterSeat.tsx`, `CandidateChip.tsx`,
  `FlowEdge.tsx`, `FiredLane.tsx`.
- `src/components/RosterPanel.tsx` — five seats (replaces `ActiveTraderCard` as
  the primary view; the card becomes `RosterSeat`).
- `src/components/WatchRail.tsx` — watchlist + activity + audit tabs.
- `src/pages/Dashboard.tsx` — new composition; keep `PageTabs` for secondary
  sections.
- `src/components/Header.tsx` — theme toggle + mode badge.
- `src/types.ts` — mirror the new `pipeline` shape.
- `src/api.ts` / `useDashboard.ts` — unchanged transport; SSE drives updates.

### Responsive rules

- Container: `max-width: 600px` below 900px; `max-width: 1080px` at ≥900px, with
  the hero text column capped at 600px inside it.
- Pipeline: horizontal at ≥900px; vertical stepper below; no horizontal overflow
  at 320px.
- Roster: 5 columns at ≥1100px, 3 at ≥900px, 2 at ≥600px, 1 at <600px (or a
  snap carousel at <600px).
- Tables/lists: stacked cards at <700px; never 8 columns on a phone.

### Motion

- Chip traversal 1.2s along the edge; node pulse 1.5s; card enter 240ms.
- Cap concurrent chips at 3; queue the rest as count updates.
- `prefers-reduced-motion`: no traversal, no pulse; only opacity/count changes.
- Each animation must have a static equivalent that conveys the same data.

### Accessibility

- Contrast AA in both themes (body text ≥4.5:1; large/mono numerics ≥3:1).
- Stage nodes and seats are buttons with `aria-label` ("Pool: 148 candidates,
  47 buyers"); focus ring visible in both themes.
- The pipeline is a `<nav aria-label="Trading pipeline">` with an ordered list;
  the visual SVG edges are `aria-hidden`.
- Keyboard: every seat/action reachable; the theme toggle is a labelled control.

## Tests

- `apps/web/tests/pipeline-layout.test.ts`: node positions deterministic; edge
  thickness monotonic; empty stages render.
- `apps/web/e2e/pipeline.spec.ts`:
  - 390×844 and 1280×800: hero above the fold; five stages; five seats; the
    mobile stepper has no horizontal overflow;
  - light and dark: tokens applied, no hardcoded colors;
  - reduced motion: no chip animation (assert static);
  - counts equal the API payload (no invented numbers);
  - empty/loading/error states render.
- Visual: the verifier renders the dashboard at 390/1280 in both themes and
  inspects the screenshots against this plan (see verification).

## Acceptance criteria

- **AC1** — At 1280×800 the page order is: context row → equity hero → pipeline
  spine → roster grid → positions/watch → activity; the hero is fully visible
  without scrolling.
- **AC2** — The pipeline renders exactly five stages with the labels and counts in
  the table above; every count comes from `DashboardState.pipeline` (no client
  derivation).
- **AC3** — Edges exist for discovery→pool, pool→watch, watch→roster,
  roster→exits, exits→watch; thickness encodes `count24h`; the fired lane shows
  the last five fired seats with reason and replacement status.
- **AC4** — The roster renders five seats; filled seats show handle, status
  (BUYING/SELLING/IDLE/RECONCILING), realized/unrealized PnL, open positions,
  last signal age, streak, and a fire action; empty seats show the dashed
  "Open seat" state.
- **AC5** — A promoted, hired or fired event animates exactly one chip along its
  edge (max 3 concurrent); with `prefers-reduced-motion` no chip moves and the
  counts still update.
- **AC6** — At 390×844 the hero is first, the pipeline is a five-stage stepper
  with no horizontal page overflow, and the roster renders as a carousel/single
  column; all controls are ≥44px.
- **AC7** — Dark and light are both complete: every surface, border, text tier
  and semantic color has a token; no component hardcodes a hex; switching the
  theme changes the whole page, and the choice persists and respects "system".
- **AC8** — Contrast passes AA in both themes for body text, labels and the
  pos/neg PnL pair.
- **AC9** — The pipeline is keyboard-reachable (`nav` + ordered list), each stage
  and seat has an accessible name with its counts, and the edges are
  `aria-hidden`.
- **AC10** — Every figure on the page is labeled with its source/freshness
  (`asOf`), and the empty, loading and error states are implemented.
- **AC11** — At 200% zoom and 320px width the layout stacks without clipping or
  below-11px text.
- **AC12** — `apps/web/AGENTS.md` and `index.css` are updated: dark + light
  parity, pipeline as the dashboard spine, the 1080px desktop container, and the
  new components. The old "pipeline inside Now copying" rule is removed.
- **AC13** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm e2e` pass.
- **AC14** — No divergence from `DECISIONS.md`: 5 seats, watch 20 / bench 10,
  roster status semantics, and no invented numbers.

## Out of scope

- Changing server trading logic.
- New chart libraries; the existing recharts closes chart and hand-rolled
  sparkline stay.
- Marketing/brand assets.
- A theme editor beyond light/dark/system.

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/07_pipeline_dashboard.md`.

Additionally, the verifier must render and inspect four screenshots —
390×844 dark, 390×844 light, 1280×800 dark, 1280×800 light — and judge:

- hierarchy: is the equity/PnL the first read, and the pipeline the second?
- legibility: are the counts and PnL readable at phone width?
- flow: do the stages read left-to-right (desktop) / top-to-bottom (mobile),
  with the fired/replacement lane obvious?
- parity: do both themes look intentional, not inverted?
- motion: is the static reduced-motion state still informative?
