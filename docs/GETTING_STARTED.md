# Getting started — the short version

You have a working install. This page is the "what do I do now" guide.

## 1. Get in

1. On your phone (same Wi-Fi as the PC): open **http://192.168.10.131:8787**
2. Log in with the username and password you created during setup.
3. Add it to your home screen so it opens like an app:
   - **Android/Chrome:** ⋮ menu → _Add to Home screen_
   - **iPhone/Safari:** Share → _Add to Home Screen_

If the page will not load: the phone is on a different Wi-Fi, or the PC is
asleep/shut down. The PC must stay on — it _is_ the bot.

## 2. What the four tabs do

| Tab          | What it is for                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **TRADE**    | The dashboard: equity, who is being copied right now, open position, trade history, candidate ring.            |
| **OPS**      | Everything that normally needs a terminal: build, migrations, tests, backup, restart, shutdown, create wallet. |
| **SETTINGS** | Import FOMO candidates, risk limits, pause / emergency stop, close-all, readiness report, live arming.         |
| **AUDIT**    | Every decision it made: recommendations, rejections, fills, firings, risk blocks.                              |

## 3. Why it says "WAITING FOR A CANDIDATE"

That is correct and safe. The bot will not trade a random wallet. To start it
needs two things:

1. a **candidate** — a FOMO trader with a Solana address, and
2. a **fresh recommendation** (from ZCode) or a manual activation.

With no candidates imported and no API keys, it sits idle. That is the
intended default, not a fault.

## 4. Path A — just watch it work (demo, 2 minutes)

Demo mode is a fictional 28-second replay ($52 → $4,939, two fired-trader
handoffs). It is clearly labelled **FICTIONAL DEMO · NOT A PERFORMANCE CLAIM**
and writes nothing to the real database.

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
   _Enter keys in the app or on the PC only — never paste them into chat._
2. **Candidates** — SETTINGS → _Manual FOMO leaderboard import_. Paste JSON or
   CSV in the shape of `fixtures/leaderboard.example.json`. Each candidate
   needs a Solana address, otherwise it stays ineligible.
   The address is what matters — it can be **any** trader's Solana wallet you
   want to follow (the Fomo app, a profile on X, a friend's wallet). FOMO is
   optional flavour; the bot watches the Solana chain directly, not any
   trading platform's website.
3. **Activate one** — SETTINGS → choose a candidate → activate. From then on
   the bot mirrors that trader's swaps at 0.25× with simulated fills.
4. **Recommendations (optional but recommended)** — set up ZCode's hourly
   research task so replacements happen automatically after a firing:
   see `docs/ZCODE_AUTOMATION.md`. Until then, if a trader is fired you must
   pick the next one yourself.

Everything the bot decides appears in **AUDIT**. If nothing is being copied,
the reason is there (usually a risk-limit rejection or a stale price/event).

## 6. Path C — going live (only when you are ready)

Live mode signs real Solana transactions with real money. Do not rush this.

1. Create the wallet: **OPS → Wallet setup** → choose an encryption secret
   (16+ chars). The secret is used for that request only — write it down
   somewhere safe; without it the wallet cannot be recovered.
2. Fund that wallet with a **small operating balance** only.
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
- **Phone stops working after a reboot:** the PC's IP may have changed — ask
  your agent, or check the URL printed by `enable-phone-access.bat`.

## 8. Safety rules worth remembering

- The PC must stay awake; the bot runs there, not on your phone.
- This Wi-Fi is treated as "Public" by Windows: anyone on it can reach the
  login page. Use a strong password. Never forward port 8787 to the internet;
  use a VPN (e.g. Tailscale) if you need access from outside.
- Demo and paper results are never real returns. Nothing here predicts profit.
