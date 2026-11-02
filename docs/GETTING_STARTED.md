# Getting started — the short version

You have a working install. This page is the "what do I do now" guide.

## 1. Get in

1. On the PC: open **http://127.0.0.1:8787**
2. Log in with the username and password you created during setup.
3. On your phone (same Wi-Fi as the PC): run `enable-phone-access.bat` on the PC
   and open the address it prints, then add it to your home screen so it opens
   like an app:
   - **Android/Chrome:** ⋮ menu → _Add to Home screen_
   - **iPhone/Safari:** Share → _Add to Home Screen_

If the page will not load: the phone is on a different Wi-Fi, or the PC is
asleep/shut down. The PC must stay on, it _is_ the bot.

## 2. What the four tabs do

| Tab          | What it is for                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **TRADE**    | The dashboard: equity, the pipeline spine, the roster chairs, open positions, the watch rail.                  |
| **OPS**      | Everything that normally needs a terminal: build, migrations, tests, backup, restart, shutdown, create wallet. |
| **SETTINGS** | Provider keys, risk limits, pause / emergency stop, close-all, live readiness, live arming, manual import.     |
| **AUDIT**    | Every decision it made: admissions, shadow trades, promotions, rejections, fills, firings, risk blocks.        |

## 3. Why the roster is empty at first

That is correct and safe. A chair is only filled from the promotion queue, and
a wallet only reaches that queue by proving itself on the shadow ledger: at
least 8 closed shadow trades, more than $3 net, a funded buy inside the last 4
hours, a free chair and spare capital in the pool.

So the first hours are observation, not trading. The dashboard shows the stages
live: Discovery → Pool → Watch → Roster → Exits. Discovery fills the pool, the
watch list admits wallets that show funded buys, the shadow ledger follows them
in pretend positions, and only a proven wallet gets a chair.

## 4. Path A — just watch it work (demo, 2 minutes)

Demo mode is a fictional 28-second replay. It is clearly labelled
**FICTIONAL DEMO · NOT A PERFORMANCE CLAIM** and writes nothing to the real
database.

Ask your agent to switch the app to demo, or do it yourself:

1. Open `<project folder>\.env` in Notepad, change `MODE=paper` to `MODE=demo`, save.
2. OPS → **Restart server**.
3. TRADE tab → watch the replay, or press **↻ REPLAY 28s**.

Switch back the same way (`MODE=paper`) when you want real data.

## 5. Path B — paper trading with real market data

Paper mode follows real traders with **simulated** fills. It never signs
anything. You need, in this order:

1. **A free Helius key** — register at https://dashboard.helius.dev, copy the
   key, then open the app → **SETTINGS → PROVIDER KEYS** → paste into the
   Helius field → **Save keys**. Applied immediately, no restart needed.
   The field is write-only: stored keys are never displayed again, so keep
   your own copy. (Equivalent manual route: edit `.env` on the PC and set
   `HELIUS_API_KEY=your-key-here`, then restart.)
   _Enter keys in the app or on the PC only, never paste them into chat._
2. **A fomoapi key** — the discovery inlet. Same panel, the fomoapi field.
   It runs on the free tier; without it there is no discovery and the watch
   list stays empty.
3. **Wait for the watch list** — the watch tick runs every 5 minutes and admits
   wallets that bought with real money at least 3 times in 24 hours. Discovery
   runs on demand when the bench is thin, at most once every 30 minutes.

Everything the bot decides appears in **AUDIT**. If nothing is being copied, the
reason is there (usually a risk-limit rejection, a stale price, or an event that
is too old to copy).

## 6. Path C — going live (only when you are ready)

Live mode signs real Solana transactions with real money. Do not rush this.

1. Create the wallet: **OPS → Wallet setup** → choose an encryption secret
   (16+ chars). The secret is used for that request only, write it down
   somewhere safe; without it the wallet cannot be recovered.
2. Fund that wallet with a **small operating balance** only: USDC for the buys,
   a little SOL for fees and rent.
3. In `.env`: `MODE=live`, a Jupiter production key
   (`JUPITER_BASE_URL=https://api.jup.ag` + `JUPITER_API_KEY=...`), and
   `LIVE_TRADING_ACK=<the exact string SETTINGS shows you>`.
4. Restart, then SETTINGS → **LIVE READINESS** — every line must be green.
5. Arm live from SETTINGS. The badge only shows **LIVE** when armed _and_
   healthy.

Emergency stop (SETTINGS) instantly blocks new entries and new signing. It
cannot recall a transaction already sent.

## 7. Daily housekeeping

- **Backup:** OPS → _Back up data now_ (also copies the encrypted wallet file).
- **Stop the bot:** OPS → _Shut server down_. Start again with the Desktop
  shortcut.
- **After editing `.env`:** always OPS → _Restart server_.
- **Phone stops working after a reboot:** the PC's IP may have changed, run
  `enable-phone-access.bat` again for the current address.

## 8. Safety rules worth remembering

- The PC must stay awake; the bot runs there, not on your phone.
- This Wi-Fi is treated as "Public" by Windows: anyone on it can reach the
  login page. Use a strong password. Never forward port 8787 to the internet;
  use a VPN (e.g. Tailscale) if you need access from outside.
- Demo and paper results are never real returns. Nothing here predicts profit.
