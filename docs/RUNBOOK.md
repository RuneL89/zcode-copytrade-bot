# RUNBOOK — Copydesk operations

Everyday startup, pause, recovery, reconciliation, and emergency procedures.
Read §Security first. Nothing here ever requires pasting secrets into chat.

## 0. Modes and what they mean

| Mode              | Data                           | Fills               | Signing           | Label in UI                        |
| ----------------- | ------------------------------ | ------------------- | ----------------- | ---------------------------------- |
| `demo`            | fictional fixtures only        | simulated           | never             | DEMO + banner everywhere           |
| `paper` (default) | real public market/leader data | simulated (`PAPER`) | never             | PAPER                              |
| `live`            | real data                      | real swaps          | only after arming | LIVE (only when armed AND healthy) |

Demo and paper results are **never** real returns.

## 1. Startup

**No terminal:** double-click the "ZCode Bot" Desktop/Start-Menu shortcut
(created by `install.bat`), or `launch.bat` — it starts the server if needed
and opens the dashboard. Everything else (build, migrate, tests, backups,
restart, shutdown, wallet creation) lives in the dashboard's **OPS** tab.

**Self-healing (installed by `install-watchdog.bat`).** Two hooks keep the bot
up without anyone watching:

- a **Startup-folder shortcut** starts the server when you log on, so a laptop
  reboot brings it back on its own;
- a **scheduled task** ("Copydesk watchdog") runs `watchdog.bat` every
  5 minutes: it asks the dashboard's health endpoint and, when nothing answers
  (the process is gone), starts the server again. Transitions are logged in
  `data/watchdog.log`; the server's own output — including any crash — is in
  `data/server.log`.

Both run as this Windows user and **only while you are logged on**; no password
is stored. The watchdog deliberately does **not** restart a server that
listens but stops answering (a hung loop cannot be mid-swap, and killing it
blind could strand an in-flight trade as an unknown outcome) — that case is
logged for a human. Remove the hooks with
`schtasks /Delete /TN "Copydesk watchdog" /F` and by deleting
`Copydesk.lnk` from the Startup folder.

With a terminal:

```powershell
pnpm start          # serves dashboard + API + worker on http://127.0.0.1:8787
```

- First run: the console prints a **one-time setup token**. Open the
  dashboard, complete the setup wizard (username + password ≥ 10 chars), the
  token is consumed.
- The worker takes an **exclusive lock** (`data/worker.lock`). A second
  instance refuses to start. If you are sure no other instance runs and the
  lock is stale (PID not alive), delete `data/worker.lock`.
- SQLite runs in WAL mode with a persistent volume (`DATA_DIR`, default
  `./data`). Back that folder up (§8) — or use OPS → Maintenance →
  Back up data now.

### Phone / tablet access (same Wi-Fi)

The dashboard is mobile-first, but the server listens on loopback only by
default. To use it from your phone:

1. Double-click **`enable-phone-access.bat`** (repo root). It asks for one
   administrator approval (UAC), adds an inbound firewall rule for the port,
   sets `HOST=0.0.0.0` in `.env`, restarts the app, and prints the URL.
2. Open the printed address on the phone, e.g. `http://192.168.10.131:8787`.
   The phone and the PC must be on the same network.

Why the UAC step is unavoidable: creating a Windows Firewall rule requires
administrator rights, and the consent prompt can only be answered on the PC
itself. A non-elevated agent/shell cannot do it remotely.

Notes:

- Traffic is plain HTTP. Cookies are only marked `Secure` in production
  (`NODE_ENV=production`); for LAN HTTP either leave `NODE_ENV` unset or set
  `FORCE_INSECURE_COOKIE=1`.
- Anyone on that Wi-Fi can reach the login page, so use a strong dashboard
  password. **Never port-forward this port to the internet.**
- To reverse it: set `HOST=127.0.0.1`, delete the "ZCode Bot LAN 8787"
  firewall rule, restart.
- Away from home, use a VPN (e.g. Tailscale) rather than exposing the port.

