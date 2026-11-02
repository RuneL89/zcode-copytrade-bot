# Canonical fetching method: FOMO leaderboard + Dawn wallet resolution

> **Fallback procedure since D3 (2026-11-01).** The automatic handle and wallet
> source is now the **fomoapi leaderboard**: `FomoApiClient`
> (`packages/providers/src/fomoapi.ts`) driven by `DiscoveryService`
> (`apps/server/src/services/discovery.ts`) — on demand, on boot catch-up, and
> through the _Sync discovery now_ op / the `discovery-sync` CLI. The native
> desktop-Chrome capture below is **no longer scheduled**, and Dawn is **out of
> the automatic loop**. This document stays canonical for the manual fallback:
> when the API is unavailable, or when a handle outside the boards must be
> resolved.

**This document is law.** It encodes the operator-verified procedure (2026-10-27)
after a full night of debugging hallucinated slugs, rate-limits, poisoned wallets
and browser security blocks. Do not deviate; do not "optimize" against these steps.

## Policy (highest priority)

1. **fomo.family is ONLY accessed through the operator's normal Windows desktop
   Chrome** (real profile, stored Google login), driven by GUI automation
   (screenshots, clicks, typing, clipboard). NEVER the app/automation browser
   (Playwright), never headless, never a copied profile:
   - Google refuses OAuth in automation browsers.
   - Chrome 136+ ignores remote-debugging switches on the default user-data-dir.
   - Chrome's app-bound cookie encryption makes profile copies inherit NO login.
   - `FOMO_LEADERBOARD_URL` stays commented out in `.env` — the Playwright
     leaderboard adapter must never touch fomo.family.
2. **Dawn (Telegram) uses its own dedicated browser profile**
   (`data/browser-profile-dawn`), logged in once via QR scan. Telegram permits
   this; keep that session alive (close browsers gracefully, never force-kill
   right after a login).
3. **Dawn is a data source only.** Never tap "Copy trader", never create a
   copytrade task, never move funds through Dawn. Copy buttons with the exact
   label "Copy" (wallet address copy) are allowed for reading addresses.

## Procedure A — FOMO leaderboard refresh (GUI + clipboard)

**Who runs it.** A human, by hand — the automatic loop no longer uses this
procedure. Discovery is the fomoapi leaderboard (`DiscoveryService`), so this
capture is the **fallback** for when the API is unavailable or a handle outside
the boards must be checked. Nothing here is scheduled, and no agent or server
runs it.

1. Launch desktop Chrome: `https://fomo.family/leaderboard?range=24h`.
   Dismiss the "Restore pages?" bubble if present. An automated run must then raise
   the window (`WScript.Shell.AppActivate`) — the computer-use API cannot front a
   background window on Windows — and abort if Chrome is not frontmost.
2. Identify the current top N (usually 10) by rank number on the rows.
3. For EACH row, get the canonical profile URL — **clipboard, never vision**
   (OCR misreads handles: econcar/econoar, monke365/monke3655 were both
   vision errors the clipboard fixed):
   - Click the row → profile page opens.
   - `Ctrl+L`, `Ctrl+C` → read clipboard (`Get-Clipboard`) → exact URL.
   - `Alt+Left` to go back.
   - Strip the `?r=...` referral parameter; keep the clean path.
   - Helper: `Temp/zcode-gui/copy-profile-urls.ps1 -Ys <rowYs>` (clicks each
     row, copies the URL, goes back; rows at ~100% zoom sit at
     y ≈ 486/531/575/620/657/701/744/788/832/875, x = 1150).
4. The slug is its OWN identifier — sometimes the handle (tvmx, kv4rl,
   0xAvast, econoar), sometimes the display name variant (Unipcs, Duncan,
   mk4, TM, User), sometimes neither (The__Solstice has TWO underscores,
   FartmanSacks, monke365). **Never construct or guess a slug.** Store the
   handle from the row's `@handle` and the URL from the clipboard.
