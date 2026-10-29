# ZCode Bot

**Copy one Solana trader. A quarter of their size. Fire them after two losing closes.**

## What this is

ZCode Bot runs on your own Windows PC. You import a trader from a leaderboard, or add one by hand. The bot watches that person's Solana wallet, repeats their buys in your wallet at a quarter of the size they put in, and mirrors their sells. Two losing closes in a row end the relationship: the bot stops copying, closes what it opened, and hires the next name from a shortlist ZCode researched beforehand. If no acceptable name is left, it pauses and says why.

What you end up with:

- a dashboard built for a phone, showing equity, the trader being copied, open positions, the closes chart, and every decision the bot made
- a paper track record before any real money: real market data, simulated fills, nothing signed
- automatic replacement, with the firing and the next hire visible on the dashboard
- a deliberate pause when the shortlist is empty, stale, or exhausted, with the next action named on screen
- an audit trail of imports, recommendations and their rejection codes, risk blocks, fills, firings, handoffs, and reconciliation cases
- a 28-second fictional demo you can watch before connecting anything
- a dedicated Solana wallet, encrypted on your disk, that the research side never sees

None of this predicts a profit. Demo results are invented, paper results are simulated, and the tests never exercise live signing.

## Getting started

**The double-click path.** Double-click `install.bat` in the repository folder. It installs a portable Node LTS if you do not have one (no admin rights), sets up pnpm, installs dependencies, builds every package, and creates `.env` from the example with a freshly generated session secret. Then it creates the SQLite database, offers to load example candidates, adds a Start Menu and Desktop shortcut, and asks whether to start the app. An existing `.env` is never overwritten.

After that, use the **ZCode Bot** shortcut or `launch.bat`. It starts the server in a minimized window and waits for the port. Open **http://127.0.0.1:8787** yourself; the launcher does not open a browser.

The first run prints a one-time setup token in the server window. Open the dashboard, create your user (password at least 10 characters), and the token is consumed. Login, settings, arming, pause, close-all, and the ops console all require the authenticated session.

**The terminal path.** The same setup, by hand:

```powershell
# put the repository in a folder named zcode-bot, then:
cd zcode-bot
pnpm install
copy .env.example .env     # set SESSION_SECRET to 32 or more random characters
pnpm build
pnpm db:migrate
pnpm start
```

You need Node.js 22 or newer and pnpm. `install.bat` installs both.

**Your phone.** Run `enable-phone-access.bat` and approve the one administrator prompt. It adds a firewall rule for the port, sets `HOST=0.0.0.0` in `.env`, restarts the app, and prints an address such as `http://192.168.10.131:8787`. The connection is plain HTTP on your own network, so do not forward the port to the internet. On iOS or Android, use the browser's "Add to Home Screen" option so it opens like an app.

When it works you land on the TRADE tab with a flat equity line and a **WAITING FOR CANDIDATE** state. That is the intended default. With no candidates and no keys, the bot has nothing it is willing to copy, and it says so.

## The four tabs

**TRADE.** The dashboard. Equity and its change, the active trader card (COPY 0.25x, FIRE AT 2 L, the last six closes as wins, losses, and breakevens), open positions valued at live marks, the closes chart, the WHO WE COPY strip with each candidate's contribution and whether they are active, fired, or idle, and a health row for Helius and Jupiter. In demo mode the same page replays the fictional timeline, with a **REPLAY 28s** button.

**SETTINGS.** Manual leaderboard import (JSON or CSV), provider keys, editable risk limits, pause new entries, emergency stop, close all positions (type `CLOSE-ALL`), the live readiness report, live arming, and a JSON fallback for importing a recommendation. Provider keys entered here are write-only: a stored key is never displayed again, so keep your own copy.

**AUDIT.** Every decision in order: imports, recommendations with their validation result, risk rejections with the rule name, fills, firings, handoffs, reconciliation cases, and control events.

