# RUNBOOK — ZCode Bot operations

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

1. Import the weekly FOMO leaderboard (Settings → MANUAL IMPORT, JSON or CSV —
   see `fixtures/leaderboard.example.*`). Every import is audited.
2. Ensure the ZCode scheduled research task is active (docs/ZCODE_AUTOMATION.md)
   and confirm a `VALID` recommendation appears in **Audit**.
3. Activate the first candidate (Settings → activate, or the worker does it
   from the shortlist after a firing). The monitor initializes the leader
   cursor at activation — activity before activation is never copied.
4. Watch the dashboard: equity, active trader (COPY 0.25x · FIRE AT 2 L),
   live mirror card, closes chart, WHO WE COPY, health row.

## 3. Pause / resume

- **Pause new entries** (Settings → CONTROLS): no new copied entries; leader
  monitoring, mirrored exits, reconciliation, emergency stop, and close-all
  all continue.
- **Resume** re-enables entries.
- **PAUSED_WAITING_FOR_ZCODE** (automatic): the shortlist is exhausted,
  stale, or missing. The dashboard says so and the audit shows a
  `replacement_request`. Use the ZCode task's **Run now** or Settings →
  recommendation import. This is fail-closed by design; do not "fix" it by
  hand-activating candidates unless you deliberately want a manual override.

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
4. reloads fired-trader cooldowns,
5. resumes leader polling **forward from the saved cursor** — activity older
   than the cursor is never processed, and events older than
   `MAX_COPY_EVENT_AGE_SECONDS` are rejected instead of entered late.

No manual steps are required for a clean restart. If Helius was unreachable,
the monitor re-polls from the cursor; duplicates are dropped by the
`(chain, leader, signature, leg)` dedupe key.

## 6. Reconciliation

An order becomes `REQUIRES_RECONCILIATION` when a signed/submitted outcome is
unknown. **Never blindly retry such an order** — the state machine makes that
transition impossible.

To resolve a case (paper or live):

1. Audit → RECONCILIATION CASES shows intent id + detail.
2. On-chain (live only): look up the transaction by signature on a Solana
   explorer or via Helius `getTransaction`.
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

### Helius credits (decision: 36 s polling, free plan)

Helius free plan = 1M credits/month. Credit costs: standard RPC (`getBalance`,
`getLatestBlockhash`) 1 credit; `getSignaturesForAddress` 10; the monitor's
`getTransactionsForAddress` 10-credit minimum per call. At the current
`LEADER_POLL_INTERVAL_MS=36000` the runtime burns ~27,900 credits/day
(~2,400 polls + health + SOL balance + activity refresh) → the free million
lasts ~36 days. Live mode starts on the same free plan; if credits ever get
tight (higher capital, faster copying wanted), the options are a slower poll
or the Developer tier ($49/mo, 10M credits — ~3+ months at 8 s polling).
Watch per-method usage in the Helius dashboard; a burnt budget shows up as
HELIUS DOWN in the dashboard health row.

## 8. Backups and recovery

- Back up `DATA_DIR` (SQLite DB + WAL, wallet file, research dirs). Stop the
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
| PAUSED_WAITING_FOR_ZCODE                    | no eligible candidate → ZCode Run now / import recommendation.                                                |
| Entries never happen                        | check Audit → RISK REJECTIONS (rule names map to `.env` limits); check pause/emergency state.                 |
| Helius 429                                  | rate limited — increase `LEADER_POLL_INTERVAL_MS`.                                                            |
| `worker lock held by another process`       | a worker is already running; stop it or remove a stale `data/worker.lock`.                                    |
| Webhook/robots/CAPTCHA errors from fomo-web | adapter failed closed by design; log in manually in the visible browser or import manually.                   |

## 10. What ZCode Remote Control / chat channels are NOT

ZCode Remote Control, chat channels, and scheduled tasks drive **research
only**. They are not a cloud runtime: the worker, dashboard, and signing live
on your machine, and chat messages cannot sign, arm, or trade.
