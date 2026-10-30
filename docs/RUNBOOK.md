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

1. The 30-minute sweep refreshes the 24h FOMO board when the pool is older than 6h
   (Procedure A stage 0, desktop Chrome) and rebuilds the snapshot. To refresh by
   hand, follow `docs/FOMO_DAWN_FETCHING.md` (Settings → MANUAL IMPORT is still a
   valid fallback). Every import is audited.
2. Ensure the ZCode scheduled research task is active (docs/ZCODE_AUTOMATION.md)
   and confirm a `VALID` recommendation appears in **Audit**.
3. Activate the first candidate (Settings → activate, or the worker does it
   from the shortlist after a firing). The monitor initializes the leader
   cursor at activation — activity before activation is never copied.
4. Watch the dashboard: equity, active trader (COPY 0.25x · FIRE AT 2 L),
   live mirror card, closes chart, WHO WE COPY, health row.

### Automatic rotation after a refresh

Rotation is evaluated only in the sweep that follows a board refresh (the engine
requires a `board.refreshed_at` marker written within the last 45 minutes), and it
keeps the incumbent while they sit in the **top-3 of the latest captured scan**
(widened 2026-10-30 from rank-1-only to match the rank-fire rule). Within that
window, the recommendation carries `rotateIfFlat: true`; on ingest the engine fires
the active trader **only if** it holds no open position, no reconciliation case and
no in-flight entry intent, and **only if** some candidate on the new ordering is
hireable. Otherwise it skips and writes `rotation skipped: …` to the audit trail.

Guards worth knowing:

- Rotation never closes positions — a non-flat trader is simply kept, so there is
  no market action from a rotation.
- A fresh board with no resolved wallets (Dawn not yet run) can never rotate: the
  hireable check fails and the current trader stays.
- **There is no fired-trader cooldown anymore** (removed 2026-10-30): a fired
  trader is rehireable the moment he qualifies again. The only exclusion is that
  the just-fired candidate is skipped in the replacement walk of his own fire
  (`JUST_FIRED` skip reason), so a two-loss fire cannot instantly re-enter the
  same trader.
- **Live rotation is ENABLED as of 2026-10-29** (`ROTATE_ON_REFRESH=true` in
  `.env`, restart required after any change). Remove that line to return to
  paper-only rotation; an ignored intent is audited as
  `rotation ignored: live mode requires ROTATE_ON_REFRESH=true`.
- To stop rotation entirely, remove the rotation paragraph from
  `.zcode/agents/zcode-research.md` (it is the only producer of the intent).

### Rank-fire rule (wired 2026-10-30)

Every snapshot rebuild (30-minute timer, boot, debounced rebuilds) runs the rank
watch against the captured 24h leaderboard scans. The active trader is fired when
either:

- he is **absent from the latest scan** (one scan is enough — absence is decay), or
- he is **outside displayed top-3 in two consecutive scans**.

Both branches stand down when the latest scan is older than 2 hours, so a dead
capture pipeline never drives fires; the audit line then reads
`rank-watch stand-down: latest scan older than the freshness window`. A fire
audits `strikes N, latest rank R` followed by `rank fire outcome: <status>` and
uses the normal position policy (close all) and replacement walk. Every hire —
replacement, cold start, rotation, manual — additionally requires the candidate's
handle to be on the latest scan (`NOT_ON_BOARD` rejection otherwise), so the bot
never hires a trader the board has already dropped. Scans come from the sweep's
30-minute Procedure A imports; the last five scans live in
`leaderboard_observations` (`repo.listRecentScans`), pruned after 30 days.

### Hiring pause: fired → fresh research → auto-hire (wired 2026-10-30)

**The pipeline is one box on the dashboard.** The OPEN POSITIONS card (where the
idle countdown lives) shows every stage as chips — `IDLE TIMER › FIRED ›
RESEARCH › NEW HIRE` — plus a headline: the countdown while flat, then `FIRED`,
`RESEARCH QUEUED`, `RESEARCHING`, `HIRING`. The stages come from
`DashboardState.hiring.stage`, so what the dashboard shows is what the engine is
actually doing.