**OPS.** The jobs that normally need a terminal: install dependencies, build, migrate, seed, format, run the unit tests, run the browser tests, typecheck, restart, shut down, open the data folder, replay the demo, back up the data folder, reset the database (type `RESET`; it deletes the database and rebuilds it), create the wallet, send funds out, and refresh candidate activity. Commands are a fixed server-side whitelist, they run one at a time, and every run is audited. The browser can pick an operation by id; it cannot compose a command.

## The loop at a glance

![The ZCode Bot loop: you import the weekly board, candidates gain Solana wallets, ZCode researches a shortlist, the bot hires a trader and watches their wallet, copies buys at 0.25x, mirrors exits, fires the trader after two losing closes, then hires the next candidate or pauses until a fresh shortlist arrives](docs/images/copy-loop-overview.png)

_One hire at a time: the middle of the loop repeats for every leader swap, and the only exits are the next hire or a deliberate pause._

## Watch it run first: the 28-second demo

The demo needs no keys and no candidates. Set `MODE=demo` in `.env` and restart from OPS, or run `pnpm demo` in a terminal. The TRADE tab replays a fictional timeline over 28 seconds:

- equity runs from $52.00 to $4,939.00
- 48 copied closes, 36 of them winners
- two firings, at 6.1 seconds (`ape_vasco` to `moonpie_max`) and 16.2 seconds (`moonpie_max` to `lunadegen`)

Every number in that list is invented fixture data. The banner **FICTIONAL DEMO · NOT A PERFORMANCE CLAIM** stays on screen throughout. The replay is in memory: it never reads your balances and never writes to the trading tables.

Switch back with `MODE=paper` when you want real data.

## Paper trading with real data

Paper is the default mode. The bot follows real trader activity from Helius and real prices from Jupiter, then simulates the fills. It never signs or submits a transaction, and every result is labeled `PAPER`.

To get to a first copied trade:

1. Add a Helius API key. Get one from https://dashboard.helius.dev, then paste it into SETTINGS under provider keys and save. It applies immediately, with no restart. Keys are entered on your own machine only.
2. Import at least one candidate with a Solana address. The next section covers both routes.
3. Activate one candidate from SETTINGS. The monitor sets its starting point at activation, so activity from before that moment is never copied.
4. Optionally set up the ZCode research task so firings replace themselves. Without it, a fired trader leaves the bot paused until you pick the next one by hand.

The address is the part that matters. The bot watches the Solana chain directly; the leaderboard is only where names and addresses come from. You can follow any wallet you have an address for.

Paper fills use documented assumptions. A fill is simulated at the Jupiter quote when a quote is available; otherwise it uses the cached price with 30 bps of adverse slippage and 5 bps of fees. Those assumptions appear with the fills.

## Getting candidates in

There are two routes, and neither one lets the bot browse the leaderboard site.

**Manual import.** SETTINGS accepts JSON or CSV in the shape of `fixtures/leaderboard.example.json`: handle, weekly rank, displayed PnL, profile and avatar URLs, one or more Solana addresses, an enabled flag, and an observation time. Every row is validated, duplicates are reported, and the import is audited.

**The assisted route.** You read the leaderboard in your own desktop Chrome, with a human at the keyboard, and copy identifiers through the clipboard rather than reading them from screenshots. Two PowerShell helpers in `tools/gui` capture the visible rows and the profile stats line, and the server CLI imports the result:

```powershell
cd zcode-bot\apps\server
pnpm exec tsx src/cli/fomo-import.ts C:\temp\fomo-entries.json
```

Wallet addresses come from a separate lookup against Dawn (the Telegram bot) using its own logged-in browser profile:

```powershell
pnpm exec tsx src/cli/dawn-lookup.ts --all-missing --limit 20
```

The full procedure, including pacing, clipboard verification, and the rules for a failed lookup, is `docs/FOMO_DAWN_FETCHING.md`. It is the canonical version; follow it rather than improvising. A profile slug that fails validation is skipped with a warning and never guessed, because a wrong slug resolves to a different trader's wallet.

