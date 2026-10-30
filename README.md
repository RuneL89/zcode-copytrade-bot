# ZCode Bot

**A day-trading bot for Solana, run from your own machine.** It hires today's leader, copies their buys, and fires them when the day turns.

## What this is

ZCode Bot reads the 24-hour leaderboard on fomo.family, hires one trader at a time, and copies that trader's Solana buys at a quarter of the leader's measured input. It mirrors their sells, and it exits anything still open at 16 hours. When the trader drops off the board, slips out of its top three twice in a row, loses twice in a row, goes quiet for 8 hours, or leaves you with nothing to copy for 12 hours, it fires them and hires the next name from a researched shortlist. If nothing qualifies, it pauses and says why.

It runs on your PC with your keys. Paper trading is the default, and live signing needs a separate arming step.

What you end up with:

- one active trader, chosen because they are trading today and up on the day, not because they had a good month
- buys copied at 0.25x of the leader's measured input, capped per buy (default $10 to $250)
- sells mirrored from the leader, plus automatic time exits
- automatic replacement from the shortlist, or a visible paused state when no candidate qualifies
- a dashboard with equity, open positions, the closes chart, the candidate strip, and an audit trail
- a research loop that reads the board in your own Chrome and keeps its own values current

## Getting started

**The double-click path.** Run `install.bat` from the repository folder. It installs a portable Node LTS if you do not have one, sets up pnpm, installs dependencies, builds every package, creates `.env` from the example with a generated session secret, creates the SQLite database, offers to load example candidates, and adds Start Menu and Desktop shortcuts. An existing `.env` is never overwritten. At the end it asks whether to start the app.

