# Canonical fetching method: FOMO leaderboard + Dawn wallet resolution

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

**Who runs it.** The 30-minute research sweep owns this procedure now, and since
2026-10-30 it runs **unconditionally on every sweep**: there is no pool-age
condition anymore — every 30-minute run refreshes the board once (the rank-fire
rule needs scan evidence every 30 minutes), imports the rows, and rebuilds the
snapshot. A human can still run it by hand. Nothing here may be done by the
research subagent or by the MCP server.

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
8. Rebuild the derived snapshot **without restarting the server**:
   from `zcode-bot/apps/server`, `pnpm exec tsx src/cli/snapshot-rebuild.ts`.
   (The old "delete `research_snapshots` + `launch.bat`" recipe is still valid for a
   manual run, but an unattended loop must not bounce the server.)
   Verify `data/research/snapshot/snapshot.json`: `sourceFreshnessSeconds` is the age
   of the NEWEST row, `oldestObservedAt` / `staleCandidateCount` describe the tail.
9. Close desktop Chrome when finished.
10. If the new ordering is fresher than the current hire and the hire has no open
    position, the researcher marks the recommendation `rotateIfFlat: true` and the
    engine fires + re-hires from that ordering. This is automatic; see
    `PLAN-leaderboard-refresh-and-rotation.md`.

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
7. **Rate-limit rule:** empty replies / preview-only replies across many
   handles = Dawn is soft-throttling. STOP immediately; the 6h schedule
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
- Snapshot table is a derived cache: `delete from research_snapshots;` +
  restart forces a rebuild (needed after DB-only pool changes).
- GUI toolkit lives in `Temp/zcode-gui/` (`gui.ps1` shot/click/key/type,
  `hover-rows.ps1`, `copy-profile-urls.ps1`, `wheel-at.ps1`,
  `drag-scrollbar.ps1`, `capture-fomo.ps1` PrintWindow captures).
- Zoom state persists per-origin in Chrome: a fresh window on fomo.family may
  open at the last-used zoom (67%-80% helps fit more rows; Ctrl+- / Ctrl+0).

## Sweep automation

The hourly research sweep (event-driven + capped) is defined in
`docs/research-sweep-automation.md` (currently PAUSED at operator request;
recreate from there). It spawns the pinned `zcode-research` subagent which
submits recommendations via the restricted research MCP — see `AGENTS.md`
for the subagent-exclusivity rule.

## Day-trader mode (operator-ratified 2026-10-27; sort re-ratified 2026-10-29)

The pool is restricted to **day traders**: fast, currently-active, positive today. Decisions:

- **Capture** (the sweep, automated): the always-visible top rows of the 24H board — no scrolling, **every 30-minute run unconditionally**. Clipboard URL per row, imported by `fomo-import`, snapshot rebuilt by `snapshot-rebuild`. Manual capture follows the same shape.
- **Activity gate (Helius, hard):** ≥5 swaps in the last 24h on-chain, last swap ≤20h — confirmed before every hire.
- **Momentum gate (researcher, hard):** `pnl24hUsd > 0` with `statsCheckedAt` within 12h. A trader with a non-positive or unknown day is not qualified, however good the week looks — the system holds ≤16h, so only the current window is copyable.
- **Board-presence hire guard (engine, hard, 2026-10-30):** every hire requires the handle to be on the latest captured scan; combined with the rank-fire rule below, the board decides both holding and hiring.
- **Wallet resolution (Dawn):** runs automatically — boot +2 min, then every 6h, oldest stats first, plus an auto-run after any rebuild that still sees walletless candidates (one per 20 min max), so new faces from a fresh import are resolved the same cycle. One polite message per candidate → wallet + paper PnL marks + win rate stored (realized PnL is null for everyone: the rich card is unreachable).
- **Rank-fire rule (engine, 2026-10-30):** the hired trader is fired when he is absent from the latest scan once, or outside displayed top-3 in two consecutive scans; both branches stand down when the latest scan is older than 2h. No fired-trader cooldown exists — a fired trader is rehireable the moment he qualifies again.
- **Stall watcher (wired 2026-10-29):** a hired leader whose wallet shows no on-chain activity for `LEADER_STALL_FIRE_HOURS` (8h, tunable in Settings) while we hold is fired — regardless of open-position winners — and replaced from the shortlist. Judged only when the Helius activity stamp is fresh; backstop for board outages.
- **Ranking (researcher):** qualify on the activity gate + positive fresh day, then order by 24h PnL descending (tie-break: fresher activity check, then more swaps). Divergence concerns (all-time >> 30d, day-hot/week-cold) are recorded, not enforced — the engine's reactive controls (rank-fire, 2-loss fire, 12h idle fire, 16h time exit, 8h stall fire) are the real protection.
- Known trade-off: the 24H PnL board under-represents pure scalpers — if the gate yields too few, scan deeper (ranks 10–50) rather than loosening the activity requirements.