Before a trader is hired, two activity checks apply. The wallet must show at least 5 swaps in the last 24 hours, and a hired trader who goes 20 hours without a swap is fired.

## What ZCode does

ZCode is the researcher, never the runtime. It ranks replacement candidates from a sanitized snapshot; the worker makes every trading decision.

The worker writes a snapshot of the candidate pool to `data/research/snapshot/` after boot, after each import, and every 30 minutes. ZCode reads it through a restricted local MCP server that exposes exactly three tools:

- `get_research_snapshot`
- `get_replacement_context`
- `submit_candidate_recommendation`

The submission is one ordered shortlist, tied to the snapshot's id and hash, valid for 3 hours. The worker validates it before storing it, and rejects stale, replayed, malformed, or mismatched submissions with an explicit code (`EXPIRED`, `REPLAYED_RECOMMENDATION_ID`, `SNAPSHOT_MISMATCH`, and others). ZCode can also abstain, which offers no replacement at all.

The MCP process gets only the two research directories, plus optionally a local submit URL and token. It has no `.env`, no wallet, no database, and no order, config, or pause tools by construction.

An hourly task is the design cadence, with **Run now** for an on-demand refresh after a firing. Setup, the exact task prompt, the permission guidance, and the manual JSON fallback are in `docs/ZCODE_AUTOMATION.md`.

## Going live

Live mode signs real Solana transactions with real money. It is off by default and cannot turn on by accident.

1. Create the wallet: OPS, wallet setup, choose an encryption secret of 16 or more characters. The secret is used for that request only. Write it down somewhere safe; without it the wallet cannot be recovered.
2. Fund that wallet with a limited operating balance, never your main holdings.
3. In `.env`, set `MODE=live`, add a Jupiter production key (`JUPITER_BASE_URL=https://api.jup.ag` plus `JUPITER_API_KEY`), and set the exact acknowledgment:

   ```
   LIVE_TRADING_ACK=I UNDERSTAND LIVE MODE SIGNS AND SUBMITS REAL SOLANA TRANSACTIONS WITH REAL FUNDS
   ```

4. Restart, then open SETTINGS, live readiness. Every line must be green.
5. Arm live from SETTINGS: type the acknowledgment again and enter the wallet secret, which is used in memory only.

The badge shows **LIVE** only when the bot is armed and healthy, never merely because keys exist. Disarm at any time, or press **EMERGENCY STOP**, which blocks new entries and any signing that does not reduce risk. It cannot recall a transaction already submitted on chain, and the UI says so.

## How it works inside

The moving parts are a polling monitor, a copy engine, an executor, and a ledger. One copied trade looks like this:

