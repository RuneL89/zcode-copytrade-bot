# Copydesk

**A copy desk that only trades what it has already proven.** It finds the traders, tests them in a shadow ledger, and then copies their buys onto your own wallet.

## Introduction

Copydesk is a self-hosted Solana copy-trading application for one operator. It pulls traders off the fomoapi leaderboard, watches the ones that actually spend money, replays their buys in a pretend ledger, and promotes a wallet onto a real roster seat only once that wallet has earned it. From then on it copies the buys at a quarter of the leader's own size and mirrors the sells.

Everything runs on your machine, against your own keys, with your own money. Paper mode is the default, and signing real transactions takes a separate arming step that you type yourself.

What you end up with:

- a roster of up to five leaders, each one proven on the shadow ledger first, all sharing one budget pool
- buys copied at a quarter of the leader's measured input, with a hard floor and a ceiling per buy, both editable in Settings
- sells mirrored from the leader, plus a time exit for anything still open when the leader goes quiet
- a dashboard that draws the whole pipeline: discovery, pool, watch list, roster, exits, and the lane where fired chairs go
- an audit trail where every admission, shadow trade, promotion, rejection, fill and firing is written down with its reason
- a deterministic discovery loop that spends API credits only when the roster actually needs new blood

The rest of this page shows how that works, twice: first at a glance, then in detail. If you just want to run it, skip to [Getting started](#getting-started).

## Running paper mode

Paper is the default. It watches public market data and simulates fills. It does not sign, and it does not need a wallet.

```bash
pnpm install
cp .env.example .env
# Set SESSION_SECRET to 32+ random characters. Leave every API key empty
# to boot. Add HELIUS_API_KEY, JUPITER_API_KEY and FOMOAPI_KEY locally
# when you want live leaderboard and chain reads. Never commit .env.
pnpm build
pnpm db:migrate
pnpm dev:server    # http://127.0.0.1:8787  (or pnpm start after a build)
```

The first login uses the one-time setup token printed by the server (also in `data/setup-token.txt`).

Paper defaults, all overridable in `.env` or Risk settings:

| Limit                          | Default                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| Bankroll                       | $100 (`EQUITY_START_USD`)                                      |
| Per copied buy                 | $2 floor, $10 ceiling                                          |
| Open exposure per hired trader | $40                                                            |
| Deployed cap                   | 80% of bankroll, so $80 total even though 5 × $40 is $200      |
| Daily realized loss stop       | $15                                                            |
| Max hold                       | 5h, then 1.5h grace that sells on green                        |
| Stop-loss / trail              | −25% from entry; trail arms at +15% and sells 10% off the peak |
| Exit slippage ladder           | 300, then 600, then 1,000 bps                                  |

Helius spend is metered. A designed day is about 5,800 credits against a 13,600 hard cap. The roster poll is signature-first. `getTransactionsForAddress` is not on a timer. Leave `HELIUS_API_KEY` empty until that budget is the one you intend to run.

`HIRE_APPROVAL=auto` fills an empty seat from the bench. `agent` waits for `POST /api/agent/hire-decisions` (Bearer `AGENT_API_TOKEN`). Exit plans can only be tightened via `POST /api/agent/exit-adjustments`. A seat left empty POSTs to `AGENT_WEBHOOK_URL` when that is set. Telegram is not used.

## Running as a service

On a Linux box, build once and let systemd keep the process up. The unit is `deploy/copydesk.service`.

```bash
sudo mkdir -p /opt/copydesk
sudo rsync -a --exclude data --exclude node_modules ./ /opt/copydesk/
cd /opt/copydesk
pnpm install --frozen-lockfile
pnpm build
# Write /opt/copydesk/.env locally. chmod 600. Do not commit it.
pnpm db:migrate
sudo cp deploy/copydesk.service /etc/systemd/system/copydesk.service
sudo systemctl daemon-reload
sudo systemctl enable --now copydesk
sudo journalctl -u copydesk -f
```

The process runs `node apps/server/dist/index.js` with the repo as its working directory. It restarts on failure. One process holds `data/worker.lock`.

`LIVE_TRADING` defaults to false. `MODE=live` together with `LIVE_TRADING=true` re-runs the budget, 429, and exit-guard checks and exits instead of listening if any fail. The wallet file is `WALLET_FILE`, unlocked with `COPYDESK_WALLET_PASSPHRASE`. Raising a risk limit from the Desk risk tab needs `RISK_PIN`.

The Desk screen is `#/desk`: funnel counts, five seats with per-trader open copies, the credit meter, and the risk form. SOL balance is the headline figure.

## Still open

- WebSocket bytes are metered. They have not been measured against a day of live traffic.
- Sender uses the 0.000005 SOL SWQOS tip. The 0.001 SOL Sender Max tip is not the default.
- Shadow lots still use 1% slippage when Jupiter does not return a quote.
- Odds-of-profit, calibration, and the 4-hour review loop are not built. Hire, timeout, overrule, and tighten-only exits are.
- `HIRE_APPROVAL` stays `auto` unless you set `agent`.

## Getting started

**The double-click path.** Run `install.bat` from the project folder. It installs a portable Node if you do not have one, sets up pnpm, installs the dependencies, builds every package, creates `.env` from the example with a generated session secret, creates the SQLite database, offers to load example candidates, and adds Start Menu and Desktop shortcuts. An existing `.env` is never overwritten. At the end it asks whether to start the app.

`launch.bat` starts the server if it is not already running, and does nothing else, so open [http://127.0.0.1:8787](http://127.0.0.1:8787) yourself.

On the first login the app asks for a one-time setup token. The server prints it at startup and writes it to `data/setup-token.txt`; `pnpm user:token` reprints it. You choose the username and password at that point, and the password is hashed locally.

**The terminal path.**

```bash
pnpm install
cp .env.example .env        # then set SESSION_SECRET
pnpm build
pnpm db:migrate
pnpm db:seed                # optional: example candidates from fixtures/
pnpm start
```

Live trading needs a wallet as well: `pnpm wallet:create` generates and encrypts a dedicated Solana key on the machine. The newer operator guide, including how to watch it from a phone, is [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md).

When it works you land on the TRADE page with a PAPER or LIVE badge, the pipeline spine, the roster chairs, the watch list, and the audit trail behind them.

## The pipeline at a glance

![The Copydesk pipeline at a glance: discovery pulls traders from the fomoapi leaderboard into a pool, the watch list admits wallets that show funded buys, the shadow ledger opens a pretend position on every funded buy, a bench gate decides who has earned a place in the hire queue, five roster chairs share one budget pool, copies are placed at a quarter size, exits mirror the leader's sells, and a fired lane carries the cause back to the watch list](docs/images/pipeline-overview.png)

_The whole machine in one picture: five stages left to right, two dotted side paths for the ones who fail and the ones who come back._

Each stage is a place you can watch on the dashboard, and each one carries a number.

**Discovery.** The fomoapi leaderboard, read on demand: the 24 hour, 7 day and 30 day boards plus the alerts feed. Every row carries a stable identifier, the handle and a verified Solana wallet, so a renamed trader never becomes a second trader and one wallet under two handles collapses into one.

**Pool.** Every candidate the inlet has seen, with the wallet attached or not. Candidates wait here. Nobody is hired from this list directly.

**Watch list.** Twenty wallets under observation. A wallet earns a place by doing something specific: buying a coin with real money at least three times in the last 24 hours, with the most recent of those buys inside 24 hours. Sells are recorded as an observation, never as a way in.

**Shadow ledger.** For every funded buy a watched wallet makes, the ledger opens a pretend position at the size Copydesk would have used, and closes it the way the real book would: when the leader sells, or when the position reaches its age ceiling and is closed at the live price at that moment. None of this spends money. It is the evidence.

**Roster.** Five chairs, one shared budget pool. A wallet earns a place on the bench by clearing the bench gate: at least four closed shadow trades, more than five dollars net, a funded buy inside the last four hours and no re-entry ban since a firing; all of it tunable in Settings. The bench is a queue ordered by shadow net, so a freed chair takes the best record on it, and it pre-builds while every chair is full. A chair can sit empty, because the alternative is hiring something unproven.

**Exits.** When the leader sells, the same fraction is sold. Anything still open when the position reaches eight hours is closed on its own, with three extra hours of grace while the mark is negative. A chair is lost for one of four reasons, all of them observable: two losing closes in a row, a leader whose wallet goes quiet for eight hours while you hold, a leader whose last buy is older than twenty hours, or eight hours of idle with nothing open.

**Fired lane.** Every firing is written down with its cause and whether the chair was refilled. A trader who was just fired is not eligible again until a funded buy is observed _after_ the firing.

## How one copy happens

![A sequence diagram of one copied trade: the leader's buy lands on chain, the worker polls the wallet every 45 seconds, classifies and dedupes the event, sizes it at a quarter of the measured input with a floor and a ceiling, applies the risk gates, asks Jupiter for a quote, simulates the fill in paper mode or signs and submits it in live mode, shows the position, fill and equity on the dashboard, then mirrors the leader's sell and closes the position](docs/images/one-copied-trade.png)

_One leader event, from chain to dashboard. The bottom band is the mirrored exit and the age-ceiling exit._

Each hired leader's wallet is polled on the roster clock, every 45 seconds, because a real order follows that poll. Events older than 90 seconds are dropped, duplicates are discarded, and two buys of the same coin inside a minute are treated as one. Swaps the worker cannot classify are skipped rather than guessed at.

Sizing is a quarter of the leader's measured input, clamped to the per-buy floor and ceiling. The floor is a floor, not a filter: a buy that would scale below it is still placed at the floor rather than skipped, because a small position on Solana is still worth placing.

The risk gates run before any quote is requested. They cover the share of capital already deployed, the day's realized loss, the age of the price, slippage and price impact. In paper mode the fill is simulated from the Jupiter quote, or from a cached price with 30 basis points of adverse slippage and 5 basis points of fees when there is no quote. In live mode, and only while the wallet is armed, the order is signed and submitted. Either way the position, the fill and the equity change land on the dashboard.

## How a chair is lost and refilled

![A flowchart of a roster chair: four reasons the chair is lost (two losing closes in a row, a leader wallet quiet for eight hours, a last buy older than twenty hours, eight hours idle), a transactional close-out, then either the best shadow record is hired or the chair stays empty while discovery refills the bench](docs/images/chair-lifecycle.png)

_The same four ways to lose a chair, and the two ways a chair gets filled again._

Firing is transactional. The worker marks the chair as firing and cancels the unsigned orders in one database transaction, applies the position policy (the default closes everything), and only then looks for a replacement. The best shadow record on the bench is taken first. The trader who was just fired is never eligible again until a funded buy is observed after the firing, and there is no timed cooldown anywhere in the path.

If nothing on the bench qualifies, the chair stays empty. Discovery is asked for a fresh bench instead, and the dashboard says so. No trader is ever invented to fill a seat.

## Two clocks, and what discovery costs

There are exactly two monitoring clocks, and only two:

- **The watch list**, every five minutes, one signature poll per watched wallet.
- **The roster**, every 45 seconds, because a real order follows that poll.

Everything else that ticks is housekeeping: provider health, the fee ledger, symbol resolution, the reports. None of it discovers or hires.

Discovery does not run on a clock either. It runs when a chair is free with nothing promotable behind it, or when the bench sits below its target of ten wallets, and at most once every 30 minutes. A full roster with a full bench spends nothing external.

The cost lands on the free tier of the leaderboard API: 250 credits per board read and about 125 per alerts read, against 250,000 credits a month. Each run writes one audit line with the rows read, the traders added and the credits spent and left.

## Honest limitations

- **The roster starts empty.** A wallet has to earn a chair: eight closed shadow trades, more than three dollars net, a fresh funded buy. The first hours, sometimes a full day, are observation rather than trading. An empty chair is a normal state, never a reason to hire something unproven.
- **The funded-buy screen can thin the pool.** When no watched wallet clears the admission bar, the watch list stays empty and discovery simply tries again later. A quiet market means a quiet desk, and no amount of code changes that.
- **Displayed PnL is not banked profit.** The leaderboard's own profit figures are context. The gates that decide anything read our own on-chain scan and the shadow ledger, never a number someone else published.
- **A roster of five, one shared pool.** Capital is first come across the chairs; there is no per-leader slice, and every hire has to leave at least twenty dollars of headroom behind it.
- **Paper fills are assumptions.** A quote-based simulation, or a cached price with 30 basis points of slippage, is an approximation and never a real execution.
- **Live mode is not exercised by the tests.** Every automated test and the demo run on simulated fills. Signing is reachable only through the readiness checks, the documented confirmation string and a separate arming action.
- **Your PC is the runtime.** If the machine sleeps, loses network or shuts down, the monitoring stops. The dashboard on your phone is a remote view of the runtime, not a remote runtime.
- **Equity is trading capital, fees are not in it.** Trade PnL is proceeds minus cost basis in USDC, so the equity number tracks the USDC balance. Network fees and account rent are paid in SOL from a separate reserve, measured by the fee ledger.
- **Reconciliation needs you.** An execution whose outcome is unknown stays open until you resolve it with on-chain evidence, and those positions are kept out of equity.
- **Emergency stop is not a recall.** It blocks new entries and new signing at once. It cannot undo a transaction that is already on chain.
- **The dashboard is plain HTTP on your network.** Keep it on the machine or your own Wi-Fi. Do not expose port 8787 without HTTPS and a reverse proxy.
- **The wallet lookup fallback can log itself out.** The Telegram session used for the optional wallet lookups expires, and a dead session needs one QR scan from you.

## Technical appendix

Node 22 or newer, TypeScript throughout. The server is Hono with REST and SSE; the dashboard is React, Vite and Tailwind; storage is SQLite through Drizzle with WAL; the chain side is `@solana/web3.js`, Helius for leader activity, and Jupiter Swap API v1 for quotes and swaps. Discovery talks to the leaderboard API directly from the server process. No language model decides anything: admission, promotion, sizing, exits and firing are all deterministic code. Tests are Vitest, plus Playwright for the browser suite.

```
zcode-bot/
  apps/
    server/       Hono API, worker, monitor, executors, ops console, CLIs
    web/          React dashboard (TRADE, OPS, SETTINGS, AUDIT)
  packages/
    core/         money, sizing, exits, streaks, swap classification, watch rules
    db/           Drizzle schema, migrations, repositories
    providers/    leaderboard API, wallet lookups, Helius, Jupiter, pricing, notifications
    config/       Zod env and risk validation
  docs/           runbook, getting started, fetching procedure, diagrams
  fixtures/       example imports and the fictional demo timeline
  tools/gui/      clipboard-driven PowerShell readers for desktop Chrome
  install.bat launch.bat enable-phone-access.bat
```

Three decisions shape the code. The worker is the only authority: discovery nominates wallets, the bench gate decides who is ready, and nothing outside the engine sizes, signs or exits. Everything fails closed: ambiguous swaps are skipped, unknown outcomes become reconciliation cases, a stale answer or an unreadable transaction never invents a fill, and an empty chair is an acceptable outcome. And money is integer micro-USD held in bigints, with token amounts as base-unit strings, never floats.

The project keeps its original name in a few places that predate the rename: the package scope is `@zcode-bot/*`, the database file is `data/zcode-bot.db`, and the session cookie is `zcode_session`. Renaming those is a breaking change that touches a live database and your browser session, so it is not done as part of a documentation pass.

The binding decisions live in [DECISIONS.md](DECISIONS.md) (D1 to D6, with the evidence behind each one), the repository contract in [AGENTS.md](AGENTS.md), the build and verification plan in [IMPLEMENTATION_PLANS/](IMPLEMENTATION_PLANS/), and the operator runbook in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Where things live

- `data/zcode-bot.db`, the SQLite database in WAL mode
- `data/wallet/`, the encrypted Solana key
- `data/browser-profile-dawn/`, the Telegram session used for the optional wallet lookups
- `.env`, your configuration and your keys, entered locally and never committed
- `docs/diagrams/`, the editable diagram sources behind the three pictures above
- `docs/GETTING_STARTED.md`, the operator guide; `docs/RUNBOOK.md`, the runbook; `docs/FOMO_DAWN_FETCHING.md`, the manual fallback procedure

Run the checks with `pnpm typecheck`, `pnpm test` and `pnpm e2e`. `pnpm format` and `pnpm format:check` cover formatting. `pnpm demo` replays a fictional 28 second session without touching real data.