## Day-trader data pipeline (implemented 2026-10-28)

Order of operations, each stage feeding the next. Every identifier comes from
the clipboard; numbers come from the row or the profile page, never from OCR.

1. `tools/gui/board-pass.ps1` - visible leaderboard rows -> `board.json`
   (rank + canonical profile URL). (The automated sweep performs the equivalent
   in-line; this script is the manual equivalent.)
2. `apps/server: pnpm exec tsx src/cli/fomo-import.ts entries.json` - pool upsert.
   Omitted stats are preserved, not cleared; duplicate ranks produce a warning.
   (`tools/gui/profile-stats.ps1` and the `avg_hold_hours`/`trades_count_7d`
   columns it filled are retired — the Stage-1 gate they fed was never enforced
   and was removed 2026-10-29; the columns remain in the DB, unused.)
3. `apps/server: pnpm exec tsx src/cli/candidate-activity.ts --limit 30` - Helius
   `walletActivity24h` per wallet -> `swaps_24h`, `last_swap_at` + stamp
   `activity_checked_at` (the activity-freshness evidence); addresses that
   pass the pre-hire gate are upgraded to verification "verified".
   Also runs on a 6h server timer and via the Ops action "Refresh candidate activity now".
4. `apps/server: pnpm exec tsx src/cli/dawn-lookup.ts --all-missing --limit 25` -
   Dawn compact card -> PnL 24h/7d/30d/all-time + ranks, lifetime trades, volume,
   recent buys/sells, coins, last-trade age; win rate/realized when present.
   The runtime also runs this automatically: once 2 minutes after every boot and
   then every 6h, oldest stats first, with an audit line for every outcome
   (`lookup run starting`, `resolved N address(es)`, `Telegram session needs
login; QR login window opened`, or `lookup skipped: another run already in
progress`). A dead Telegram session is the one state that needs a human: scan
   the QR code once. Research never runs Dawn itself; the research subagent is
   forbidden from it.
5. Snapshot rebuild (30 min timer, debounced ~60s after a Dawn/Helius run that
   changed rows, after each import via `snapshot-rebuild`, or clear
   `research_snapshots` + restart) ->
   `publicStats` carries all of it to the researcher, including both freshness
   stamps: `activityCheckedAt` (step 3, Helius) and `statsCheckedAt` (step 4,
   Dawn card). A candidate is treated as stale only when BOTH stamps are old —
   `observedAt` older than 12h AND `activityCheckedAt` older than 6h. A stale
   observation with a recently verified wallet stays usable (the board rotates
   daily; a resolved wallet is permanent), and the researcher flags the stale
   PnL marks as a concern rather than dropping the candidate.

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

### Ranking rule (researcher, re-ratified 2026-10-29)

Qualify on activity (`swaps24h` >= 5 and last swap <= 20h, or the compact-card
equivalents `lastTradeAgeHours` / `recentBuys + recentSells`) AND a positive
fresh day: `pnl24hUsd > 0` with `statsCheckedAt` within 12h. Then order by
`pnl24hUsd` desc, tie-break fresher `activityCheckedAt`, then higher `swaps24h`.
The system holds <=16h, so the day is the only window that gets copied; 7d/30d
figures are context. Judge how fresh the
activity numbers are by `activityCheckedAt` (6h Helius timer); `statsCheckedAt`
only advances on Dawn fetches and says nothing about the activity fields.
Divergence (all-time >> 30d, day-hot/week-cold) is flagged as point-farm
suspicion in `concerns` — never a silent filter.

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
