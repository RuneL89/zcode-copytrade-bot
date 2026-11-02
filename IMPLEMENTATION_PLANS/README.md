# Implementation plans — ZCode Bot

These plans turn `../DECISIONS.md` into sequenced, verifiable work. **`DECISIONS.md`
is the Bible**: every plan implements specific decision IDs, and any implementation
that contradicts it is a hard failure, not a judgement call.

## Sequence

Each plan depends on the previous one. Do not start a plan until its predecessor
has passed compliance.

| #   | Plan                             | Implements                                          | Depends on |
| --- | -------------------------------- | --------------------------------------------------- | ---------- |
| 01  | `01_sizing_floor.md`             | D1                                                  | —          |
| 02  | `02_foundation_schema_config.md` | D4 thresholds, D3/D5 storage                        | 01         |
| 03  | `03_discovery_inlet.md`          | D3, D5 (demand trigger)                             | 02         |
| 04  | `04_watchlist_shadow.md`         | D4 (watch list, shadow ledger, promotion, re-entry) | 03         |
| 05  | `05_roster_copying.md`           | D4 (capital rules), T4 (roster)                     | 04         |
| 06  | `06_runtime_retire_research.md`  | D5 (cadence), D6 (retirement)                       | 05         |
| 07  | `07_pipeline_dashboard.md`       | Pipeline dashboard redesign, dark + light parity    | 06         |
| 08  | `08_go_live_first_run.md`        | D1–D6 on real money: the first live session         | 07         |

Plan 08 is a **mini plan with operator-attended acceptance**: its AC6–AC9 are
proven by an on-chain session the operator runs at the keyboard (limited
balance, explicit arming). The verifier stays read-only and checks the evidence
the session produced — it never arms, fires, signs, or spends.

## The compliance loop (mandatory)

A plan is **not done** when the code is written. It is done when a verifier
sub-agent returns `COMPLIANT` on every acceptance criterion.

1. **Implement.** Work through the plan in the main chat. Update the plan's status
   line to `IMPLEMENTED` when you believe every criterion is met.
2. **Dispatch the verifier.** Spawn ONE sub-agent with the prompt in
   `_VERIFIER_PROMPT.md`, filling in the plan path. The verifier is read-only:
   it inspects code, runs the gates, renders UI, and checks every AC.
3. **Read the verdict.** The verifier returns a table `AC id | PASS/FAIL | evidence`,
   a `DIVERGENCES` section (any deviation from `DECISIONS.md`), and a final
   `COMPLIANT` / `NOT COMPLIANT`.
4. **Loop on failure.** If anything is `FAIL`, the feedback comes back to the main
   chat. Fix it, then dispatch the verifier again **with the same prompt**. Repeat
   until every AC passes and `DIVERGENCES` is empty.
5. **Close.** Only then set the plan status to `COMPLIANT` and move to the next.

Rules for the loop:

- Never weaken, delete, or skip an acceptance criterion to make it pass. If a
  criterion is genuinely wrong, change the plan and `DECISIONS.md` first, and say
  why.
- A divergence from `DECISIONS.md` is a hard fail even if every AC passes.
- The verifier does not fix anything and does not edit files. It only reports.
- Every fix round produces a new verifier run; there is no "trust me" close.

## Status lines

Each plan starts with:

```
Status: NOT STARTED | IN PROGRESS | IMPLEMENTED | COMPLIANT
```

`IMPLEMENTED` means the main chat believes it is done. `COMPLIANT` is only set
after a verifier pass.

## Gates used by every plan

Run from `zcode-bot/`:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Plus `pnpm e2e` where the plan changes the dashboard or a user-visible state.
Plans may add narrower commands; they never remove a gate.
