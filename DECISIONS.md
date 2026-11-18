# Decisions — Copydesk

Running log of operator decisions. Each entry states the decision, why it was
made, what the code currently does instead (when it differs), and the evidence.
Newest decisions are appended; numbering is stable.

Decided items (`D*`) are binding. Topics under discussion are recorded at the
end as `T*` ("Topics in progress") and are **not** decisions — nothing there is
locked in.

---

## D1 — `MIN_PER_BUY_USD` is a hard floor, not a skip filter

**Decided:** 2026-11-01 (operator).

**Decision.** The copy notional for one leader trade is

```
final = clamp(leader_input × COPY_SCALE, MIN_PER_BUY_USD, MAX_PER_BUY_USD)
```

then clamped by the bankroll headroom (`MAX_DEPLOYED_PCT`). `COPY_SCALE` and
`MAX_PER_BUY_USD` are ceilings; `MIN_PER_BUY_USD` is a floor the bet may not
fall below. A leader buy whose scaled copy would be below the floor is still
copied at the floor — it is not skipped.

**Current behaviour (differs).** `computeCopyNotional`
(`packages/core/src/sizing.ts:41-77`) returns `skip_below_min` whenever
`leader_input × 0.25 < MIN_PER_BUY_USD`, because the engine calls it with
`allowBelowMinRoundUp: false` (`apps/server/src/services/engine.ts:142`). That
makes the floor a veto on the leader's trade size: every leader buy below **$20**
is skipped outright, regardless of the floor.

**Evidence.** Five classified buys were skipped this way, all with leader inputs
far above the floor: $7.86, $16.84, $11.51, $17.84, $18.30 (desired copies
$1.96–$4.58). On 2026-10-30 that was 4 of the 15 classified buys for the day
(27%); over the recorded history it is 5 of 115 (4%).

**Why.** The bot exists to trade often; a $5 position is the smallest position
worth placing on Solana. A sub-$20 leader buy is still a copyable signal.

**Consequence to keep in mind.** Above $20 the 0.25× ceiling and the $5 floor
cannot both hold: $5 on a $7.86 buy is 0.64×, not 0.25×. The floor wins by
decision. In the recorded population 87% of buys are ≥ $40 and already capped at
$10, so this only changes behaviour for leader buys between $5 and $20.

**Implementation surface.**

- `packages/core/src/sizing.ts` — `computeCopyNotional` (floor semantics),
  `capToHeadroom` (already treats `MIN_PER_BUY_USD` as a floor).
- `apps/server/src/services/engine.ts:136-244` — sizing call, skip reason,
  rejection detail.
- `packages/core/test/sizing.test.ts` — pin the new rule.

**Sub-case (decided 2026-11-01).** When the leader's own buy is below the floor,
the copy still places `MIN_PER_BUY_USD`. The floor is absolute; the 0.25× ceiling
yields to it in that case. No such buy exists in the recorded history, so this is
a rule for completeness.

**Amended 2026-11-18 (operator).** The two ceilings are now capital-relative:
`MAX_PER_BUY_PCT` (10) and `MAX_OPEN_PER_TRADER_PCT` (35), evaluated against
current capital at each entry. The $2 floor and the 0.25× copy scale are
unchanged: a single bet is `min(leader_input × 0.25, 10% of capital)`, floored
at $2, then capped by the 35% per-trader room and the 80% deployment cap. The
retired `MAX_PER_BUY_USD` / `MAX_OPEN_PER_TRADER_USD` keys are not read.

---

## D2 — Discovery is a handle generator, not the hireable universe

**Decided:** 2026-11-01 (operator).

**Decision.** The FOMO 24h board is an **inlet for handles**. It never decides
who may be hired: the board-presence hire guard, ordering freshness against the
scan, rank-fire and rotation all disappear with it.

The inlet, end to end:

1. **Capture** — the operator's normal desktop Chrome on
   `https://fomo.family/leaderboard?range=24h`; the **7 visible rows**; **hourly**
   (the 30-minute cadence existed only to feed rank-fire). Procedure A mechanics
   are unchanged: `AppActivate` and abort if Chrome is not frontmost; clipboard
   URLs only; abort on fewer than 5 rows, any non-`/profile/<slug>` URL, or a
   wrong range; never OCR, never guess a slug. **No scrolling, no deeper ranks.**
