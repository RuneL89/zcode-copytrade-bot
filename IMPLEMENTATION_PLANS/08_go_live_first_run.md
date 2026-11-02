# Plan 08 — Go live: the first real run (mini plan)

Status: NOT STARTED
Implements: D1–D6 end-to-end with real money (LIVE mode)
Depends on: 07

## /goal

Prove the whole pipeline on real money in one operator-attended session: the
server boots in LIVE mode and arms, discovery pulls accounts from the fomoapi
inlet, the watch list admits wallets, the shadow ledger fills, a chair is filled
from the promotion queue, the first **real buy** lands on chain, the first
**real sell** closes it (mirrored or via FIRE), the freed chair is replaced —
and every claim in this plan is backed by a signature, a database row, or an
audit line. No fabricated evidence anywhere.

This plan adds no trading logic. Any defect the run surfaces is fixed under its
own change and must keep every gate green (AC12).

## Safety frame (non-negotiable)

- Live transactions happen **only** in the operator-attended session below:
  the operator funds a dedicated wallet with a limited operating balance and
  types the confirmation string themselves. Never during tests, demos, or
  verification.
- The verifier is **read-only**: it never arms, never fires, never signs, never
  spends. It verifies the readiness code, the gates, and the evidence the
  session produced (rows, audit lines, recorded signatures).
- The `.env` caps (MIN/MAX_PER_BUY, MAX_POSITION, MAX_TOTAL_EXPOSURE,
  MAX_TRADES_PER_DAY, MAX_DAILY_REALIZED_LOSS) are the session's spending
  ceiling; the operator sets amounts they accept losing.
- Fail closed stands: an unpriced mint, missing quote, stale mark or broken RPC
  refuses; nothing is invented.

## Preconditions (operator, at the keyboard)

1. `.env`: `MODE=live`, `LIVE_TRADING_ACK` = the documented string,
   `FOMOAPI_KEY`, Helius key, Jupiter production endpoint + key.
2. A dedicated encrypted wallet (`pnpm wallet:create`) holding only a limited
   operating balance: USDC (sized to the caps) + a little SOL (fees and rent).
3. Dashboard user exists; no open reconciliation cases; emergency stop clear.
   Settings → **Live readiness & arming** lists every blocker; the server
   refuses to arm until all are green (AC1).

## The staged run

Each stage lists what must be visible afterwards. The session stays open until
stages 1–8 have all happened at least once.

1. **Boot in LIVE.** `launch.bat` (or Ops → _Restart server_). Evidence:
   `GET /api/state` reports `mode: 'live'`; the audit trail carries either
   `boot: wallet auto-unlocked — live arming restored` or the boot-disarm line
   with its reason; badges read LIVE only when armed **and** healthy.
2. **Accounts pulled.** Ops → _Sync discovery now_ (or the demand trigger).
   Evidence: the discovery audit line (windows, traders, new/updated, credits
   spent/left) and pool rows carrying wallets.
3. **Rostering (watch list).** Funded-buy scans admit wallets. Evidence:
   `watch_wallets.admitted_at` rows with funded-buy evidence; watch events
   deduped by signature; the watch panel shows SHADOW_LEDGER numbers.
4. **Shadow ledger.** Evidence: shadow trades opened at the D4 notional
   (`clamp(0.25×input, MIN, MAX)`, 1% per-side assumption in the PnL) and
   closed by the leader's sell or the age ceiling at a live Jupiter price.
5. **Hiring.** When a bench wallet clears the gate (K=8 closed, net > $3, a
   funded buy ≤ 4h, no re-entry ban, free chair, headroom) the promotion queue
   fills the chair. Evidence: an activation row with source `watch_promotion`,
   the roster seat in the dashboard, the audit line.
6. **First real buy.** The hired leader's next funded buy is copied. Evidence:
   a confirmed entry signature; intent → attempt → fill rows; an open position
   at the D1 notional within the caps; the fee ledger prices the transaction;
   the activity tape shows the copy.
7. **First real sell.** The leader's sell mirrors, or the operator fires the
   chair (`close_all_before_switch`). Evidence: a confirmed sell signature; the
   position closes; realized PnL recorded fee-net.
8. **Firing + replacement.** Evidence: the `firing_events` row names the real
   cause (loss streak / silence / stale buy / idle); the chair frees; the
   promotion queue refills it from the bench (an empty bench leaves it empty
   with the audit line — but the refill path itself must occur once).

## Acceptance criteria

- **AC1** — Arm refusal is real: with any readiness item red the arm attempt is
  refused with the blocker named and nothing is signed; with all green the
  documented ack + wallet secret arms the session (code path, Settings panel,
  and audit lines verified; the wrong-ack refusal is demonstrated harmlessly).
- **AC2** — The server starts in LIVE mode: `mode: 'live'`, arm state explicit
  (armed after boot-restore or disarmed with the reason), and the audit trail
  shows which happened. LIVE badges never appear disarmed or unhealthy.
- **AC3** — Discovery pulls accounts: a real run records windows, traders,
  new/updated counts and credit spend/remaining; a run inside the minimum
  interval is skipped with its reason and spends nothing.
- **AC4** — Rostering: ≥1 wallet admitted on funded-buy evidence, with
  signature-deduped watch events.
- **AC5** — Shadow ledger: ≥1 shadow trade opened at the D4 notional and closed
  (leader sell or ceiling) at a live price, with the 1%-per-side assumption
  riding in the PnL.
- **AC6** — Hiring: ≥1 chair filled from the promotion queue with the gate's
  verdict on record.
- **AC7** — First real buy: ≥1 confirmed on-chain entry signature from the live
  executor, with intent/attempt/fill rows, an open position, fee-ledger pricing,
  and cap compliance (no order above the configured ceilings).
- **AC8** — First real sell: ≥1 confirmed on-chain sell signature (mirror or
  FIRE), position closed, realized PnL fee-net.
- **AC9** — Firing + replacement: ≥1 fire with its real cause recorded and the
  chair refilled from the bench.
- **AC10** — Safety holds during the session: emergency stop blocks new entries
  (evidence), disarming stops signing, and no transaction is attempted while
  disarmed or unready.
- **AC11** — Every figure on the dashboard keeps its source and freshness
  labels; the session's claims map one-to-one to signatures/rows/audit lines.
- **AC12** — `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`
  and `pnpm e2e` pass on the final tree.
- **AC13** — No divergence from `DECISIONS.md` (D1 floor, D4 thresholds, D5
  cadence, D6 retirement; the board is never a gate, no invented numbers).

This plan **cannot be closed from code reading alone**: AC6–AC9 require
evidence produced by the operator session. Until it exists, the verdict is
NOT COMPLIANT with the missing stages named.

## Out of scope

- Unattended overnight trading; new strategies or parameters.
- Performance claims from a first session.
- Changing the live executor, sizing, or risk logic (fixes only, each with the
  gates re-run).

## Verification

Dispatch the verifier (`_VERIFIER_PROMPT.md`) with
`PLAN_PATH = IMPLEMENTATION_PLANS/08_go_live_first_run.md`.

The verifier must not arm, fire, sign, or spend. It verifies:

- AC1–AC2 and AC10 from code + the running server's readiness/state endpoints
  and the audit trail (read-only requests are fine; it never posts control
  routes);
- AC3–AC9, AC11 from the evidence the session produced: audit lines, intents,
  attempts, fills, positions, shadow trades, watch events, firing events, and
  the recorded signature strings. It may confirm a recorded signature against
  the free public Solana RPC (optional, read-only);
- AC12 by re-running the gates;
- AC13 against `DECISIONS.md` (D1–D6).
