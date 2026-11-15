# Copydesk counterfactual parameter sweep — 2026-11-15

> Read-only replay of historic evidence. **Nothing here was applied**; no trading
> parameter, order, wallet or live setting was changed. Paper fills are simulated.

- Source: `zcode-bot-before-paper-reset-20261115-095433.db` (read-only copy)
- Data range: 2026-11-11T00:10:17.000Z → 2026-11-15T07:18:25.000Z (4.3 days)
- Split: train ends 2026-11-13T03:44:21.000Z; test follows
- Runtime: 0.3s; 61 run(s) evaluated, 10 alternative(s) shown

## Baseline (current parameters)

| Window | Net P&L | Trades | Win rate | Worst day | Max drawdown | Worst trade | Daily stop days |
| ------ | ------: | -----: | -------: | --------: | -----------: | ----------: | --------------: |
| Full   |   $0.81 |      2 |     100% |     $0.82 |        $0.00 |       $0.82 |               0 |
| Train  |   $0.00 |      0 |        — |     $0.00 |        $0.00 |       $0.00 |               0 |
| Test   |   $0.81 |      2 |     100% |     $0.82 |        $0.00 |       $0.82 |               0 |

### Baseline replay coverage

Signals 173; inside the run window 173; copied 2; not hired 171; coalesced 0; sized out 0; risk-blocked 0; stale 0.

## Top alternatives by test-half net P&L

Ranked out-of-sample (test half). A positive train and test half is required for the
`robust` flag; a run with fewer than 3 test trades is never flagged robust.

|   # | Change                                                                 | Risk    | Train net | Test net | Full net | Trades | Win rate | Worst day | Max DD | Worst trade | Daily stop days | Robust |
| --: | ---------------------------------------------------------------------- | ------- | --------: | -------: | -------: | -----: | -------: | --------: | -----: | ----------: | --------------: | ------ |
|   1 | MAX_PER_BUY_USD=40                                                     | LOOSENS |     $0.00 |    $1.77 |    $1.77 |      2 |     100% |     $1.78 |  $0.00 |       $1.78 |               0 | no     |
|   2 | MAX_PER_BUY_USD=20                                                     | LOOSENS |     $0.00 |    $1.64 |    $1.64 |      2 |     100% |     $1.64 |  $0.00 |       $1.64 |               0 | no     |
|   3 | MAX_PER_BUY_USD=20 + MAX_OPEN_PER_TRADER_USD=80 + MAX_DEPLOYED_PCT=100 | LOOSENS |     $0.00 |    $1.64 |    $1.64 |      2 |     100% |     $1.64 |  $0.00 |       $1.64 |               0 | no     |
|   4 | MAX_POSITION_AGE_HOURS=12                                              | LOOSENS |     $0.00 |    $0.92 |    $0.92 |      2 |     100% |     $0.92 |  $0.00 |       $0.92 |               0 | no     |
|   5 | MAX_POSITION_AGE_HOURS=8                                               | LOOSENS |     $0.00 |    $0.92 |    $0.92 |      2 |     100% |     $0.92 |  $0.00 |       $0.92 |               0 | no     |
|   6 | MAX_POSITION_AGE_HOURS=8760                                            | LOOSENS |     $0.00 |    $0.92 |    $0.92 |      2 |     100% |     $0.92 |  $0.00 |       $0.92 |               0 | no     |
|   7 | COOLDOWN_HOURS=12                                                      | MIXED   |     $0.00 |    $0.82 |    $0.82 |      1 |     100% |     $0.82 |  $0.00 |       $0.82 |               0 | no     |
|   8 | COOLDOWN_HOURS=24                                                      | MIXED   |     $0.00 |    $0.82 |    $0.82 |      1 |     100% |     $0.82 |  $0.00 |       $0.82 |               0 | no     |
|   9 | COOLDOWN_HOURS=72                                                      | MIXED   |     $0.00 |    $0.82 |    $0.82 |      1 |     100% |     $0.82 |  $0.00 |       $0.82 |               0 | no     |
|  10 | hiring=net                                                             | MIXED   |     $0.00 |    $0.82 |    $0.82 |      1 |     100% |     $0.82 |  $0.00 |       $0.82 |               0 | no     |

### Top alternative detail: MAX_PER_BUY_USD=40

| Window | Net P&L | Trades | Win rate | Worst day | Max drawdown | Worst trade | Daily stop days |
| ------ | ------: | -----: | -------: | --------: | -----------: | ----------: | --------------: |
| Full   |   $1.77 |      2 |     100% |     $1.78 |        $0.00 |       $1.78 |               0 |
| Train  |   $0.00 |      0 |        — |     $0.00 |        $0.00 |       $0.00 |               0 |
| Test   |   $1.77 |      2 |     100% |     $1.78 |        $0.00 |       $1.78 |               0 |

- Fewer than 3 test trades; treat the out-of-sample result as thin.
- Train and test P&L do not agree in sign.

## Robustness: neighbouring grid values