2. **Import** — `fomo-import` upserts the handles and records the scan. The
   capture step ends here. The displayed PnL is context, never a hire gate.
3. **Wallet resolution** — Dawn for **new walletless handles only**. Never
   re-lookup a resolved wallet; never retry a handle before its park expires.
4. **Funded-buy scan** — every wallet, on a slow cadence (new wallets + watch
   list + the current board rows). Qualification: **funded buys ≥ N in 24h and
   the last funded buy within X hours**. Funded sells are recorded as an
   _observability_ signal (can exits be mirrored?), never as an admission
   requirement. Parameters N and X are still open.
5. **Hand over to T2** — qualified wallets enter the watch list; the inlet never
   ranks, scores or promotes them.

Pool hygiene, also decided: dedupe by **wallet address** (three addresses
currently appear under two handles each), and evict wallets that fail the
funded-buy screen for a few days instead of re-enriching them forever. Every
capture logs its yield (rows read, new handles, wallets resolved, qualified).

The pipeline is not fomo-specific: any handle from any source enters at step 3.
FOMO is simply the only automated inlet.

**Evidence.** Measured 2026-11-01 against the live DB and on-chain history:

- The board's **same-window** yield is **3 of 31 handles (10%)** with a funded
  buy in the 24h they were captured. The earlier 25% figure was selection bias:
  it measured copyability _now_ for handles captured over five days.
- 0 of the current top-7 had a funded buy; 3 of 7 had no token balances at all
  in most transactions; one top-7 "buyer" was collecting creator fees
  (`DistributeFeeToHolders`).
- Board persistence does not predict copyability: 1-scan handles 29% with funded
  buys, 2–3 scans 27%, 4–10 scans 18%, 11+ scans 18%.
- The pool already holds **23 eligible wallets** (funded buys in 24h) out of 79
  with wallets; 46 of 79 have never shown a funded swap.
- Current sweep load: 36–46 captures/day at 30 min, 16–36 distinct handles/day,
  scan-to-scan overlap 4–7 of 7 rows.

**Superseded in part.** D3 replaces the native capture with the fomoapi
leaderboard as the primary inlet; D4 defines the qualification parameters
(N, X), the shadow ledger and the eviction rules; D5 sets the runtime and
cadence. D2's principles stand: the board is discovery only, never the
hireable universe; dedupe by wallet; evict what does not qualify.

---

## D3 — Discovery inlet: the fomoapi leaderboard

**Decided:** 2026-11-01 (operator).

**Decision.** The primary handle/wallet source is the independent **fomoapi.io**
leaderboard (`GET /v2/leaderboard/{window}?limit=150`), on the **free tier only**
(250,000 credits/month, 20 req/min; 250 credits per request). Each row carries a
stable `userId`, the handle, window `pnlUsd`, and a verified Solana wallet.

Discovery unions **all three** fomoapi sources: the 24h, 7d and 30d leaderboards
plus the alerts feed (`/v2/alerts`, or `/ws/alerts` — realtime for 7 days on the
free tier, then 15 s delayed). That is three leaderboard calls per discovery run
plus one alerts call / stream.

The leaderboard is a **discovery feed, not the hireable universe** (D2's
principle). Dawn is demoted to an optional fallback for handles outside the
leaderboard; the native desktop-Chrome capture is no longer part of the loop and
remains only as an optional verification path.

**What the API can and cannot measure.** `trades` and `volumeUsd` are
**lifetime**, not window-scoped: they were identical on the 24h and 7d boards for
all 68 shared handles. Only `pnlUsd` is window-scoped, and all 150 rows of the
24h board are positive. The API therefore cannot rank recent activity; activity
and copyability are measured by our own funded-swap scan (D4).

**Identity.** Key candidates by the API's stable `userId` (or the wallet
address), not the handle; dedupe by wallet. Handles change; two handles can share
one wallet (`okura`/`okuracrypto`).

**Evidence.**

- 150 rows, 149 with a Solana wallet; 148 scanned on-chain.
- 47 of 149 had a funded buy in 24h; **42 of those 47 were new to our database**.
- 21 of the 22 handles we already knew matched Dawn's resolved wallet exactly
  (one mismatch, to be identified before Dawn is fully retired).