**Idle fire timing.** The idle check runs on EVERY monitor tick (8s), not on the
hourly discipline sweep: when the countdown reaches zero the trader is fired
within a tick. Provider failures during the Helius poll are recorded but no
longer skip the idle/time checks.

After a fire, the replacement walk will **not** spend an ordering that predates
the newest board scan (5-minute tolerance; the guard stands down when no scan is
captured or the scan itself is older than 2 hours, so a broken capture pipeline
can never freeze hiring). Hiring from such an ordering would pick the best
candidate from hours ago; instead the bot pauses
(`PAUSED_WAITING_FOR_ZCODE`, handoff event `paused_for_fresh_research` with the
"ordering … predates the latest scan …" detail), records a `research_request`
control event (throttled to one per scan), and one of two actors picks it up:

- the 5-minute **research dispatcher** (see `docs/research-sweep-automation.md`):
  refreshes candidate activity, rebuilds the snapshot, writes
  `research_dispatched`, and spawns the researcher — latency ≤5 min;
- otherwise the 30-minute sweep, which treats a `research_request` newer than
  the newest recommendation (and newer than any `research_dispatched`) as a
  research trigger.

When the fresh ordering is validated, the idle-hire path activates its top
eligible candidate automatically. The same guard applies to cold start and idle
resume.

### Stall watcher (wired 2026-10-29)

The hourly discipline sweep fires the hired leader when their wallet has shown no
on-chain activity for `LEADER_STALL_FIRE_HOURS` (default 8h, tunable in Settings)
**while we hold**, and only when the Helius activity stamp itself is fresh (≤6h —
staleness is never judged from stale evidence). The audit line reads
`stall watcher: leader wallet silent Nh — firing`; the normal position policy
closes any open positions and the replacement takes the slot. This is what makes
"traders are discarded after no activity" literally true; the pre-hire gate
(`MAX_LEADER_STALL_HOURS`, 20h) is a separate decision about who may be hired.
The rank-fire rule above usually fires first; the stall watcher is the backstop
for when the board itself is unavailable.

### Wallet resolution runs itself — except one state

The runtime resolves missing wallets through Dawn once 2 minutes after every boot,
then every 6 hours, and **immediately after any snapshot rebuild that still sees
walletless enabled candidates** (throttled to one auto-run per 20 minutes, added
2026-10-30 — this is what gives a fresh board import same-cycle wallet
resolution). Every run is audited: `lookup run starting (N walletless,
M stale-stats)`, `resolved N address(es), M unresolved`, or
`lookup skipped: another run already in progress`. The one state that needs you:

> `Telegram session needs login; QR login window opened`

The Telegram Web session in `data/browser-profile-dawn` has died. A QR login window
is already open on the desktop — scan it with the phone once and the next scheduled
run proceeds on its own. If you miss the window, run the dashboard action
"Open Telegram (Dawn) browser for login".

Candidate usability follows two independent clocks: a candidate needs a wallet and
freshness on at least one of them — leaderboard observation within 24h **or**
on-chain activity check within 6h. A stale observation with a freshly verified
wallet stays usable; the researcher flags its outdated PnL marks as a concern.

## 3. Pause / resume

- **Pause new entries** (Settings → CONTROLS): no new copied entries; leader
  monitoring, mirrored exits, reconciliation, emergency stop, and close-all
  all continue.
- **Resume** re-enables entries.
- **PAUSED_WAITING_FOR_ZCODE** (automatic): the shortlist is exhausted,
  stale, or missing. The dashboard says so and the audit shows a
  `replacement_request`. Since 2026-10-30 the pause self-heals: the next
  validated ordering (the 30-minute sweep's research) is hired automatically —
  paper always, live while armed — provided a candidate passes the
  board-presence, activity and day gates. Until such an ordering exists the
  pause stands; do not "fix" it by hand-activating candidates unless you
  deliberately want a manual override.

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
