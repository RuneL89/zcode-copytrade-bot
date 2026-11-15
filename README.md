# Copydesk

**A copy desk that only trades what it has already proven.**

## What it is

Copydesk is a self-hosted Solana copy-trading desk for one operator. The fomoapi leaderboard nominates wallets, Helius watches what those wallets do on chain, and Jupiter prices the swaps it copies. It runs on free API tiers, on your own Windows PC, in paper mode by default.

What you end up with:

- a five-chair roster of leaders that earned a place on a shadow ledger, sharing one $100 budget pool
- copies at 0.25x the leader's measured input, with a $2 floor, a $10 ceiling per buy, and $40 open per leader
- mirrored sells, plus code exits: a -25% stop, a trailing stop, a partial profit target, and a 5-hour age ceiling with a 1.5-hour grace window
- a dashboard at http://127.0.0.1:8787 with the five-stage pipeline, the roster seats, the watch list, and an audit trail for every decision
- a Helius credit governor that plans a 5,796-credit day against a 13,600-credit hard cap
- paper fills by default; live signing only after a readiness check and a separate arming action

## Getting started

**The double-click path.** Run `install.bat` from the project folder. It installs a portable Node if you do not have one, installs pnpm and the dependencies, builds every package, creates `.env` from `.env.example` with a generated `SESSION_SECRET`, creates the SQLite database, offers to load the example candidates, and adds Start Menu and Desktop shortcuts. It never overwrites an existing `.env`.