- The service reports itself **degraded** (live-data success 0.79). Treat it as a
  hint; the chain is the truth.

**Cadence.** Demand-driven (D5), not a fixed clock.

**Open.** Identifying the one wallet mismatch (1 of 22 known handles) before Dawn
is fully retired. The alerts feed's credit semantics (per request vs per
connection) need one test.

---

## D4 — Evaluation and hiring: watch list, shadow ledger, promotion, re-entry

**Decided:** 2026-11-01 (operator).

**Qualification.** A wallet enters the watch list when the funded-swap scan shows
**≥N funded buys in 24h** and the **last funded buy within X hours**. Funded
sells are recorded as an observability signal, never an admission requirement.
Decided: **N = 3, X = 24h**, both configurable in risk settings.

**Shadow ledger.** Every funded buy opens a pretend position at our notional (D1
clamp: `clamp(0.25 × leader input, MIN, MAX)`); every funded sell closes it. A
position that reaches `MAX_POSITION_AGE_HOURS` + grace is closed at the **live
Jupiter price recorded at that moment**. Working assumptions: 1% slippage per
side; 8h + 3h ceiling. The ledger is forward-looking: a backfill from the
admission scan may seed it, but only observed trades count.

**Unpriceable amendment (2026-11-17).** At/after the grace deadline, a confirmed
Jupiter no-route is terminal: the lot closes at `exit_reason='unpriceable'`,
price `0`, PnL `-notional`, with an audit row. A transient failure (429/5xx/
network) or missing decimals stays open and retries; it is written off at zero
only after a 24-hour wall-clock backstop past the deadline. A confirmed no-route
is cached per mint for 60 minutes so the ceiling sweep does not re-quote it every
watch tick; transient failures are never cached and a success or
`setJupiter()` clears the cache. These losses count normally in closedCount/net
and promotion.

**Promotion.** A watched wallet is promoted when all hold:

- ≥K closed shadow trades;
- net shadow PnL above a threshold;
- last funded buy ≤ **4h** (the operator's tighter recency rule);
- no re-entry ban (below);
- a free roster slot and free capital.

Decided: **K = 8, net > $3**, both configurable in risk settings. The PnL mark
from fomo/Dawn is context only — never the gate.

**Forward-only amendment (2026-11-17).** The admission backfill is ledger
evidence, not promotion proof. Its events are recorded with
`source='backfill'` and its lots with `backfilled=1`; the promotion/demotion
aggregates exclude them, so a wallet is judged on the trades observed after
admission. The recency clock is the leader's on-chain block time, never our
ingestion time (the backfill used to stamp old buys as fresh). A negative
archive requires a completed forward sample: `closedCount >= K`, net ≤ 0, and
**zero open shadow lots** — an open lot can flip the record, and the archive is
irreversible.

**Watch list.** **20 watched wallets, bench target 10.** Discovery runs when
fewer than 10 promotable wallets sit on the bench (D5).

**Re-entry (operator decision, revised 2026-11-15).** A fired trader cannot be
rehired immediately. The block lifts when **another trader is hired after the
firing**, or after **`COOLDOWN_HOURS` (default 3)** with a roster chair still
free. The automatic hand-off hire that fills the fired trader's own chair does
**not** count; a later independent hire does. The fired trader keeps his shadow
record and the normal promotion gates apply (8 closed, net above $3, last funded
buy inside 4h); the same block applies to a manual activation. There is no
repeat-fire archive.

**Admission (2026-11-16; rate-capped 2026-11-17).** Admission is a bounded scan,
not a census-or-nothing gate. It scans one candidate per watch tick and allows
at most 12 Helius detail reads per admission pass (lower when
`WATCH_DETAIL_PER_MINUTE` is lower). A complete 24h window of at most 12
signatures is detailed in full and written as `ok`. A busier wallet — including
one that does not fit in three signature pages — gets a newest 12-signature
prefix; if that prefix proves the three funded buys and a recent buy, the wallet
is admitted and the reading is written as `partial` (a lower bound, never an `ok`
census). A prefix that cannot prove the gate is deferred for 30 minutes without
overwriting the last good columns; a spent detail budget defers for 10 minutes
so one candidate cannot hold the only admission slot. Freshness is filtered
before the one-candidate limit, so a recently checked head row cannot consume
the tick. Rationale: the 3c2a62b run spent 52–57 details per tick and tripped
the 13.6k credits/day guard; the per-pass cap keeps admission inside the cap
while still admitting wallets whose newest 12 prove the gate.

**Lifecycle.** The idle clock runs from `max(hire time, last held position)`; 8h
idle fires. Replacements are taken from the promotion queue within one watch tick
(≤5 min) or immediately on the slot-free event. **An empty slot is acceptable** —
there is no emergency hire from an unproven pool. If a fire's close-out needs
reconciliation, that slot freezes; the others keep trading.

**Blocked-fire amendment (2026-11-17).** A frozen seat is not an unmanaged bag:
the monitor continues the risk-reducing code exits (stop, trail, time/grace) on
its open or partially closed positions. A **full** code exit completes the
blocked fire and frees the chair; a partial, unknown or signed outcome leaves it
blocked for reconciliation.

**Capital and position rules.** Roster of **5 leaders sharing one budget pool**
(no fixed per-leader slice; first-come). Promotion must verify free capital in
the pool. **One position per mint per leader**; same-mint buys within 60s are
coalesced. A per-mint exposure cap is **configurable in risk settings and
disabled by default** (operator decision: no cap for now).

**Cursors.** Two per wallet: a **watch cursor** (the shadow record continues
after promotion, becoming the would-have-copied baseline) and a **roster cursor**
(initialised at hire; no backlog is copied).

**Evidence (verification, 2026-11-01).**

- 150 API wallets → 148 scanned → 74 with funded buys (72h) → 35 potential →
  **4 would be hired** (`bystevevr`, `BasedShillBH`, `CryingBob`,
  `Cryptoblind3rs`).
- All four rank **31–149**; none in the top 20 — the top of the PnL board is
  holders.
- Their open exposure at scan time totalled **$186.25** against ~$102 deployable;
  one leader alone (`CryingBob`) was $100.
- Only one hire had ≥8 closed trades; two had fewer than 5. The sample/effect
  thresholds are load-bearing.
- 7 dropped (two at −$0.66 and −$1.96 — noise), 24 left on watch.

**Open parameters.** The re-entry window (`COOLDOWN_HOURS`, currently 3h), the
eviction window, whether the shadow record is backfilled from the admission
scan, whether the shadow continues for hired traders (recommended), and a
minimum-headroom rule for a shared-pool hire.

**Decided 2026-11-03 (operator).** A hire is **not** gated on capital. A wallet
that passes the record gates takes a free chair even when the pool is fully
deployed; it copies when room frees. The only capital gate left is per entry
(`MAX_DEPLOYED_PCT`, which downsizes a copy or skips it when the remainder is
below `MIN_PER_BUY_USD`). Rationale: sitting flat in a chair costs nothing,
while a proved leader who cannot be hired is a missed opportunity the moment an
existing position exits.

**Decided 2026-11-03 (operator) — the bench.** `promoted` is renamed **bench**
and is a real queue, like a basketball bench: every wallet whose shadow record
qualifies sits on it (no cap, no free chair needed), ordered by shadow net so
the top wallet is exactly the one a freed chair takes. A hire is the only step
that checks for a chair. A bench wallet whose record lapses (net falls, last buy
ages past the recency window, not yet re-admitted after a fire) returns to the
watch list — archived only when its full sample is negative. Hired leaders get
their own `hired` status (shadow record keeps running) so they never count as
bench candidates. The panel shows BENCH above the WATCH LIST; `BENCH_TARGET`
stays a discovery trigger (a floor), not a cap.

---

## D5 — Runtime and cadence: deterministic server services, demand-driven

**Decided:** 2026-11-01 (operator).

**Where.** The discovery, evaluation and hiring services run inside the existing
server process (`launch.bat`, `127.0.0.1:8787`, SQLite in `data/`) on the
operator's laptop. **No ZCode and no LLM in the loop**; ZCode remains available
for manual runs, summaries and optional native verification.

**On demand, not on a clock.** Discovery runs only when needed: a roster slot is
free and promotable candidates < free slots, **or** the watch list is below its
target. It is rate-limited (working: at most one run per 30–60 min). When the
roster and bench are full, external spend is zero.

**Two intentional clocks:**

- **Watch list:** `getSignaturesForAddress` every 5 min per watched wallet
  (1 credit). The shadow uses the leader's own trade price, so latency does not
  distort it; the 5-min cadence also lands the ceiling price near its deadline.
- **Roster:** every 45–60 s per hired wallet (1 credit). A real order follows, so
  latency matters.

Everything else — promotion, demotion, eviction, ceiling checks — is local math
or state-triggered.

**Boot catch-up.** On start: run discovery if the bench is thin, poll watched
wallets once, re-initialise the roster cursors.

**Cost.**

- Discovery (24h + 7d + 30d + alerts): 1–3 runs/day × 3 leaderboard calls × 250
  credits = 750–2,250 credits/day, plus alerts (~125 per `/v2/alerts` call, or the
  free `/ws/alerts` with the 15 s delay) ≈ **23–78k fomoapi credits/month** —
  well under the 250k free tier.
- Helius: watch ~5.8k/day + roster ~9.6k/day + qualification ~150/day ≈
  **16k/day (~480k/month)** — below today's single-trader full poll (24k/day).
- fomoapi free tier: 250k/month; verification used 6 calls (1,500 credits),
  248,500 remaining.

**Open.** Laptop sleep policy (the server must stay awake for exits); whether an
always-on Windows host is preferred later. The bench target is decided at 10.

---

## D6 — Retire the research pipeline

**Decided:** 2026-11-01 (operator). Replaces T5.

**Decision.** The LLM research pipeline is retired. Removed: the research
snapshot file and `snapshot-rebuild`; the three-tool MCP server; the pinned
`zcode-research` agent; ordering validation, TTL and replay; handoff events,
rotation, `rotateIfFlat`, `paused_for_fresh_research`; the 5-minute research tick
and the `research_request`/`research_dispatched` control events. Admission is the
deterministic D4 path only.

**Order.** Removal happens in the build after D3/D4/T4 are live and the new path
has run; until then the old pipeline stays as the fallback. The target state is
no research pipeline at all.

**Evidence.** 68 `NOT_ACTIVELY_TRADING` refusals in one day, no hire since
23:35Z, seven accumulated unspendable recommendations, and every ordering
produced between 00:00 and 05:14 predating the next board scan.

**Open.** None — the decision is complete; only the deletion remains.

---

## D7 — Production live-trading safety

**Decided:** 2026-11-17 (operator). Live mode remains off; the code must be safe
before it is armed.

**Clean live book.** Live mode starts with its own activations, positions and
realized P&L. Every trading row carries `mode`; the engine, roster, caps,
withdrawals and dashboard read only the current mode. Paper history stays in the
database for review but never counts toward live equity, exposure or seats. The
live roster starts empty and promotes from the watch record.

**Durable signed state.** An order intent walks the guarded
`pending_quote → quoted → pending_sign → signed → submitted → confirmed` path.
Signature, blockhash, last-valid block height and signed bytes are persisted
before the network send. Any ambiguous send or lost confirmation becomes
`requires_reconciliation` and is resolved from chain status plus actual token
deltas; signed bytes are never blindly re-sent. A pre-sign crash is provably
unsent; a signed transaction past `lastValidBlockHeight + 150` with no signature
status is provably dead.

**Build validation and send matching.** A live build must contain a known
Jupiter aggregator instruction, exactly the wallet as required signer and fee
payer, a compute-unit limit, a fresh blockhash, and fit 1,232 bytes after the
Sender tip. v0 transactions and lookup tables are resolved and recompiled. The
send ladder accepts a provider signature only when it equals the locally signed
signature; a transport error stops the ladder as unknown.

**Arming, disarm and exits.** Arming requires the full readiness checklist
(mode, exact ACK, LIVE_TRADING, wallet, provider health, balances, cash
reconciliation, no pending orders/reconciliation, worker, clock, DB). Disarm and
emergency stop block new entries but keep the live executor mounted so open
positions can still exit; `lock-wallet` (`LOCK-WALLET`, only when flat) forgets
the secret. Clearing an emergency does not re-arm. A continuous health sweep
auto-pauses new entries on a live blocker.

**No portfolio daily-loss breaker.** The operator's safety model is the
per-position stop/trail/time exits plus the 80% deployment cap and the
10%/35%-of-capital trade/trader ceilings (amended 2026-11-18; formerly $10/$40).
There is no daily realized-loss or lifetime-drawdown
gate; the stale `MAX_DAILY_REALIZED_LOSS_USD` env key and README claim are
removed rather than re-enforced.

**Withdrawals.** Real withdrawals require `MODE=live` and `LIVE_TRADING=true`.
Every attempt is serialized, carries an idempotency key, is written before
signing, and is reconciled by signature. An unknown outcome blocks further
withdrawals. Sent USDC reduces the book's capital; SOL withdrawals only reduce
the fee reserve.

**Fees.** Network fees and Sender tips are paid in SOL from a separate reserve
and are excluded from USDC trade P&L. The fee ledger measures them (including
tips) and the dashboard labels them separately. Rent remains refundable when the
token account closes.

**Backups.** OPS backup uses SQLite's online backup API, copies the configured
`WALLET_FILE` (wherever it lives) and the DPAPI-sealed passphrase, and writes a
hash manifest. `pnpm db:restore <dir> [--wallet]` refuses while the worker lock
is held and takes a safety snapshot first.

---

# Topics in progress (NOT decided)

Explored and discussed, but the operator is not locked in on any of these.
Recorded so the evidence survives between sessions. Each topic lists the current
behaviour, the measured evidence, the options on the table, and the open
questions.

> T1 (Discovery), T2 (Evaluation) and T5 (Retiring the research pipeline) were
> decided on 2026-11-01: T1 is **D2**, T2 is **D4**, with the inlet in **D3**, the
> runtime/cadence in **D5**, and the research retirement in **D6**.

## T3 — Monitoring: remaining open questions

**Settled in D5.** Signature-first polling; watch list every 5 min; roster every
45–60 s; Helius for the roster, transaction details on demand; discovery is not
polled.

**Baseline cost.** A full `getTransactionsForAddress` poll every 36 s for one
trader costs 10 credits = 24k/day (720k/month). The settled design is ~16k/day
(~480k/month) for a five-leader roster plus a twenty-wallet watch list.

**Measured latency.** Public `getSignaturesForAddress`: 8.7 s average, spikes of
6.5 s, 12.8 s and 28.3 s (the slow ones had no recent activity); a 15-call burst
took 19 s with no errors.

**Still open.**

1. Free public RPC vs Helius per tier — public is tolerable for the 5-min watch
   poll, not for the 45–60 s roster.
2. A hard monthly credit ceiling per tier, and what degrades first when it is
   hit (slower watch poll, fewer watched wallets, faster roster poll).
3. Detail fetch: `getTransaction` (1 credit) per new signature for the watch
   list, versus the batch endpoint (10 credits/100) for admission scans.
4. Whether the roster poll runs at 45 s or 60 s (cost vs copy latency).

## T4 — Multi-trader roster: remaining open questions

**Settled in D4/D5.** Roster of 5 leaders sharing one budget pool (no fixed
per-leader slice), one position per mint per leader, same-mint buys within 60 s
coalesced, per-mint cap configurable and disabled by default, replacements from
the promotion queue, empty slot acceptable, a stuck reconciliation isolates to
one slot.

**The work list — single-chair assumptions still in the code.**
`activeActivation()` returns one row (`repo.ts:510-518`); `activate()` refuses
while any activation exists (`lifecycle.ts:187`); `coldStartHire()` returns IDLE
(`lifecycle.ts:291`); the monitor polls only that address (`monitor.ts:67-97`);
the dashboard state has a single `activeTrader` (`state.ts:26`,
`builder.ts:116`). Positions and cursors are already per activation/address, so
the data model is ready.

**Evidence.** `MAX_DEPLOYED_PCT=85%` of ~$120.84 ≈ $102 deployable; at $10 per
buy that is ~10 concurrent positions. The verification's four hireable leaders
had $186.25 open at scan time — capacity, not signals, is the binding constraint.

**Still open.**

1. The per-mint cap value (configurable; currently disabled).
2. Reconciliation isolation: the design requires it; the code still blocks all
   hiring on one stuck activation.
3. The dashboard/state contract: `activeTrader` → a roster list, and the
   `appState` derivation.
4. Per-leader loss-streak semantics on a roster.
5. Shared-pool first-come ordering and a minimum-headroom rule per hire.

## T5 — Retiring the research pipeline

> Became **D6** above. No open questions remain.
