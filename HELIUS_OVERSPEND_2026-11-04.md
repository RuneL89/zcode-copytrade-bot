# Helius credit overspend — postmortem (2026-11-04)

**Status at diagnosis:** ~930k of 1M monthly Helius credits used. The documented budget
(`zcode-bot/DECISIONS.md`, T-cost / T3 sections) promised **~16k/day ≈ 480k/month** for a
five-leader roster plus a twenty-wallet watch list. Two implementation-level deviations from
that design account for essentially all of the overspend. The server was stopped and the
wallet swept the same day; restart is deferred until the monthly credit reset.

---

## The promise (baseline for "what should have happened")

`DECISIONS.md` (T-cost):

> - Helius: watch ~5.8k/day + roster ~9.6k/day + qualification ~150/day ≈ **16k/day (~480k/month)**

And it explicitly priced the failure mode we ended up running:

> **Baseline cost.** A full `getTransactionsForAddress` poll every 36 s for one trader costs
> 10 credits = 24k/day (720k/month). The settled design is ~16k/day (~480k/month)…

D5 settled on **signature-first polling**: cheap `getSignaturesForAddress` per tick, full
transaction fetches only for unseen signatures ("transaction details on demand").

---

## Cause #1 (dominant): the roster monitor runs the exact full-poll anti-pattern the design doc warned about

- `monitor.pollAddress` (`apps/server/src/services/monitor.ts:280-304`) calls
  `helius.transactionsSince()` on **every roster tick** — no signature-first step.
- `transactionsSince` (`packages/providers/src/solana/helius.ts:264-284`) uses the
  Helius-exclusive Enhanced method **`getTransactionsForAddress` with
  `transactionDetails: 'full'`** — **10 credits per call**.
- Default cadence `ROSTER_POLL_MS = 45_000` (`packages/config/src/risk.ts:184`) →
  **1,920 ticks/day per seat**.

**Math at a full roster:**

```
5 seats × 1,920 ticks/day × 10 credits = ~96,000 credits/day
```

That is ~6× the *entire* promised daily budget (16k/day) from this one path alone. Reconstructed
roster burn since polling history begins (Oct 29, first audit event / first `provider_health`
sample): roughly **300–400k credits**.

**Why it happened:** implementation drift. The shipped monitor skipped the signature-first
half of D5; nothing asserted the promised call pattern, so a 10-credit call ran every 45 s per
chair silently.

## Cause #2: the watch list grew ~5× beyond plan (20 → 102 polled wallets)

- The day-trader rollout (commits `dfc4fb5`, `865e5ae`, Nov 2–3: activity-gated hires,
  stat-enriched snapshots, profitability ranking) admitted high-frequency day traders
  aggressively. As of 2026-11-04: **322 watch rows — 93 watching + 4 bench + 5 hired are
  polled; 194 archived; 26 cooling.**
- The watch pass polls **every watching + bench + hired wallet every `WATCH_POLL_MS`
  (300 s default)** — `apps/server/src/services/watch.ts:454-492`:

```
102 wallets × 288 passes/day = 29,376 signature pages/day (~1 credit each)
```

- On top of that, **every new signature of every watched wallet gets a full transaction fetch**
  (`watch.ts:495-517` → `txSummary`, `watch.ts:132-142`). Both the signature page and the
  summary try the free public RPC first and **fall back to paid Helius** whenever the public
  node throttles — which it does constantly at this volume.
- Day traders generate huge transaction volume; detected funded swaps exploded
  (**`watch_events` per day: Nov 2: 919 → Nov 3: 3,697 → Nov 4 (partial): 4,347**), and each of
  those required at least one fetch, plus every non-swap transaction in between.

**Estimated watch-path burn: ~30–60k/day vs the promised ~5.8k/day.**

## Minor burners (real but small)

| Path | Cadence | Cost |
|---|---|---|
| Provider health sampler (`runtime.ts:503`) | every 60 s, `getLatestBlockhash` | ~1.4k/day |
| Fee ledger scan (`runtime.ts:508`) | every 10 min + per own tx | small |
| Candidate activity refresh (`runtime.ts:512`) | periodic, public RPC first, Helius fallback | small |
| Discovery | every ~30 min on Nov 4 | **FOMO credits, not Helius** (875/run; 198,625 FOMO credits left — unaffected) |

## Amplifier, not a cause

Helius was 429-degraded **~66% of Nov 4** (1,455 degraded + 151 down of 2,445 one-minute
`provider_health` samples). The 429 storm is a symptom of hammering the plan's throughput
ceiling — and it caused the operational cascade of the day: prevaile's seat froze in
`REQUIRES_RECONCILIATION` because exit quotes kept failing before submission, leaving ELON
unsellable for 10 h and a chair blocked.

## Accounting note (honesty about the gap)

Bottom-up reconstruction from DB data covers ~400–600k credits since Oct 29; the dashboard
showed ~930k used. The remainder is most plausibly (a) spend that predates Oct 29 — the audit
trail starts there, and `DECISIONS.md` itself references a prior "single-trader full poll
(24k/day)" era — and/or (b) a higher public-RPC→Helius fallback rate than assumed in the
reconstruction. Not separately verifiable offline: `api.helius.dev` (usage API) was not
reachable from the workstation sandbox at diagnosis time.

## Fixes required before restart (in priority order)

1. **Make the roster monitor genuinely signature-first** (restore D5): cheap
   `getSignaturesForAddress` per tick; fetch full transactions only for unseen signatures —
   the watch path already does this correctly; copy that pattern into `monitor.pollAddress`.
   Restores the promised ~9.6k/day roster cost.
2. **Cap the watch list** (admission cap + eviction around the designed ~20) and/or slow
   `WATCH_POLL_MS`. Currently uncapped and growing.
3. **Guard exits against the paper executor** — `engine.executeExit` has no live-mode guard
   (only the entry path does, `engine.ts:355`): a disarmed "Close All" would paper-fill a live
   position. Found while unwinding.
4. **Retry gap:** a position left `open` with all exit intents `failed` and a summary
   recon case has no automated recovery (`retrySignaturelessCloses` only handles
   `requires_reconciliation`-status pairs; summary cases resolve only when the *whole wallet*
   is flat). This is what wedged prevaile's seat.
5. Optionally: move the health sampler to a free public endpoint or 5-min cadence.

## Actions taken on 2026-11-04 (all verified)

- Sold every open position through the engine's own live path (ELON −$2.72, MAMESUKE −$2.18,
  MONEROCHAN −$0.79); wallet flat.
- Swept **70.060317 USDC** to the operator's destination (tx
  `351HEbcnHrXtegnY83QvCWS8DA8yPZc4WAQnxB837FFS3xA3xPkyGnDpoHjiHNk2iiJgPVqy1hQyxtVqgVitb9ht`);
  0.0373 SOL remains as fee reserve.
- Server killed (port 8787 dead); "Copydesk watchdog" task **disabled**; Startup
  `Copydesk.lnk` and `ZCode Bot autostart.cmd` renamed to `*.paused` (a disarmed server still
  polls Helius, so auto-relaunch had to go too).
- Emergency stop persisted (`control.emergencyStopped=1`, `armed=0`); sealed wallet passphrase
  deliberately discarded — restart comes up disarmed, re-arm required.
- One-off scripts used: `apps/server/src/close-once.mts`, `apps/server/src/withdraw-once.mts`.