5. Write `entries.json`: `[{handle, rank, pnlUsd, profileUrl}]` (one entry per
   verified row, `pnlUsd` = the row's displayed value).
6. Import (WAL-safe while the server runs), from `zcode-bot/apps/server`:
   `pnpm exec tsx src/cli/fomo-import.ts <entries.json>`
7. Do **not** disable candidates that are absent from the fresh list when running the
   automated stage-0 pass. Fresh board rows have no Solana address until Procedure B
   resolves them, so pruning would strand the pool at the few candidates that already
   have wallets. Manual runs may still prune deliberately:
   `update trader_candidates set enabled=0 where enabled=1 and handle not in (...)`.
8. Verify the import landed: the newest `trader_candidates.observed_at` advanced
   and the audit trail carries the import id.
9. Close desktop Chrome when finished.
10. The imported handles enter the pool like any other source. Admission to the
    watch list is decided by the funded-buy scan and the D4 gates — never by the
    board position, and there is no rotation.

## Procedure B — Dawn wallet resolution (sequential, response-driven)

1. Preconditions: Telegram session alive in `data/browser-profile-dawn`
   (one-time QR: Telegram app → Settings → Devices → Link Desktop Device;
   close any holder window GRACEFULLY afterwards — a force-kill right after
   login destroys the fresh session).
2. Only canonical clipboard-verified URLs (Procedure A). If a slug previously
   failed with a ticker-fallback ("Try the ticker with a $ in front…") or an
   empty reply, re-verify the URL via Procedure A before retrying — most such
   failures were wrong slugs, not Dawn flakiness.
3. Run, from `zcode-bot/apps/server`:
   `pnpm exec tsx src/cli/dawn-lookup.ts --all-missing --limit 20`
   Pacing is built in: 20s base + 0-100% randomized jitter between lookups,
   45s reply window, one URL at a time — the next URL is sent only after the
   previous reply was parsed AND its wallet saved to the pool DB.
4. Send the profile URL, never a bare `@handle` (Dawn parses handles as token
   ticker searches).
5. Addresses shown in the card text are TRUNCATED. The provider clicks the
   inline "Copy" buttons (exact label; never "Copy trader") and reads the
   clipboard for the full address. Wallets land in `candidate_addresses` with
   `verification='reported'`.
6. **Poisoned-wallet rule:** if any resolution turns out to have used a wrong
   or unverified slug, DELETE its stored wallet
   (`delete from candidate_addresses where candidate_id=... and chain='solana'`)
   and re-resolve with the canonical URL. A wrong-slug resolution may belong
   to a stranger (verified live: the 'Aurelius' alias returned a different
   wallet than canonical 'Aurelius0121').
7. **Silent-bot rule (2026-10-30).** If a sent URL produces no trader card,
   first confirm Telegram itself is healthy — the browser window still shows
   the Dawn chat with its message box, not a login/QR screen (check with
   computer-use on the Dawn window; verified live: jusatrades answered in
   under a minute while GrimRigidGoat never did, with the same session).
   - Session healthy: wait 30 seconds and ask once more.
   - Still no card: record it (`DAWN_NO_CARD` rejection + audit line naming the
     handle) and **move on to the next target immediately**. A silent handle
     must never block the rest of the run. After two consecutive silent runs
     the handle is parked for 6 hours so it cannot monopolise the queue.
   - Session not healthy (login screen, DOM unrecognised): that is a session
     fault, not a handle fault. Fail closed and open the QR login window as
     before.
8. **Rate-limit rule:** empty replies / preview-only replies across _many_
   different handles (ten or more, after the retry in step 7 also came back
   empty) = Dawn is soft-throttling. STOP immediately; the 6h schedule
   retries politely. Never shorten delays, never widen the target list.

## Environment facts (save yourself the debugging)

- `better-sqlite3` only resolves from inside `zcode-bot/packages/db` or via
  `pnpm exec` in `apps/server`; open the DB by absolute path.
- The server runs from `launch.bat` (repo root, port 8787). Health:
  `GET http://127.0.0.1:8787/` → 200.
- `launch.bat` must NOT auto-open the dashboard — it spawns personal Chrome
  on every restart and breaks GUI flows (fixed; keep it fixed).
- `Get-Clipboard` is the source of truth for any URL/type that matters.
  Screenshots are for layout only (which row is where), never for reading
  identifiers.
- The 30-minute device: after a manual fallback import there is nothing to
  rebuild — the pool is read from SQLite on every dashboard rebuild, and the
  legacy `research_snapshots` table is retired (D6, kept for the record).
- GUI toolkit lives in `Temp/zcode-gui/` (`gui.ps1` shot/click/key/type,
  `hover-rows.ps1`, `copy-profile-urls.ps1`, `wheel-at.ps1`,
  `drag-scrollbar.ps1`, `capture-fomo.ps1` PrintWindow captures).
- Zoom state persists per-origin in Chrome: a fresh window on fomo.family may
  open at the last-used zoom (67%-80% helps fit more rows; Ctrl+- / Ctrl+0).

## Automation is retired (D3/D5/D6)

There is no sweep and no scheduled research: discovery is the fomoapi leaderboard
(`DiscoveryService`), demand-driven and rate-limited, and the runtime runs in the
server process. The pinned `zcode-research` subagent, the research MCP server and
the snapshot it read are deleted. Nothing in this document is scheduled, and
nothing here should be recreated as an automation.

## What replaced the day-trader pipeline (D2–D6)

The lines below are kept for the record; the current pipeline is:

- **Discovery** — the fomoapi 24h/7d/30d boards + alerts, unioned by `userId` and
  deduped by wallet, on demand (bench thin, or a free chair with nothing
  promotable behind it) and rate-limited. The displayed PnL is context, never a
  hire gate.
- **Admission** — the funded-buy scan (a coin bought against a stable or SOL leg):
  ≥`ADMISSION_MIN_BUYS_24H` (3) funded buys in 24h with the last inside
  `ADMISSION_MAX_LAST_BUY_HOURS` (24). Funded sells are recorded as observability,
  never as an admission requirement.
- **Shadow ledger** — every funded buy opens a pretend position at the D1 notional
  and closes on the leader's sell or at the age ceiling at a live Jupiter price
  (D4's 1% per-side assumption rides in the PnL).
- **Promotion** — ≥`PROMOTION_MIN_CLOSED` (8) closed shadow trades, net >
  `PROMOTION_MIN_NET_USD` ($3), a funded buy inside `PROMOTION_MAX_LAST_BUY_HOURS`
  (4), no re-entry ban, a free chair and shared-pool headroom.
- **Lifecycle** — a chair is lost to two losing close units, a silent wallet
  (`LEADER_STALL_FIRE_HOURS`), a stale last buy (`MAX_LEADER_STALL_HOURS`) or an
  idle chair (`IDLE_FIRE_HOURS`). The board is never a fire condition.

## Fallback data pipeline (manual)

When the API is unavailable, this is the shape of a manual fallback run. Every
identifier comes from the clipboard; numbers come from the row or the profile
page, never from OCR.

1. `tools/gui/board-pass.ps1` — visible leaderboard rows → `board.json`
   (rank + canonical profile URL).
2. `apps/server: pnpm exec tsx src/cli/fomo-import.ts entries.json` — pool upsert.
   Omitted stats are preserved, not cleared; duplicate ranks produce a warning;
   handle-derived candidate ids keep the rows reconciled with the API inlet.
3. `apps/server: pnpm exec tsx src/cli/candidate-activity.ts [--limit 30] [--source public|helius]` —
   activity refresh per wallet: free public Solana RPC primary (direction-aware:
   `swaps_24h`, `last_swap_at`, `buys_24h`/`sells_24h`, `last_buy_at`,
   `activity_check_status`), Helius fallback. `tsx src/cli/wallet-activity.ts <address>`
   is the ad-hoc single-wallet verifier (read-only, no DB writes).
4. `apps/server: pnpm exec tsx src/cli/dawn-lookup.ts --all-missing --limit 25` —
   the Dawn compact card (PnL periods, trades, volume, recent buys/sells) for a
   walletless candidate. Dawn is a wallet fallback only; the fomoapi rows carry
   verified wallets, so the automatic path never needs it.
5. `apps/server: pnpm exec tsx src/cli/discovery-sync.ts --force` — the API inlet
   itself, if you want the primary source rather than the fallback.

### Dawn card layouts (measured)

The reply to a pasted profile link is the **compact card**:

```
@tvmx on fomo · 348.1K followers
├ SOL: F5hk...          └ EVM: 0xa067...
PnL
├ 24h: +$390.1K · #5    ├ 7d: +$377.1K · #3
├ 30d: -$2.85M          └ All time: +$2.18M · #7
Trading
├ Trades: 4,458 · Volume: $4.44M
├ Recent buys / sells: 7 / 12
├ Coins: 11             └ Last trade: 8h ago
[Copytrade] [Alerts] [Close]
```

The richer card with **Realized on-chain** and **Win %** exists only inside the
Copytrade -> Top Traders UI. Reconclusion (2026-10-28, three attempts): it is
NOT reliably reachable - Telegram inline buttons ignore synthetic clicks, and
the only adjacent action is "Copytrade", which is forbidden (it starts a task;
ours stopped at the chain prompt and `/copytrade` confirmed 0/50 slots). So
realized/win stay null on our path; profitability ranking uses the PnL periods.

### (retired) Researcher ranking rule

The board ranking rule is retired with the research pipeline (D6). Nothing ranks
board PnL anymore: a wallet is judged by its own funded buys and its shadow
record, and promotion is the deterministic D4 gate.

## Two traps worth remembering

- **RPC shapes differ:** standard `getSignaturesForAddress` returns a bare array;
  Helius' custom `getTransactionsForAddress` returns `{ data: [...] }`. Handling
  only the second made every wallet report zero activity.
- **Stale binaries overwrite fresh data:** the boot activity refresh rewrites
  `swaps_24h` for every candidate. If an older server process is still running
  when provider code changes, it can zero the values the CLI just wrote. Restart
  the server after rebuilding providers, before running the CLIs.

## Two more traps (learned 2026-10-28, both silently broke copy-trading)

- **Signature location:** Helius getTransactionsForAddress with transactionDetails
  'full' has NO top-level signature; it lives at transaction.signatures[0]. Only the
  'signatures' detail mode puts it at row.signature. Reading just the latter made
  every polled swap carry signature undefined, which violated the
  observed_leader_events NOT NULL constraint and stalled the leader cursor forever.
- **Instruction program ids:** raw (non-jsonParsed) instructions carry
  programIdIndex, not programId. Resolve it against the combined account list
  (static keys + loadedAddresses.writable + readonly). Reading only programId left
  the programs set empty, so the classifier saw swap-like balances without a known
  swap program and skipped every real buy as SKIPPED_AMBIGUOUS. The copy loop could
  never fire.