Separate demo session:

```powershell
pnpm demo           # fictional 28-second replay; writes nothing to live tables
```

## 2. Daily operation

1. Start the server (`launch.bat`) and open http://127.0.0.1:8787. On boot the runtime catches up: discovery when the bench is thin, one watch pass, then the promotion queue fills the free chairs.
2. Watch **Audit** for the pipeline: `discovery run` (rows, traders, credits), `watch admitted`, `shadow opened/closed`, `benched: record passes`, `watch hired into the roster`.
3. Use **Ops → Sync discovery now** when you want a board read immediately (it spends ~750 credits per run; the demand trigger otherwise runs it only when needed).
4. Watch the dashboard: the ROSTER panel (chairs, streaks, per-seat FIRE), the WATCH LIST panel (status, last buy, closed/net, blocked reason) and the positions/closes panels grouped by leader.
5. Manual fallbacks, if the API is unavailable: `docs/FOMO_DAWN_FETCHING.md` (desktop-Chrome capture, Dawn) or Settings → MANUAL IMPORT. Every import is audited and no fallback is scheduled.

### Rotation and board-driven replacement are retired (D6)

The board is a discovery feed, never the hireable universe (D2/D3). There is no
automatic rotation, no rank-fire rule and no research-driven replacement: chairs
are filled from the promotion queue, and a fire frees exactly one chair. Any
A rotation request (if one is ever produced) is audited as ignored.

See **2b. Roster operations** below and `DECISIONS.md` D3/D4/D5/D6.

### (retired) Rank-fire rule

Removed with the board-driven pipeline (D2/D3/D6). A leader is fired for the
reasons in **2b**: losing close units, a silent wallet, a stale last buy, or an
idle chair.

### The fire → bench → hire path

A fire closes the chair's positions under `FIRE_POSITION_POLICY`, marks the
activation FIRED, moves the trader to `cooling` (he returns only after a funded
buy observed after the firing) and immediately calls `fillRoster()`, which takes
the best bench wallet (shadow net first). Every firing path (idle, stall, manual, loss
streak) performs that hand-off, so a fired leader is never left on the bench —
otherwise the very fill he triggered could re-hire him. The bench is empty →
the chair stays empty and the demand trigger asks discovery for a fresh bench. A
close-out that needs reconciliation freezes **only** that chair.

### (retired) Actively-trading tier

The board-tier hire priority is gone with the ordering pipeline (D2/D3). A
wallet's funded buys are what matter now, and they are judged by the D4
admission and bench gates.

### The hourly discipline sweep

Every seat gets its own hourly sweep (time exits first, then the stall watcher) —
the cap is per chair, so one busy seat can never starve another's deadline. A
position past `MAX_POSITION_AGE_HOURS` sells when it is in profit, otherwise it
rides `POSITION_GRACE_HOURS` and is sold regardless; the audit line reads
`time exit: <mint> held Nh (sell_positive|sell_expired) — closing`.

### Stall watcher (wired 2026-10-29)

The same sweep fires the hired leader when their wallet has shown no
on-chain activity for `LEADER_STALL_FIRE_HOURS` (default 8h, tunable in Settings)
**while we hold**, and only when the Helius activity stamp itself is fresh (≤6h —
staleness is never judged from stale evidence). The audit line reads
`stall watcher: leader wallet silent Nh — firing`; the normal position policy
closes any open positions and the replacement takes the slot. This is what makes
"traders are discarded after no activity" literally true; the pre-hire gate
(`MAX_LEADER_STALL_HOURS`, 20h) is a separate decision about who may be hired.
With the board-driven rank-fire rule retired (D6), the stall watcher is the
silence exit.

### Telegram reports