| Change                      | Neighbour                   | Neighbour test net | Test trades |
| --------------------------- | --------------------------- | -----------------: | ----------: |
| MAX_PER_BUY_USD=40          | MAX_PER_BUY_USD=20          |              $1.64 |           2 |
| MAX_PER_BUY_USD=20          | MAX_PER_BUY_USD=40          |              $1.77 |           2 |
| MAX_POSITION_AGE_HOURS=12   | MAX_POSITION_AGE_HOURS=8    |              $0.92 |           2 |
| MAX_POSITION_AGE_HOURS=12   | MAX_POSITION_AGE_HOURS=8760 |              $0.92 |           2 |
| MAX_POSITION_AGE_HOURS=8    | MAX_POSITION_AGE_HOURS=12   |              $0.92 |           2 |
| MAX_POSITION_AGE_HOURS=8760 | MAX_POSITION_AGE_HOURS=12   |              $0.92 |           2 |
| COOLDOWN_HOURS=12           | COOLDOWN_HOURS=24           |              $0.82 |           1 |

## Hiring alternatives

Alternate bench wallets were picked at the real seat-open moments under the run's promotion
bars and ranking, then held for the real seat tenure.

| Policy | Ranking       | Risk  | Test net | Full net | Hires that would earn more |
| ------ | ------------- | ----- | -------: | -------: | -------------------------: |
| shadow | net           | MIXED |    $0.82 |    $0.82 |                        1/9 |
| shadow | net_per_trade | MIXED |    $0.00 |    $0.00 |                        1/9 |
| shadow | win_rate      | MIXED |    $0.00 |    $0.00 |                        1/9 |
| shadow | recent        | MIXED |    $0.00 |    $0.00 |                        1/9 |

### Largest hire deltas (best alternate ranking)

| Seat | Window open              | Actual hire       | Alternative       | Actual net | Alternative net |  Delta |
| ---: | ------------------------ | ----------------- | ----------------- | ---------: | --------------: | -----: |
|    5 | 2026-11-15T06:10:31.034Z | coinpumper        | heat              |     -$0.00 |           $0.00 | +$0.00 |
|    5 | 2026-11-15T04:34:04.800Z | waalow            | waalow            |      $0.00 |           $0.00 |  $0.00 |
|    4 | 2026-11-15T02:10:58.993Z | VastPastViper     | VastPastViper     |      $0.00 |           $0.00 |  $0.00 |
|    3 | 2026-11-15T02:10:58.992Z | LoyalBlankPerch   | LoyalBlankPerch   |      $0.00 |           $0.00 |  $0.00 |
|    5 | 2026-11-14T22:54:39.231Z | jaeescott20       | jaeescott20       |      $0.00 |           $0.00 |  $0.00 |
|    4 | 2026-11-14T22:54:39.230Z | Jmart0312         | Jmart0312         |      $0.00 |           $0.00 |  $0.00 |
|    3 | 2026-11-14T22:54:39.229Z | aurafarmer_       | aurafarmer_       |      $0.00 |           $0.00 |  $0.00 |
|    2 | 2026-11-14T22:09:16.070Z | JESUSISTHEWAYLOVE | JESUSISTHEWAYLOVE |      $0.00 |           $0.00 |  $0.00 |

## Baseline replay match

1/2 entries match exact input; 1/1 exit rules match the historic close; 0/1 exit P&L values match within 10% or $0.25 (and close times within 2h).

| Position | Handle         | Actual input | Replay input | Match | Actual close | Replay exit    | Actual net | Replay net | Exit rule | Exit P&L |
| -------- | -------------- | -----------: | -----------: | ----- | ------------ | -------------- | ---------: | ---------: | --------- | -------- |
| WASTED   | VocalNavalPony |       $20.00 |       $10.00 | no    | time_exit    | max_hold_green |      $2.22 |      $0.82 | yes       | no       |
| OMNI     | coinpumper     |        $6.25 |        $6.25 | yes   | open         | open           |          — |     -$0.00 | no        | no       |

- WASTED: Replay input $10.00 vs actual $20.00; a historic risk config or a quote difference can explain it. Exit rule matched (max_hold_green); P&L differs by -$1.40 because size/price inputs differ.

## Calibration

- Entry slippage: 0 bps applied (raw -164 bps); 2 paper/leader pair(s).
- Exit slippage: 30 bps; fee: 5 bps; delay: 2s.
- Paper fills were 164 bps better than the leader's print; the replay applies 0 adverse entry slippage, which is conservative.
- Exit slippage is not observable in the DB (no pre-exit mark); it stays the paper 30 bps assumption.
- Pool depth / price impact per trade is not stored; slippage is a flat calibrated bps.

## Data coverage

| Evidence                                                |                                   Count |
| ------------------------------------------------------- | --------------------------------------: |
| Shadow trade rows / groups / replayed signals           |                         180 / 171 / 171 |
| Shadow groups without an exact watch-buy match          |                                       0 |
| Paper positions / replayed signals / missing leader buy |                               2 / 2 / 0 |
| Activations / hire windows                              |                                   9 / 9 |
| Paper fills / realized lots                             |                                   4 / 1 |
| Candidates in the DB                                    |                                     716 |
| Operator SOL fee ledger                                 | 34,000 lamports (excluded from USD P&L) |

## Data gaps

- Only 2 paper position(s); the baseline similarity is a thin sample.
- The test half has 2 baseline trade(s); out-of-sample ranking is thin.
- 1 baseline entry input(s) differ from the real paper fill; a historic risk config or execution quote is the likely cause.

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