Run `launch.bat` or the shortcut. It starts the server if it is not already running and leaves the dashboard for you to open; browser auto-open is disabled so it cannot lock the Chrome profile used by the manual FOMO fallback. Open [http://127.0.0.1:8787](http://127.0.0.1:8787). The first login asks for the one-time setup token printed by the server and written to `data/setup-token.txt`; it is valid for 30 minutes, and `pnpm user:token` reprints it. You choose the username and password then.

**The terminal path.**

```bash
pnpm install
cp .env.example .env        # set SESSION_SECRET to 32+ random characters
pnpm build
pnpm db:migrate
pnpm start
```

`pnpm db:seed` optionally imports `fixtures/leaderboard.example.json`. `pnpm dev:server` runs the server from source instead of the built output.

When it works you land on the TRADE page with a PAPER badge, the pipeline, five roster chairs, the watch list, and the audit trail. `pnpm demo` starts a separate fictional 28-second replay and writes nothing to the live tables. The short operator guide is [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

## Running it on Windows as a service

Windows startup has two paths: the watchdog that ships in this repo, and the PowerShell service used by the deployed copy.

**The in-repo watchdog (a fresh clone).** `install-watchdog.bat` creates two hooks:

- a Startup-folder shortcut that starts the server when you log on;
- a scheduled task named "Copydesk watchdog" that runs `watchdog.bat` every five minutes. The script asks `http://127.0.0.1:8787/api/bootstrap`; when nothing answers, it starts `run-server.bat` again.

The server's output goes to `data/server.log`; watchdog transitions go to `data/watchdog.log`. The watchdog deliberately leaves a server that listens but does not answer alone, because killing it blind could strand an in-flight trade. Remove the hooks with `schtasks /Delete /TN "Copydesk watchdog" /F` and delete `Copydesk.lnk` from the Startup folder.

**The deployment PowerShell service.** The deployment copy adds two scripts under `scripts\`; they are not tracked in this source tree:

- `scripts\copydesk-service.ps1 start|stop|restart|status` starts, stops, restarts, or reports the supervised server. It tracks pids under `logs\`, checks `127.0.0.1:8787`, and refuses to touch unrelated processes or ports.
- `scripts\install-copydesk-task.ps1` registers a scheduled task named "Copydesk" that starts the service at logon and at startup, with a restart-on-failure policy. It does not modify the older "Copydesk watchdog" task.

Run them from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\copydesk-service.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-copydesk-task.ps1
```

The service script has a `$Root` at the top, and the task installer embeds the same folder path. Update both if you move the folder. If you switch a machine from the watchdog to the service, remove the old task first; the task installer leaves it in place.

**Linux.** `deploy/copydesk.service` is a systemd unit for a Linux host. It runs the built server with the repo as its working directory and restarts on failure.

## The dashboard

The server listens on `127.0.0.1:8787` by default. The four tabs are TRADE, OPS, SETTINGS, and AUDIT. TRADE is the dashboard: equity, the pipeline spine, the roster seats, open positions, and the watch rail. OPS carries the commands that normally need a terminal (build, migrations, tests, backup, restart, shutdown, wallet setup). SETTINGS carries provider keys, risk limits, pause and emergency stop, live readiness, and manual import. AUDIT carries every admission, shadow trade, promotion, rejection, fill, firing, and risk block with its reason.

`#/desk` is the assembly-line view: SOL balance, USDC available, unrealised P&L, a funnel of the server's stage counts, the five seats with their open copies, the credit meter, and a risk form. The badge reads LIVE only when the server reports armed and healthy; otherwise it reads PAPER, or DEMO with a banner.

For a phone on the same Wi-Fi, run `enable-phone-access.bat`. It asks for one UAC approval, adds a firewall rule for port 8787, sets `HOST=0.0.0.0` in `.env`, restarts the app, and prints the address. Traffic is plain HTTP; keep it on your own network or behind a VPN, and never forward the port to the internet.

## How a wallet earns a chair

The desk is a pipeline with five dashboard stages, a bench queue between the watch list and the roster, and a return lane for fired chairs. Each stage is visible on the dashboard and carries a count.

| Stage         | What happens                                                                                                                                                             | What gets through                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery     | The fomoapi 24h, 7d, and 30d boards plus the alerts feed are read on demand.                                                                                             | Candidates with a stable identity; a verified Solana wallet when the inlet supplies one.                                                                                                                  |
| Pool          | Every candidate the inlet has seen waits here, with or without a wallet.                                                                                                 | Nobody is hired from this list.                                                                                                                                                                           |
| Watch list    | Twenty wallets are observed; the monitor reads their funded buys and sells on a five-minute clock.                                                                       | A wallet enters with at least three funded buys in 24 hours and a last funded buy inside 24 hours.                                                                                                        |
| Shadow ledger | Every funded buy opens a pretend position at the notional the desk would have used, and closes it on the leader's sell, a code exit, or the age ceiling at a live price. | None of this spends money; it is the evidence.                                                                                                                                                            |
| Bench         | A watched wallet joins the bench when its shadow record passes the gate.                                                                                                 | At least eight closed shadow trades, net shadow PnL above $3, a funded buy inside four hours, and no re-entry ban. The bench is a queue ordered by shadow net, and it can fill while every chair is full. |
| Roster        | Five chairs share one budget pool. A freed chair takes the best bench record.                                                                                            | A chair can stay empty; that is an accepted state.                                                                                                                                                        |
| Exits         | A leader's sell is mirrored at the same fraction. Code exits handle the rest.                                                                                            | A closed position updates realized PnL, the loss streak, and equity.                                                                                                                                      |
| Fired lane    | Every firing is written down with its cause and whether the chair was refilled.                                                                                          | A fired wallet returns only after a funded buy observed after the firing, and after the default 36-hour re-entry delay.                                                                                   |

Discovery is demand-driven, not scheduled. It runs when a free chair has nothing promotable behind it, or when the bench sits below its target of ten wallets, and at most once every 30 minutes. A full roster with a full bench does not run discovery.

The fomoapi free tier is 250,000 credits a month. A leaderboard read costs 250 credits and an alerts read about 125; an unchanged board answered with an ETag costs nothing. Each run writes one audit line with the rows read, the traders added, and the credits spent and left.

## How a copy happens

**Monitoring.** With a Helius key, the roster uses a `logsSubscribe` WebSocket for up to five seats, with a hot spare and a five-minute signature-first safety poll. If both sockets stay down for 60 seconds, the desk switches to a 45-second signature-first poll on a separate outage budget. The watch list keeps its own five-minute poll. The trading monitor never uses the public RPC; that endpoint belongs to the candidate activity refresh.

**Classification.** A leader event is accepted only when it is a swap the classifier can read. Duplicate events are dropped by `(chain, leader, signature, leg)`. Buys older than 90 seconds are rejected. Two buys of the same mint by the same leader inside 60 seconds are coalesced into the existing position. An ambiguous swap is skipped.

**Sizing.** The copy notional is `clamp(0.25 x leader input, $2, $10)`, then capped by the leader's remaining $40 open room and the shared deployed cap (80% of capital, so $80 on a $100 bankroll). The $2 minimum is a floor. A buy that would scale below it is placed at $2; it is not skipped.

**Risk gates.** Before a quote is requested, the engine checks the deployed share of capital, the day's realized loss, the age of the price (45 seconds), maximum slippage (300 bps), and maximum price impact (300 bps). A rejection is written to the audit trail with the rule name and the numbers that failed.

**Execution.** Jupiter Swap API v2 `GET /swap/v2/build` on `api.jup.ag` supplies the route. Paper mode simulates the fill at the quote, or at the cached price with 30 bps of adverse slippage and 5 bps of fees when there is no quote. Live mode is reachable only after the readiness checklist and a separate arming action; it signs and submits only while armed. Automated tests and the demo never construct the live executor.

**Exits.** A leader sell closes the same fraction of the copied position. The code exits run before the clock: a -25% stop, a trailing stop that arms at +15% and sells 10% off the peak, and a partial take-profit at +40% that sells half. At five hours a green position sells; otherwise it enters a 1.5-hour grace window, sells on an 8% bounce off the grace low while still below entry, or is force-closed at the deadline. Exit attempts use a 300, 600, then 1,000 bps slippage ladder.

**Firing.** A chair is lost for one of four reasons: two losing closes in a row, a leader wallet silent for eight hours, eight hours with no open positions, or a manual FIRE. The fire is transactional: the chair is marked FIRING and unsigned orders are cancelled in one database transaction, then the position policy runs, then the bench is asked for a replacement. A close-out that needs reconciliation freezes only that chair.

## Risk limits

All values are defaults, editable in `.env` and most of them in the Settings risk form. Money limits are integer micro-USD internally.

| Limit                              | Default                                                                 | Environment name                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Starting bankroll                  | $100                                                                    | `EQUITY_START_USD`                                                                |
| Copy scale                         | 0.25x                                                                   | `COPY_SCALE`                                                                      |
| Per-buy floor / ceiling            | $2 / $10                                                                | `MIN_PER_BUY_USD` / `MAX_PER_BUY_USD`                                             |
| Open exposure per leader           | $40                                                                     | `MAX_OPEN_PER_TRADER_USD`                                                         |
| Deployed cap                       | 80% of capital                                                          | `MAX_DEPLOYED_PCT`                                                                |
| Daily realized loss stop           | $15                                                                     | `MAX_DAILY_REALIZED_LOSS_USD`                                                     |
| Max hold / grace                   | 5 hours / 1.5 hours                                                     | `MAX_POSITION_AGE_HOURS` / `POSITION_GRACE_HOURS`                                 |
| Stop loss                          | -25% from entry                                                         | `STOP_LOSS_BPS`                                                                   |
| Trailing stop                      | arms at +15%, sells 10% off the peak                                    | `TRAIL_ARM_BPS` / `TRAIL_DISTANCE_BPS`                                            |
| Partial take-profit                | +40%, sells half                                                        | `PARTIAL_TP_BPS`                                                                  |
| Sell on green                      | on                                                                      | `SELL_ON_GREEN`                                                                   |
| Exit slippage ladder               | 300 / 600 / 1,000 bps                                                   | `EXIT_SLIPPAGE_BPS_1` to `_3`                                                     |
| Max entry slippage / price impact  | 300 / 300 bps                                                           | `MAX_SLIPPAGE_BPS` / `MAX_PRICE_IMPACT_BPS`                                       |
| Max copied event age               | 90 seconds                                                              | `MAX_COPY_EVENT_AGE_SECONDS`                                                      |
| Max price age                      | 45 seconds                                                              | `PRICE_MAX_AGE_SECONDS`                                                           |
| Admission                          | 3 funded buys in 24h, last within 24h                                   | `ADMISSION_MIN_BUYS_24H` / `ADMISSION_MAX_LAST_BUY_HOURS`                         |
| Promotion                          | 8 closed shadow trades, net above $3, last buy within 4h                | `PROMOTION_MIN_CLOSED` / `PROMOTION_MIN_NET_USD` / `PROMOTION_MAX_LAST_BUY_HOURS` |
| Watch list / bench target / roster | 20 / 10 / 5                                                             | `WATCH_LIST_SIZE` / `BENCH_TARGET` / `ROSTER_SIZE`                                |
| Idle fire                          | 8 hours                                                                 | `IDLE_FIRE_HOURS`                                                                 |
| Stall fire                         | 8 hours                                                                 | `LEADER_STALL_FIRE_HOURS`                                                         |
| Pre-hire activity gate             | last copyable trade within 20h, at least 3 in 24h, from a fresh reading | `MAX_LEADER_STALL_HOURS` / `MIN_LEADER_SWAPS_24H`                                 |
| Re-entry delay after a firing      | 36 hours, plus a funded buy after the firing                            | `COOLDOWN_HOURS`                                                                  |
| Repeat-fire archive                | 2 firings in 7 days                                                     | `REPEAT_FIRE_LIMIT` / `REPEAT_FIRE_WINDOW_DAYS`                                   |
| Agent hire decisions per day       | 3                                                                       | `MAX_HIRES_PER_DAY`                                                               |
| Watch eviction                     | after 14 days without a funded buy                                      | `WATCH_EVICTION_DAYS`                                                             |
| Cooling scan                       | every 2 hours                                                           | `COOLING_SCAN_MS`                                                                 |
| Per-mint cap                       | off (0 disables it)                                                     | `PER_MINT_CAP_USD`                                                                |

The risk form refuses an inverted pair (a maximum below the minimum), a per-leader open cap below the per-buy maximum, a decreasing exit slippage ladder, and a bench target above the watch-list size. Raising a limit from the dashboard needs `RISK_PIN`; an empty PIN rejects every increase.

## Configuration

`.env` is the only configuration surface. Start from `.env.example`, enter keys locally, and never commit `.env`. The server refuses to start without `SESSION_SECRET`.

| Area             | Variables                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Mode and server  | `MODE`, `PORT`, `HOST`, `DATA_DIR`, `SESSION_SECRET`, `EQUITY_START_USD`, `FORCE_INSECURE_COOKIE`                                   |
| Helius           | `HELIUS_API_KEY`, `HELIUS_PROJECT_ID`, `HELIUS_WEBHOOK_SECRET`, `PUBLIC_SOLANA_RPC_URL`                                             |
| Jupiter          | `JUPITER_BASE_URL`, `JUPITER_API_KEY`                                                                                               |
| fomoapi          | `FOMOAPI_KEY`, `FOMOAPI_BASE_URL`                                                                                                   |
| Risk             | the environment names in the risk table above                                                                                       |
| Live             | `LIVE_TRADING`, `LIVE_TRADING_ACK`, `WALLET_FILE`, `COPYDESK_WALLET_PASSPHRASE`, `RISK_PIN`                                         |
| Hire approval    | `HIRE_APPROVAL`, `AGENT_API_TOKEN`, `AGENT_WEBHOOK_URL`                                                                             |
| Notifications    | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`                                                                                            |
| Manual fallbacks | `FOMO_LEADERBOARD_URL`, `FOMO_BROWSER_CHANNEL`, `FOMO_WEB_POLL_MS`, `DAWN_BOT_USERNAME`, `DAWN_WEB_URL`, `DAWN_MAX_LOOKUPS_PER_RUN` |

Only names are listed here; the shipped defaults live in the risk table above and in `.env.example`. The risk names are read by the same loader as the rest of `.env`, and the Settings form writes the same stored values. Telegram is optional and read-only: with both variables set, the bot sends the daily summary and answers `/status`, `/weekly`, `/positions`, and `/help`. Nothing typed in Telegram can pause, arm, fire, or close.

`HIRE_APPROVAL` defaults to `auto`, which fills a free seat from the bench. `agent` leaves the seat empty until a hire decision arrives at `POST /api/agent/hire-decisions`; exit plans can only be tightened through `POST /api/agent/exit-adjustments`. An empty seat POSTs to `AGENT_WEBHOOK_URL` when that is set. The agent token cannot arm, sign, or withdraw.

## Helius credits

Helius is the metered provider in the trading loop. The free plan is 1,000,000 credits a month. The governor plans a 5,796-credit day and refuses spend past a 13,600-credit daily hard cap; the planned month stays under 600,000 credits.

| Bucket  | Daily cap | Expected day | Notes                                                                           |
| ------- | --------- | ------------ | ------------------------------------------------------------------------------- |
| roster  | 4,000     | 2,000        | Ring-fenced; WebSocket bytes and safety polls.                                  |
| exit    | 1,500     | 300          | Ring-fenced; never paused by the degrade ladder.                                |
| watch   | 2,500     | 800          | Helius fallback only; public RPC first.                                         |
| wallet  | 500       | 300          | Balance and fee reads.                                                          |
| vetting | 3,000     | 1,500        | One of only two paths allowed to use `getTransactionsForAddress`.               |
| agent   | 1,500     | 600          | Hire deep-dives; the other full-history path.                                   |
| token   | 500       | 200          | Mint and account reads.                                                         |
| health  | 100       | 96           | One `getSlot` every 15 minutes.                                                 |
| outage  | 6,000     | 0            | Reserve used only while both roster sockets are down; outside the 13,600 total. |

The timer loops are signature-first: `getSignaturesForAddress`, then `getTransaction` for a signature not seen before. `getTransactionsForAddress` is refused on every timer path. Candidate activity refreshes go to the free public RPC first and fall back to Helius only on failure. A 429 backs off, and an exit is retried with jitter rather than discarded: the exit and roster buckets are exempt from the pause.

The monthly ladder is green, amber at 450,000 credits, red at 550,000, roster-only at 600,000, and exits-only at 900,000; daily path ratios can also raise the level. The dashboard's credit meter reads `GET /api/credits`; when `HELIUS_PROJECT_ID` and a key are set, the worker reconciles the in-app meter against Helius's own usage every 30 minutes and trusts the higher figure.

## What it does not do

- **The roster starts empty.** A wallet has to earn a chair: eight closed shadow trades, more than $3 net, a fresh funded buy. The first hours, sometimes a full day, are observation. An empty chair is normal.
- **Paper fills are assumptions.** A quote simulation, or a cached price with 30 bps of slippage, is not an execution. Demo and paper results are never real returns.
- **Live mode is not exercised by the tests.** Every automated test and the demo use simulated fills. Signing needs the readiness checklist, the exact acknowledgment string, and a separate arming action.
- **Your PC is the runtime.** If the machine sleeps, loses the network, or shuts down, monitoring stops. The dashboard on your phone is a remote view, not a remote runtime.
- **Equity excludes fees.** Trade PnL is proceeds minus cost basis in USDC; network fees and account rent are paid in SOL from a separate reserve and measured by the fee ledger.
- **Reconciliation needs you.** An execution with an unknown outcome stays open until you resolve it with on-chain evidence, and those positions are kept out of equity.
- **Emergency stop is not a recall.** It blocks new entries and new signing at once. It cannot undo a transaction already on chain.
- **The dashboard is plain HTTP.** Keep it on the machine or your own Wi-Fi. Do not expose port 8787 without HTTPS and a reverse proxy.
- **The funded-buy screen can thin the pool.** When no watched wallet clears the admission bar, the watch list stays empty and discovery tries again later.
- **WebSocket bytes are metered but not measured against a day of live traffic.** The stream is the newest part of the credit plan.
- **The shadow ledger always assumes 1% slippage per side.** The PnL the promotion bar reads is not a measured fill.
- **The live send path uses the SWQOS minimum tip.** The larger Sender Max tip is not the default.
- **The Telegram fallback session can expire.** The optional wallet lookup needs one QR scan when the session dies.

## Technical appendix

Node 22 or newer, TypeScript throughout. The server is Hono with REST and SSE; the dashboard is React, Vite, and Tailwind; storage is SQLite through Drizzle with WAL; the chain side is `@solana/web3.js`, Helius for leader activity, and Jupiter Swap API v2 for quotes and swaps. Discovery talks to fomoapi from the server process. No language model decides anything: admission, promotion, sizing, exits, and firing are deterministic code. Tests are Vitest, plus Playwright for the browser suite.

```
copydesk-dev/
  apps/
    server/       Hono API, worker, monitor, executors, ops console, CLIs
    web/          React dashboard (TRADE, OPS, SETTINGS, AUDIT)
  packages/
    core/         money, sizing, exits, streaks, watch rules, credit governor
    db/           Drizzle schema, migrations, repositories
    providers/    fomoapi, Helius, Jupiter, public RPC, pricing, notifications
    config/       Zod env and risk validation
  docs/           runbook, getting started, fetching procedure, diagrams
  fixtures/       example imports and the fictional demo timeline
  tools/gui/      clipboard-driven PowerShell readers for desktop Chrome
  deploy/         systemd unit
  IMPLEMENTATION_PLANS/  sequenced build plans
  DECISIONS.md    binding operator decisions
  AGENTS.md       repository contract
  install.bat, launch.bat, install-watchdog.bat, watchdog.bat,
  run-server.bat, run-hidden.vbs, enable-phone-access.bat
```

The code follows a few rules that matter more than the rest. The worker is the only authority: discovery nominates wallets, the bench gate decides who is ready, and nothing outside the engine sizes, signs, or exits. Everything fails closed: ambiguous swaps are skipped, unknown outcomes become reconciliation cases, a stale answer never invents a fill, and an empty chair is acceptable. Money is integer micro-USD in bigints, with token amounts as base-unit strings, never floats.

The project keeps its original name in a few places that predate the rename: the package scope is `@zcode-bot/*`, the database file is `data/zcode-bot.db`, and the session cookie is `zcode_session`. Renaming them is a breaking change that touches a live database and your browser session.

The binding decisions live in [DECISIONS.md](DECISIONS.md) (D1 to D6, with the evidence behind each one), the repository contract in [AGENTS.md](AGENTS.md), the build and verification plan in [IMPLEMENTATION_PLANS/](IMPLEMENTATION_PLANS/), and the operator runbook in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Where things live

- `data/zcode-bot.db`, the SQLite database in WAL mode
- `data/wallet/`, the encrypted Solana key
- `data/browser-profile-dawn/`, the Telegram session used for the optional wallet lookups
- `data/server.log`, `data/watchdog.log`, and `data/worker.lock`
- `data/setup-token.txt`, the one-time token on a fresh install
- `.env`, your configuration and keys, entered locally and never committed
- `logs/`, the deployed PowerShell service's pid and log files
- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md), the short operator guide; [docs/RUNBOOK.md](docs/RUNBOOK.md), the runbook; [docs/FOMO_DAWN_FETCHING.md](docs/FOMO_DAWN_FETCHING.md), the manual fallback procedure
- `docs/diagrams/` and `docs/images/`, the editable diagram sources and their renders

Run the checks with `pnpm typecheck`, `pnpm test`, and `pnpm e2e`. `pnpm format` and `pnpm format:check` cover formatting. `pnpm demo` replays a fictional 28-second session without touching real data.
