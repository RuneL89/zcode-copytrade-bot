# GUI reading tools (Fomo leaderboard)

These two PowerShell scripts implement Stage 0 and Stage 1 of the day-trader
funnel described in `docs/FOMO_DAWN_FETCHING.md`.

**Hard policy:** fomo.family is only ever read through the operator's normal
desktop Chrome. These scripts do not launch a browser, do not log in, and do
not touch any credential. They only click a leaderboard row / a profile's stats
line and read the clipboard.

| Script              | Stage | Reads                                         | Writes         |
| ------------------- | ----- | --------------------------------------------- | -------------- |
| `board-pass.ps1`    | 0     | visible leaderboard rows (rank + profile URL) | `board.json`   |
| `profile-stats.ps1` | 1     | profile stats line (avg. hold, trades)        | `entries.json` |

Then import with the server CLI:

```powershell
cd zcode-bot\apps\server
pnpm exec tsx src/cli/fomo-import.ts C:\temp\fomo-entries.json
```

## Why clipboard, not OCR

Earlier runs derived profile slugs from screenshots and produced wrong
identifiers (`econcar` vs the real `econoar`, `monke3655` vs `monke365`,
`FarmanSeska` vs the real `FartmanSacks`). A wrong slug silently returns a
different trader's wallet from Dawn. Every identifier in these scripts comes
from the clipboard, and anything that does not validate is skipped with a
warning rather than guessed.

## Calibration (once per display / zoom level)

Both scripts assume 100% browser zoom (`Ctrl+0`) and these screen heights:

- leaderboard rows: `610, 663, 717, 770, 823, 877, 930` (7 visible rows)
- profile stats line: `y = 437`

Verify with a screenshot, then pass `-RowYs` / `-StatsY` if your layout
differs. Rows are validated by content, so a wrong height only skips a row —
it never writes bad data.

## What each field feeds

- `handle` / `profileUrl` → the Dawn lookup (canonical URL is the trader-card trigger)
- `avgHoldHours`, `trades7d` → day-trader qualification in the research snapshot
- PnL per period and on-chain activity are **not** captured here: Dawn's compact
  card supplies PnL (24h/7d/30d/all-time) and the Helius activity refresh
  supplies `swaps24h` / `lastSwapAt`.