`launch.bat` starts the server if it is not already running. It does not open a browser itself, so open [http://127.0.0.1:8787](http://127.0.0.1:8787) yourself.

On first login the app asks for a one-time setup token. The server prints it at startup and writes it to `data/setup-token.txt`. `pnpm user:token` reprints it. You choose the username and password at that point; passwords are hashed locally with scrypt.

**The terminal path.**

```bash
pnpm install
cp .env.example .env        # then set SESSION_SECRET
pnpm build
pnpm db:migrate
pnpm db:seed                # optional: example candidates from fixtures/
pnpm start
```

Before any live trading you also need a wallet: `pnpm wallet:create` generates and encrypts the dedicated Solana wallet.

When it works you land on the TRADE page in paper mode, with a PAPER badge and, once the shortlist has someone eligible, an active trader card.

## The day-trading rhythm

The whole design assumes short holds. That is why selection looks at the last 24 hours, why positions expire at 16 hours, and why a trader can lose the slot for going quiet rather than for losing money.

![The day-trader loop: the sweep reads the 24h board every 30 minutes, Dawn resolves the new wallets, the researcher ranks by today's PnL, the bot hires one trader, copies buys at 0.25x, mirrors sells, and fires on decay (off the board, out of the top three twice) as well as two losses, 8 hours of leader silence, or 12 hours idle, then hires the next candidate or pauses](docs/images/copy-loop-overview.png)

_Read it clockwise: candidate sourcing at the top, the copying loop in the middle, and the fire-and-replace cycle at the bottom._

There are five ways to lose the slot:

- **Off the board.** The latest scan does not contain the trader. One miss is enough: falling off a board that turns over every few hours is decay, and the bot leaves before it shows up as losses.
- **Out of the top three twice.** Two consecutive scans rank the trader below the top three. One scan at rank four is a single strike; a scan back inside the top three clears it.
- **Two losing closes in a row.** A winning close resets the count; a breakeven leaves it unchanged.
- **Leader silence.** The leader's wallet shows no on-chain activity for 8 hours while you hold. This is judged only when the on-chain check itself is fresh, so a broken data source cannot fire a healthy trader.
- **Idle.** Twelve hours pass with no position open, measured from the hire or the last position held.

Two further rules keep the book honest. Every hire must appear on the latest scan, so the bot never buys a trader the board has already dropped. And when the board is fresh and the hire holds nothing, an ordering that outranks them takes over, unless the incumbent still sits in the scan's top three.

A fire is not a market action by itself. Positions close under the configured policy first (the default closes everything), and the next eligible candidate takes over. There is no cooldown: a fired trader can be rehired the moment the board and the shortlist say so. If nobody does, the bot moves to PAUSED_WAITING_FOR_ZCODE and the dashboard says so.

## Where candidates come from

![The research pipeline with its tools: a 30 minute sweep that always reads the board in desktop Chrome with click and clipboard capture, fomo-import upserts the roster, a Dawn auto-run resolves wallets for new faces, snapshot-rebuild writes snapshot.json and runs the rank watch, the researcher reads it through the three-tool MCP bridge, submits an atomic inbox file, and the worker validates the snapshot id and hash before hiring](docs/images/research-pipeline.png)

_Each box is a real command or tool in the repo. The dashed arrow is the researcher abstaining with POOL_STALE, which becomes a request for the next board read._

| Step              | Tool or command                                                                                                                                    | What it writes                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Research decision | the sweep automation, `0,30 * * * *`, SQLite read-only                                                                                             | nothing, it only decides                                                       |
| Board read        | desktop Chrome, `Ctrl+L` / `Ctrl+C` / `Get-Clipboard`, every sweep                                                                                 | `entries.json`                                                                 |
| Roster upsert     | `pnpm exec tsx src/cli/fomo-import.ts entries.json`                                                                                                | `trader_candidates`, `leaderboard_observations`, audit `fomo-web-manual`       |
| Wallets and marks | `pnpm exec tsx src/cli/dawn-lookup.ts --all-missing --limit 25`, also boot +2 min, every 6h, and after any rebuild that still sees missing wallets | `candidate_addresses`, PnL and trade columns, audit `dawn-lookup`              |
| On-chain activity | `pnpm exec tsx src/cli/candidate-activity.ts --limit 30`, also every 6h                                                                            | `swaps_24h`, `last_swap_at`, `activity_checked_at`                             |
| Snapshot          | `pnpm exec tsx src/cli/snapshot-rebuild.ts`, also every 30 min and about 60s after a Dawn or Helius change                                         | `research_snapshots`, `data/research/snapshot/snapshot.json`, rank-watch check |
| Research input    | MCP `get_research_snapshot`                                                                                                                        | nothing, read only                                                             |
| Submission        | MCP `submit_candidate_recommendation`                                                                                                              | one atomic file in `data/research/inbox/`                                      |

**1. The sweep always reads the board.** The automation in `docs/research-sweep-automation.md` runs every 30 minutes and refreshes the leaderboard unconditionally. A valid recommendation, or the need for research, makes no difference to the read. The rank rule needs scan evidence at that cadence, so there is no age threshold and no once-per-N-hours cap. The database read that remains decides only whether research itself runs. A broken read aborts without importing and skips research for that run; a missing scan is never treated as evidence.

**2. The board read happens in your Chrome.** The sweep opens `https://fomo.family/leaderboard?range=24h` in your normal desktop Chrome and raises the window with `WScript.Shell.AppActivate`, because the automation API cannot front a background window on Windows. It screenshots to find the row positions, then for each visible row clicks the row, presses `Ctrl+L` then `Ctrl+C`, and reads the exact profile URL with `Get-Clipboard`, stripping the `?r=` referral parameter. It aborts without importing when fewer than five rows are captured, when any URL is not `https://fomo.family/profile/<slug>`, or when the range chip is not 24H. It never OCRs a handle and never guesses a slug. The manual equivalent is `tools/gui/board-pass.ps1`. There is no Playwright path to the site.

**3. Four tools fill the roster and its evidence.**

- `fomo-import` upserts `trader_candidates` keyed by handle, preserving statistics it did not capture (a board import never wipes Dawn or Helius values), and audits under `fomo-web-manual`.
- `dawn-lookup` asks Dawn, the Telegram bot, for each candidate's wallet and card: PnL for 24h, 7d, 30d and all time, trade count, recent buys and sells. It runs two minutes after boot, then every 6 hours, and once more after any snapshot rebuild that still sees candidates without a wallet (throttled to one automatic run per 20 minutes). It serves the oldest statistics first and caps at 25 lookups per run (`DAWN_MAX_LOOKUPS_PER_RUN`), which is how a trader newly seen on the board gets a wallet inside the same cycle. Wallets land in `candidate_addresses` with verification `reported`. If the Telegram session has expired the run audits `Telegram session needs login; QR login window opened` and waits for you.
- `candidate-activity` calls Helius `walletActivity24h` for each wallet and writes `swaps_24h`, `last_swap_at` and the `activity_checked_at` stamp that eligibility depends on. Addresses that pass the pre-hire gate are upgraded to `verified`.
- `snapshot-rebuild` publishes the derived snapshot without restarting the server. The runtime also publishes on a 30-minute timer and about 60 seconds after any Dawn or Helius run that changed rows, so research never reads wallet data that is minutes old.

**4. The snapshot is the researcher's entire world.** It is written to `data/research/snapshot/snapshot.json` and to a `research_snapshots` row, and it carries `snapshotId`, `snapshotHash`, `sourceFreshnessSeconds` (the age of the newest observation), `oldestObservedAt`, `staleCandidateCount`, and per candidate the two stamps `activityCheckedAt` (Helius) and `statsCheckedAt` (Dawn). When the freshest observation advances, the server also writes a `board.refreshed_at` marker, which is what later allows rotation. The MCP process receives only `ZCODE_MCP_SNAPSHOT_DIR` and `ZCODE_MCP_INBOX_DIR`, and exposes exactly three tools: `get_research_snapshot`, `get_replacement_context`, `submit_candidate_recommendation`. A submission is an atomic tmp-then-rename file in `data/research/inbox/`; the worker ingests it through `fs.watch` plus a 5 second poll and rejects bad payloads with explicit codes such as `SCHEMA_INVALID`, `SNAPSHOT_MISMATCH`, `EXPIRED` or `REPLAYED_RECOMMENDATION_ID`.

**5. The ranking rule is written down and testable.** A candidate must be enabled, carry exactly one Solana address, and be fresh on at least one clock: `observedAt` within 12 hours, or `activityCheckedAt` within 6 hours. It then needs at least 5 swaps in 24 hours with a swap inside 20 hours, plus a positive fresh day: `pnl24hUsd > 0` and `statsCheckedAt` within 12 hours. Qualified names sort by `pnl24hUsd` descending, then fresher `activityCheckedAt`, then higher `swaps24h`, capped at ten. The engine adds one hard gate of its own: the handle must be on the latest captured scan, so a name the board has dropped is skipped no matter how good the numbers look. Fired traders carry no penalty; the board, not the history, decides. Fewer than three usable candidates, or none with a wallet, means an abstention; when the pool itself cannot support the ordering the reason starts with `POOL_STALE:`, which the worker records as a `control_events` row of type `leaderboard_refresh_request`.

## How one copy happens

![A sequence diagram of a copied trade: a leader buy lands on chain, the worker polls Helius, classifies and deduplicates the event, sizes it at 0.25x, applies risk gates, requests a Jupiter quote, fills in paper mode or signs when live and armed, and later mirrors the leader's sell](docs/images/one-copied-trade.png)

_One leader event, from chain to dashboard. The lower block is the mirrored exit and the automatic 16-hour time exit._

The worker polls the leader's wallet with Helius every 8 seconds. Events older than 90 seconds are dropped, duplicates are discarded, and swaps it cannot classify are skipped rather than guessed at. Sizing is 0.25x of the leader's measured input, clamped to the per-buy minimum and maximum, and the risk gates run before a quote is requested: deployed capital percentage, the day's realized loss cap, price age, slippage and price impact.

In paper mode the fill is simulated from the Jupiter quote, or from a cached price with 30 bps of adverse slippage and 5 bps of fees when no quote exists. In live mode, and only when the wallet is armed, the order is signed and submitted. Either way the position, the fill, and the equity change land on the dashboard.

## When a trader is fired

![A state diagram of the firing lifecycle: watching, then firing after a missed scan, two scans out of the top three, two losing closes, 8 hours of leader silence, 12 hours idle, or a fresh board with nothing open, followed by handoff to the next candidate or a paused state until a new shortlist arrives](docs/images/firing-handoff.png)

_Five ways into Firing plus rotation, one way back out to Watching, and a paused state when the shortlist cannot fill the slot._

Firing is transactional. The worker marks the activation as firing and cancels unsigned intents in one database transaction, applies the position policy, and only then consumes the shortlist. There is no cooldown to register: a fired trader is hireable again the moment they qualify, and the one exclusion is that a trader cannot replace themselves in the same handoff. An unknown close outcome does not get retried: it moves the activation to REQUIRES_RECONCILIATION and waits for you.

The rank rule runs on every snapshot rebuild, about every 30 minutes, and reads the last two captured scans. When the newest scan is older than two hours the rule stands down and says so in the audit trail; a broken Chrome read slows the bot down instead of firing blind, and the silence, idle, and time-exit backstops keep running.

Replacement walks the whole ordering rather than stopping at the first candidate that fails to activate, so one candidate with a stale wallet cannot strand the slot. Rotation is narrower: it is honoured only in the sweep that follows a board refresh, it skips while the incumbent sits in the scan's top three, and it never fires into an empty chair. It is enabled in live mode by default (`ROTATE_ON_REFRESH=true`); remove that line to keep it paper only.

## Honest limitations

- **Displayed PnL is not banked profit.** Every PnL figure comes from fomo's own marks. The richer card with realized on-chain profit is unreachable on our path, so `realizedOnchainUsd` is null for every candidate. The 24-hour ranking is a claim, and the risk controls, not the ranking, are what bound your exposure.
- **A positive day can be a rebound.** A trader who lost the week and won today may be doubling down. The bot ranks them anyway, by design, because the holding window is hours. Point-farm style divergence is recorded as a concern, not used as a filter.
- **One trader at a time.** The bot copies a single active trader. It does not spread capital across several.
- **Live mode is not exercised by the tests.** Every automated test and the demo use paper execution. Live signing is reachable only through readiness checks, the documented ack string, and a separate arming action.
- **Your PC is the runtime.** If the machine sleeps, loses network, or shuts down, monitoring stops. The dashboard on a phone is a remote view, not a remote runtime.
- **The leaderboard is read through your own Chrome.** The scheduled sweep drives your desktop Chrome with GUI automation every 30 minutes and takes the window for about a minute, around the clock. There is no Playwright path to fomo.family, and a layout change aborts the read instead of guessing.
- **The rank rule is fast and blind past rank seven.** One scan without the incumbent costs them the slot, and "the board" is the visible top seven: rank 8 and rank 500 look identical. When reads fail for hours the rule stands down and the slower backstops take over, so a capture outage suspends the decay exit rather than firing on stale evidence.
- **No cooldown means churn is possible.** A fired trader who qualifies again can be rehired immediately, including one who just lost twice. The shortlist's ordering and the board, not a memory of past firings, decide who holds the slot.
- **Dawn can log itself out.** Telegram Web sessions expire. Lookups are paced at roughly 20 seconds plus jitter, and a dead session needs one QR scan from you.
- **Equity is USDC trading capital; fees live elsewhere.** Trade PnL is proceeds minus cost basis in USDC, so equity tracks the USDC balance. Network fees and account rent are paid in SOL from a separate reserve, measured by the fee ledger, and are not part of the equity number.
- **Paper fills are assumptions.** A quote-based simulation and a cached price with 30 bps slippage are approximations, never real executions.
- **The positive-day gate can thin the pool.** If fewer than three candidates qualify, the researcher abstains and the bot holds its current book.
- **Reconciliation needs you.** Unknown execution outcomes stay open until you resolve them with on-chain evidence, and those positions are kept out of equity.
- **Emergency stop is not a recall.** It blocks new entries and non-risk-reducing signing. It cannot undo a transaction already on chain.
- **The dashboard is local plain HTTP.** Keep it on your machine or your own Wi-Fi. Do not expose port 8787 without HTTPS and a reverse proxy.

## Technical appendix

Node 22 or newer, TypeScript throughout. The server is Hono with REST and SSE; the dashboard is React, Vite, and Tailwind; storage is SQLite through Drizzle with WAL; the chain side is `@solana/web3.js`, Helius for leader activity, and Jupiter Swap API v1 for quotes and swaps. The research bridge is the official MCP SDK over stdio, restricted to three tools. Tests are Vitest, plus Playwright for the browser suite.

```
zcode-bot/
  apps/
    server/       Hono API, worker, monitor, executors, ops console, CLIs
    web/          React dashboard (TRADE, OPS, SETTINGS, AUDIT)
    zcode-mcp/    restricted research bridge, exactly three tools
  packages/
    core/         money, sizing, exits, streaks, eligibility, recommendation validation
    db/           Drizzle schema, migrations, repositories
    providers/    FOMO import, Dawn, Helius, Jupiter, pricing, notifications
    config/       Zod env and risk validation
  docs/           runbook, fetching procedure, automation contract, diagrams
  fixtures/       example imports and the fictional demo timeline
  tools/gui/      clipboard-driven PowerShell readers for desktop Chrome
  install.bat launch.bat enable-phone-access.bat
```

Three decisions shape the code. The worker is the only authority: the researcher nominates, and never signs, sizes, or exits. Everything fails closed: ambiguous swaps are skipped, unknown outcomes become reconciliation cases, stale or mismatched recommendations are rejected, and an exhausted shortlist pauses instead of inventing a trader. And money is integer micro-USD as bigints, with token amounts as base-unit strings, never floats.

More detail lives in `docs/ZCODE_AUTOMATION.md` (the research contract), `docs/FOMO_DAWN_FETCHING.md` (the canonical board and wallet procedure), `docs/RUNBOOK.md` (operations), and `AGENTS.md` (the repository contract).

## Where things live

- `data/zcode-bot.db`, the SQLite database (WAL)
- `data/wallet/`, the encrypted Solana key
- `data/research/snapshot/`, `inbox/`, `processed/`, the research files
- `data/browser-profile-dawn/`, the Telegram session for wallet lookups
- `.env`, your configuration and keys, entered locally and never committed
- `docs/screenshot-dashboard.png`, `docs/screenshot-handoff.png`, `docs/screenshot-operations.png`

Run the checks with `pnpm typecheck`, `pnpm test`, and `pnpm e2e`; `pnpm format` and `pnpm format:check` cover formatting. `pnpm demo` replays a fictional 28-second session without touching real data.