![A sequence diagram of one copied trade: a buy lands in the leader wallet, the worker polls Helius for the transaction, classifies and dedupes it, sizes at 0.25x with caps, applies risk gates, asks Jupiter for a quote, simulates the fill in paper mode or signs it in live mode, then mirrors the leader's sell and records the close](docs/images/one-copied-trade.png)

_Time runs downward. The two lanes that matter are the worker, which makes every decision, and Helius, which is how leader activity reaches it._

The monitor polls the leader wallet with Helius `getTransactionsForAddress`, keeps a persisted cursor, and deduplicates by chain, leader, signature, and leg. Events older than 90 seconds are rejected rather than copied late, so a restart resumes forward instead of replaying history.

Each qualifying buy is classified, sized at 0.25x the leader's measured input notional, and capped by the configured limits: a minimum and maximum per buy, a maximum deployed percentage, and a daily realized loss limit. Price age, slippage, and price impact have their own ceilings. Two time rules keep a hire from sitting still: a position older than 16 hours is sold when it shows a positive mark, and one still open after a 3 hour grace window is force-closed regardless; a hire with no open positions for 12 hours is fired. A rejection is recorded with the rule name, which is what you see in AUDIT.

Execution is a single boundary. The paper executor simulates and never signs. The live executor exists only behind arming and readiness, and the test suite never constructs it. A close mirrors the leader's sold fraction, and a fully closed position contributes to the loss streak.

Firing is atomic and ordered:

![A state diagram of the firing handoff: watching the trader, firing after two losing closes, cancelling unsigned intents, closing positions per policy and cooling the trader down for 24 hours, then either hiring the next eligible candidate or pausing until a fresh shortlist or manual pick](docs/images/firing-handoff.png)

_The only way back from a firing is a candidate the worker accepts, or a fresh shortlist that gives it one._

When the second consecutive losing unit closes, the worker marks the trader `FIRING`, cancels unsigned intents, applies the position policy (the default closes all copied positions before switching), records a 24 hour cooldown for the fired trader, and then walks the shortlist in the order ZCode gave. Fired, cooling down, disabled, stale, unsupported, or ambiguous candidates are skipped with recorded reasons. When nothing qualifies, the app state becomes **PAUSED_WAITING_FOR_ZCODE**. New entries stop; monitoring, mirrored exits, reconciliation, and the emergency controls keep working.

Unknown execution outcomes never get retried blind. An order whose signed or submitted result is unknown becomes `REQUIRES_RECONCILIATION`, and the state machine has no path back to a quotable state. You resolve the case with on-chain evidence; the procedure is in `docs/RUNBOOK.md`.

Three modes, one process:

- **demo**: the fictional replay only, in memory, labeled everywhere.
- **paper** (the default): real public data, simulated fills, no signing.
- **live**: real data and real signing, only after readiness and explicit arming.

Money is stored as integer micro-USD, never as floating point. One worker holds an exclusive lock, so a second instance refuses to start instead of double-executing orders. Provider failures surface as health state in the dashboard rather than as silent fallbacks.

## Honest limitations

- **No profitability claim.** The demo numbers are invented, paper fills are simulated, and the tests never exercise live signing. Nothing here has been shown to make money.
- **One trader at a time.** The bot copies a single active trader and replaces them after a firing. It does not spread capital across several.
- **Live mode is unproven by the test suite.** Every automated test and demo path uses paper or demo execution. Live is reachable only by manual arming, and you carry that risk yourself.
- **Your PC is the bot.** If the machine sleeps, loses network, or shuts down, monitoring stops. A phone client is a remote view, not a remote runtime.
- **Displayed leaderboard PnL is unverified.** The snapshot ranks on evidence quality, activity, and data completeness; the displayed weekly PnL is treated as a claim, not a result.
- **The leaderboard is read by you, not the bot.** The bot never opens fomo.family, and there is no supported automated path to that site. You read the leaderboard in your own desktop Chrome, and a slug that cannot be verified is skipped.
- **Dawn lookups are slow and can fail.** They are paced at roughly 20 seconds plus jitter, depend on a live Telegram web session, and stop when that session dies.
- **Provider budgets are finite.** Helius credits and the Jupiter free tier are metered. The runbook estimates the Helius free plan lasts about 36 days at its current 36-second poll, and Jupiter's free keyed plan allows about 1 request per second and 60 per minute in one shared bucket.
- **Paper fills are assumptions, not fills.** A quote-based simulation and a cached price with 30 bps slippage and 5 bps fees are both approximations, and neither is a real execution.
- **Reconciliation needs you.** Unknown outcomes stay open until you resolve them with on-chain evidence, and positions held in that state are kept out of equity.
- **Emergency stop is not a recall.** It blocks new entries and non-risk-reducing signing. It cannot undo a transaction already on chain.
- **The dashboard is local and plain HTTP.** It is meant for your own machine or your own Wi-Fi. Never expose port 8787 to the internet without HTTPS and a reverse proxy.

## Technical appendix

A pnpm workspace on Node 22 or newer, TypeScript throughout. The server is Hono with a REST and SSE API; the dashboard is React, Vite, and Tailwind; storage is SQLite through Drizzle with WAL journaling; the chain side is `@solana/web3.js`, Helius for leader activity, and Jupiter Swap API v1 for quotes and swaps. The research bridge is the official MCP SDK over stdio, restricted to three tools. Tests are Vitest, plus Playwright for the browser suite.

```text
zcode-bot/
  apps/
    server/        Hono API and SSE, worker, ops console, CLIs
    web/           React dashboard, Playwright end-to-end tests
    zcode-mcp/     restricted MCP server, exactly three tools
  packages/
    config/        environment and risk validation, repo-root path resolution
    core/          money, sizing, exits, loss streaks, state machines
    db/            Drizzle schema, migrations, repositories
    providers/     leaderboard import, Dawn, Helius, Jupiter, prices, notifications
  docs/            runbook, automation contract, fetching procedure
  fixtures/        example import and the fictional demo timeline
  tools/gui/       clipboard-driven PowerShell readers
```

The decisions worth knowing before changing anything:

- **The worker is the only authority.** ZCode researches; it never monitors, sizes, exits, signs, or reconciles.
- **Money is integer micro-USD.** Token amounts are base-unit strings with decimals. No authoritative value is a JavaScript float.
- **Order transitions are guarded.** Signed and submitted orders cannot return to a quotable state; unknown outcomes are reconciled, not retried.
- **The ops console is a whitelist.** Operations are server-side constants, serialized by one mutex, behind authentication and CSRF, and audited.
- **The MCP process is least privilege.** Two directories and three tools, nothing else in its environment.
- **Demo cannot leak.** The replay is in memory and writes no trading rows.
- **Every number is traceable.** Dashboard values carry a source and a freshness label.
- **Fail closed.** Stale recommendations, ambiguous swaps, unsupported chains, and exhausted shortlists all end in a skip or a pause, never a guess.

### Running it as a container

One image serves the dashboard and runs the API and worker together:

```powershell
docker build -t zcode-bot .
docker run -d --name zcode-bot `
  -p 8787:8787 `
  -v zcode-bot-data:/data `
  -e SESSION_SECRET=<32 or more random characters> `
  -e MODE=paper `
  -e HELIUS_API_KEY=<your key> `
  zcode-bot
```

`/data` is the persistent volume for the database, wallet, and research directories. The image listens on 8787 and sets `DATA_DIR=/data`. For live mode, add the acknowledgment string and the Jupiter production settings, and mount the encrypted wallet file inside `/data`.

## Where things live

Local state, all under the data directory (`./data` by default):

- `data/zcode-bot.db`, with `-wal` and `-shm` files while the server runs
- `data/wallet/zcode-bot-wallet.json`, the encrypted wallet; useless without its secret
- `data/research/snapshot/`, `data/research/inbox/`, `data/research/processed/`, and `data/research/submit-token`
- `data/browser-profile-dawn/`, the Telegram profile used for wallet lookups
- `data/setup-token.txt` and `data/worker.lock`

Configuration is `.env` in the repository root. It is gitignored and holds your keys and the session secret.

Validation and development commands:

```powershell
pnpm format:check && pnpm typecheck && pnpm test && pnpm build
pnpm e2e
pnpm dev:server
pnpm dev:web
```

Documentation:

- `docs/GETTING_STARTED.md`: the short operator guide.
- `docs/RUNBOOK.md`: startup, pause and resume, emergencies, restart recovery, reconciliation, arming, backups, and troubleshooting.
- `docs/ZCODE_AUTOMATION.md`: the MCP server, the scheduled research task, and the verification steps.
- `docs/FOMO_DAWN_FETCHING.md`: the canonical leaderboard and wallet fetching procedure.
- `docs/diagrams/`: the Mermaid sources behind the three images above; edit those and re-render the PNGs in `docs/images/`.
