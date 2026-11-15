# Copydesk counterfactual parameter sweep — 2026-11-15

> Read-only replay of historic evidence. **Nothing here was applied**; no trading
> parameter, order, wallet or live setting was changed. Paper fills are simulated.

- Source: `zcode-bot.db` (read-only copy)
- Data range: 2026-11-11T00:10:17.000Z → 2026-11-15T16:15:58.000Z (4.7 days)
- Split: train ends 2026-11-13T08:13:07.500Z; test follows
- Runtime: 0.1s; 61 run(s) evaluated, 0 alternative(s) shown

## Baseline (current parameters)

| Window | Net P&L | Trades | Win rate | Worst day | Max drawdown | Worst trade | Daily stop days |
| ------ | ------: | -----: | -------: | --------: | -----------: | ----------: | --------------: |
| Full   |   $0.00 |      0 |        — |     $0.00 |        $0.00 |       $0.00 |               0 |
| Train  |   $0.00 |      0 |        — |     $0.00 |        $0.00 |       $0.00 |               0 |
| Test   |   $0.00 |      0 |        — |     $0.00 |        $0.00 |       $0.00 |               0 |

### Baseline replay coverage

Signals 221; inside the run window 221; copied 0; not hired 221; coalesced 0; sized out 0; risk-blocked 0; stale 0.

## Top alternatives by test-half net P&L

Ranked out-of-sample (test half). A positive train and test half is required for the
`robust` flag; a run with fewer than 3 test trades is never flagged robust.

No run produced a trade on this history, so there is no meaningful ranking. The empty baseline above is the whole result; this is a data-coverage outcome, not a winner.

## Hiring alternatives

Alternate bench wallets were picked at the real seat-open moments under the run's promotion
bars and ranking, then held for the real seat tenure.

| Policy | Ranking       | Risk  | Test net | Full net | Hires that would earn more |
| ------ | ------------- | ----- | -------: | -------: | -------------------------: |
| shadow | net           | MIXED |    $0.00 |    $0.00 |                        0/9 |
| shadow | net_per_trade | MIXED |    $0.00 |    $0.00 |                        0/9 |
| shadow | win_rate      | MIXED |    $0.00 |    $0.00 |                        0/9 |
| shadow | recent        | MIXED |    $0.00 |    $0.00 |                        0/9 |

### Largest hire deltas (best alternate ranking)

| Seat | Window open              | Actual hire       | Alternative       | Actual net | Alternative net | Delta |
| ---: | ------------------------ | ----------------- | ----------------- | ---------: | --------------: | ----: |
|    5 | 2026-11-15T06:10:31.034Z | coinpumper        | heat              |      $0.00 |           $0.00 | $0.00 |
|    5 | 2026-11-15T04:34:04.800Z | waalow            | waalow            |      $0.00 |           $0.00 | $0.00 |
|    4 | 2026-11-15T02:10:58.993Z | VastPastViper     | VastPastViper     |      $0.00 |           $0.00 | $0.00 |
|    3 | 2026-11-15T02:10:58.992Z | LoyalBlankPerch   | LoyalBlankPerch   |      $0.00 |           $0.00 | $0.00 |
|    5 | 2026-11-14T22:54:39.231Z | jaeescott20       | jaeescott20       |      $0.00 |           $0.00 | $0.00 |
|    4 | 2026-11-14T22:54:39.230Z | Jmart0312         | Jmart0312         |      $0.00 |           $0.00 | $0.00 |
|    3 | 2026-11-14T22:54:39.229Z | aurafarmer_       | aurafarmer_       |      $0.00 |           $0.00 | $0.00 |
|    2 | 2026-11-14T22:09:16.070Z | JESUSISTHEWAYLOVE | JESUSISTHEWAYLOVE |      $0.00 |           $0.00 | $0.00 |

## Baseline replay match

No paper positions in this DB copy; entry/exit match is 0/0 (not applicable).

## Calibration

- Entry slippage: 0 bps applied; 0 paper/leader pair(s).
- Exit slippage: 30 bps; fee: 5 bps; delay: 2s.
- No paper fill could be paired with a leader print; entry slippage uses the fallback.
- Exit slippage is not observable in the DB (no pre-exit mark); it stays the paper 30 bps assumption.
- Pool depth / price impact per trade is not stored; slippage is a flat calibrated bps.

## Data coverage

| Evidence                                                |                                   Count |
| ------------------------------------------------------- | --------------------------------------: |
| Shadow trade rows / groups / replayed signals           |                         230 / 221 / 221 |
| Shadow groups without an exact watch-buy match          |                                       0 |
| Paper positions / replayed signals / missing leader buy |                               0 / 0 / 0 |
| Activations / hire windows                              |                                   9 / 9 |
| Paper fills / realized lots                             |                                   0 / 0 |
| Candidates in the DB                                    |                                    1028 |
| Operator SOL fee ledger                                 | 34,000 lamports (excluded from USD P&L) |

## Data gaps

- No paper positions in this DB copy; baseline replay match is not applicable.
- The baseline copied no trade: the watch list stops shadowing a hired wallet, so in-seat shadow buys are usually absent, and this DB copy has no paper fills to supply them. That is a coverage result, not a simulator failure.
- The test half has 0 baseline trade(s); out-of-sample ranking is thin.
- No run produced a trade on this history, so the grid has nothing to rank; the empty baseline is reported instead of an arbitrary winner.

## Assumptions

- The DB stores the leader entry and exit, never intra-trade marks; the replay walks a linear price path between them at 1-minute steps.
- A leader exit inside the run window is mirrored; a shadow code exit or paper close is only a last-known mark (path end), so an alternate rule is not forced to obey it.
- A leader exit after the run window is not used (no future price); the position is marked at its entry price and reported open.
- The historical risk config is not stored; the baseline is the current config supplied to the sweep.
- Copy delay shifts the entry time, but the path starts at the leader print; no separate delay price impact is stored.
- Price and leaderboard freshness gates see age 0 because the DB does not store historic quote/leaderboard ages; quote-impact gates are not evaluated.
- Max drawdown and worst day are realized-PnL measures plus the final open mark, not intra-trade mark-to-market.
- Alternate hires use the real seat-open times and seat tenure; a different hire would have changed future firing times.
- A hired wallet stops being shadowed, so the actual hire has no in-seat shadow signal while an alternate bench wallet may have one. Hiring comparisons are indicative, not like-for-like P&L.
- Signals are watch-list shadow buys plus paper fills; a live seat with neither contributes no baseline trade.
- No provider calls, no live trading, no parameter application. Slippage/fees are flat calibrated bps, not a pool-depth model.
- MAX_POSITION_AGE_HOURS=8760 in the default grid is the practical "none" value (one year); it is not infinite.
- Seat tenure is pinned to the historic activations: roster size and idle-fire values have no mechanical effect here; cooldown and promotion bars can change alternative hires.
- Fees paid in SOL are excluded from USDC P&L; paper fills are simulated and labeled PAPER.

## Suggested next step

Review the top test-half run and its neighbours with Copytrader. Any parameter change is a
separate, explicit operator action; this report never applies one.