Two streams only (opt-in via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`):

- **Anomalies** — audit rows from the problem categories every 10 min, at most
  five per message.
- **One desk summary a day at local 09:00** — compact by design: PnL and its
  win/loss split, equity/cash/deployed, open positions with the next time exit,
  chairs and bench depth, anything needing attention, the last 24h of hires and
  firings, and the fee wallet. Mondays send the **weekly** instead (the same 24h
  block plus the 7-day totals and each chair's record), so a day never produces
  two messages.

The summary never invents a figure: unpriced positions read `unrealized pending`
and a balance the chain read could not supply is left out. A failed send is
recorded in the audit trail (`reports report send failed`) and the day is still
marked sent, so an outage cannot become a message storm.

**Commands (read-only).** With the same two env vars set, the bot also answers
four commands from the operator chat, using the same figures as the summary:

| Command      | Reply                                                 |
| ------------ | ----------------------------------------------------- |
| `/status`    | the 24h desk summary (identical to the 09:00 message) |
| `/weekly`    | the 7-day summary with each chair's record            |
| `/positions` | one line per open position, soonest time exit first   |
| `/help`      | the command list                                      |

Nothing typed in Telegram can change trading state — no pause, arm, fire or
close. Only `TELEGRAM_CHAT_ID` may command the bot; another chat is ignored and
recorded once in the audit trail. The bot polls Telegram (`getUpdates`) instead
of using a webhook, because the dashboard is LAN-only by policy. Clear
`TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` to turn both the messages and the
commands off.

### Wallet resolution (fallback only)

The fomoapi leaderboard rows carry verified wallets, so wallet resolution is no
longer part of the loop. Dawn remains a **manual** fallback for a handle outside
the boards (`pnpm exec tsx src/cli/dawn-lookup.ts --all-missing`, or the Ops
action), and the native board capture stays a manual fallback per
`docs/FOMO_DAWN_FETCHING.md`.

## 2b. Roster operations (D4/plan 05)

The roster holds up to `ROSTER_SIZE` leaders (default 5) **sharing one budget
pool** — there is no per-leader slice. The bench is ordered by shadow net: the
best record takes a freed chair.

- **Fire one leader.** Dashboard → Roster → **FIRE** (per seat, asks for the
  word FIRE) or `POST /api/fire {activationId}`. The OTHER seats keep trading;
  only the fired leader's positions close. With several leaders active a bare
  `POST /api/fire` is refused — name the chair.
- **The bench is a real queue.** Every wallet whose shadow record qualifies
  sits on it, ordered by shadow net (best first) — no chair is needed, so the
  bench pre-builds while the roster is full, like a basketball bench. A fire
  seats the best bench wallet immediately; only a hire checks for a free chair.
  No bench wallet → the chair stays **empty**; that is acceptable, and discovery
  refills the bench when it drops below `BENCH_TARGET`. A bench wallet whose
  record stops qualifying returns to the watch list (archived only when the full
  sample is negative). A hired leader's watch row reads `hired` (his shadow
  record keeps running) — he is in the roster, not on the bench.
- **Shared pool.** A hire is not gated on capital: a proved leader takes a
  free chair even when the pool is fully deployed, and starts copying as soon
  as room frees. Each entry is still capped by the deployed-% limit
  (`MAX_DEPLOYED_PCT`); a copy that no longer fits the per-buy minimum is
  skipped and appears on the tape as a `MAX_DEPLOYED_PCT: bankroll cap`.
- **Reconciliation isolation.** A seat stuck in `REQUIRES_RECONCILIATION`
  freezes only itself: it keeps its chair, the other seats keep being polled
  and can be fired. Resolve the case (section 6) to unfreeze it.
- **Entry shaping.** One position per mint per leader; same-mint buys inside
  60 s are coalesced into the existing position (`COALESCED_SAME_MINT_BURST`
  in **Audit**). `PER_MINT_CAP_PCT > 0` caps the roster-wide exposure to one
  mint at that percent of the deployment budget (`MAX_DEPLOYED_PCT`% of
  capital, D7; rule `PER_MINT_CAP`); `0` disables the cap.
- **Poll cadence.** Every hired wallet is polled every `ROSTER_POLL_MS`
  (default 45 s); the watch list keeps its own 5-minute clock.

## 3. Pause / resume

- **Pause new entries** (Settings → CONTROLS): no new copied entries; leader
  monitoring, mirrored exits, reconciliation, emergency stop, and close-all
  all continue.
- **Resume** re-enables entries.
- **PAUSED_NO_TRADER** (automatic): no leader holds a chair. An empty chair is a
  normal state (D4) — the bench fills the chair as soon as a wallet qualifies for
  it, and the demand trigger refills the bench in the meantime.
  Do not "fix" it by hand-activating an unproven wallet unless you deliberately
  want a manual override.

## 4. Emergency procedures

### Emergency stop

Settings → **EMERGENCY STOP**. Immediately:

- blocks all new entries,
- blocks all non-risk-reducing signing,
- keeps monitoring and reconciliation running.

It **cannot** recall transactions already submitted on-chain — the UI states
this. Clear it via **Clear emergency stop** when ready.

### Close all positions

Settings → **Close all positions** — separately confirmed (`CLOSE-ALL`).
Closes every open copied position (mirrored sells of our holdings only;
unrelated wallet assets are never touched).

## 5. Restart recovery

On boot the worker automatically:

1. acquires the single-worker lock,
2. applies pending SQLite migrations,
3. reviews open **reconciliation cases** (see §6),
4. resumes leader polling **forward from the saved cursor** — activity older
   than the cursor is never processed, and events older than
   `MAX_COPY_EVENT_AGE_SECONDS` are rejected instead of entered late.

No manual steps are required for a clean restart. If Helius was unreachable,
the monitor re-polls from the cursor; duplicates are dropped by the
`(chain, leader, signature, leg)` dedupe key.

## 6. Reconciliation

An order becomes `REQUIRES_RECONCILIATION` when a signed/submitted outcome is
unknown. **Never blindly retry such an order** — the state machine makes that
transition impossible.

Since 2026-10-30 the engine only reaches that state for genuinely ambiguous
outcomes. Failures that provably never left the wallet (Jupiter quote or build
errors, RPC preflight/simulation rejections, insufficient SOL for fees) are
recorded as `failed` instead, and a fire retries them up to three times with
backoff before it gives up. If a position is still open after those retries the
handoff is blocked with a `close_failed` case, because the monitor only manages
the active trader's positions and a FIRED trader would strand them.

Exits also sell **what the wallet holds**, not the recorded amount: the copied
size comes from quoted outputs at entry and can exceed the delivered balance
after slippage, which is what produced the 2026-10-30 `InsufficientFunds` (6024)
reconciliations on GTA6 and PURR. When the on-chain balance is unreadable the
recorded amount is used unchanged, and when it is zero the exit is refused with
an explicit failed intent.

The wallet needs SOL for fees and rent. Below 0.02 SOL the notifier warns once an
hour; below 0.005 SOL exits fail closed before signing.

To resolve a case (paper or live):

1. Audit → RECONCILIATION CASES shows intent id + detail.
2. On-chain (live only): look up the transaction by signature on a Solana
   explorer or via Helius `getTransaction`. A case with **no signature** never
   reached the chain, so it can be retried or marked failed without chain
   evidence; a case **with** a signature needs the on-chain check.
   - Confirmed with balance changes → record the evidence; the position/fill
     stands. Cases whose intent reaches `confirmed` auto-resolve at restart.
   - Definitively failed → mark the intent failed and close the case.
   - Still unknown → leave it open; do not re-sign.
3. Positions stuck in `requires_reconciliation` keep their PnL out of equity
   until resolved — that is intentional.

## 7. Arming live mode (checklist)

1. `.env`: `MODE=live`, valid `HELIUS_API_KEY`, `JUPITER_BASE_URL=https://api.jup.ag`,
   `JUPITER_API_KEY=...`, `LIVE_TRADING_ACK=I UNDERSTAND LIVE MODE SIGNS AND SUBMITS REAL SOLANA TRANSACTIONS WITH REAL FUNDS`
   (exact string), restart.
2. `pnpm wallet:create` (if not yet); fund the **dedicated** wallet with a
   limited operating balance only.
3. Settings → LIVE READINESS: every item must be ✅ (mode, ack string, wallet,
   Helius, Jupiter prod key, worker, no reconciliation cases, no emergency
   stop, setup completed).
4. Type the acknowledgment, enter the wallet encryption secret (used in
   memory only), press **ARM LIVE**. The dashboard now shows LIVE.

Live never arms merely because API keys exist. Disarm anytime; emergency stop
also disarms.

### Jupiter API plan (decision: free tier)

We run on the Jupiter **free keyed plan** (`api.jup.ag`, 1 request/s and
60 requests/min in one shared bucket). Sustained usage is ~5–6 requests/min
(provider health check + one mark per open position per minute), well under the
limit at any position count the bankroll cap allows — the deployed-% ceiling
times capital, divided by max bet, bounds the position count (e.g. 8 positions
at $100 capital / $10 bets). Rare 429s fail closed: a mark skips one cycle
("mark pending"), a rejected quote is logged and never retried blind. Upgrade
to the Developer tier **only if** request volume ever requires it (roughly 40+
concurrent positions at current sizing) **and** profits justify the cost.

### Helius credits (decision: 36 s polling, free plan; bulk refresh off Helius since 2026-10-31)

Helius free plan = 1M credits/month. Credit costs: standard RPC (`getBalance`,
`getLatestBlockhash`) 1 credit; `getSignaturesForAddress` 10; the monitor's
`getTransactionsForAddress` 10-credit minimum per call. At the current
`LEADER_POLL_INTERVAL_MS=36000` the runtime burns ~27,900 credits/day
(~2,400 polls + health + SOL balance) → the free million lasts ~36 days.
The candidate activity refresh (the bursty part that once burned 429s) moved
to the free public Solana RPC (`PUBLIC_SOLANA_RPC_URL`); Helius is only its
fallback. Live mode starts on the same free plan; if credits ever get
tight (higher capital, faster copying wanted), the options are a slower poll
or the Developer tier ($49/mo, 10M credits — ~3+ months at 8 s polling).
Watch per-method usage in the Helius dashboard; a burnt budget shows up as
HELIUS DOWN in the dashboard health row.

## 8. Backups and recovery

- Back up `DATA_DIR` (SQLite DB + WAL, wallet file). Stop the
  server first (or copy both `-wal`/`-shm` files with it).
- The wallet file is useless without the encryption secret — store them
  separately (password manager / offline paper).
- Restore: install anywhere, put the folder back, `pnpm db:migrate`, `pnpm start`.
- Reset everything (destructive): delete `DATA_DIR` contents.

## 9. Troubleshooting

| Symptom                                     | Meaning / action                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Badge STALE                                 | provider health failing or leaderboard observation older than `LEADERBOARD_MAX_AGE_SECONDS` → refresh import. |
| Badge RECONCILIATION                        | open reconciliation case → §6.                                                                                |
| PAUSED_NO_TRADER                            | no chair is filled → nothing to do; the promotion queue and the demand-driven discovery fill it.              |
| Entries never happen                        | check Audit → RISK REJECTIONS (rule names map to `.env` limits); check pause/emergency state.                 |
| Helius 429                                  | rate limited — increase `LEADER_POLL_INTERVAL_MS`.                                                            |
| `worker lock held by another process`       | a worker is already running; stop it or remove a stale `data/worker.lock`.                                    |
| Webhook/robots/CAPTCHA errors from fomo-web | adapter failed closed by design; log in manually in the visible browser or import manually.                   |

## 10. What ZCode Remote Control / chat channels are NOT

ZCode Remote Control and chat channels are **not** part of the trading loop and
drive nothing in it (the LLM research pipeline is retired, D6). They are not a
cloud runtime: the worker, dashboard, and signing live on your machine, and chat
messages cannot sign, arm, or trade.
