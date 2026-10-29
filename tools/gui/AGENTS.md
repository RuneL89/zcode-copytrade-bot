# tools/gui/

## Purpose

PowerShell helpers that implement Stage 0 and Stage 1 of the day-trader funnel:
read visible leaderboard rows and a profile's stats line out of the operator's
own desktop Chrome via clicks plus the clipboard, then hand the result to the
server's import CLI.

## Ownership

- `board-pass.ps1` — clicks leaderboard rows, copies each profile URL, writes
  `board.json` (rank + URL).
- `profile-stats.ps1` — opens each profile's stats line, copies it, writes
  `entries.json`.
- `README.md` — calibration and the clipboard-not-OCR rationale.

## Local Contracts

- **No browser launching, no login, no credentials.** These scripts operate the
  window the operator already has open. They never start Playwright/Chrome with
  a copied profile and never touch stored sessions.
- **Clipboard, never OCR.** Every identifier is copied and validated. A value
  that fails validation is skipped with a warning — never guessed, normalized,
  or reconstructed from a screenshot. Wrong slugs silently resolve to another
  trader's wallet.
- **fomo.family is only read through the operator's normal desktop Chrome.**
  This is the workspace-level policy in `../AGENTS.md`; scripts that violate it
  must not be added.
- **Fixed default outputs, no database writes.** `board-pass.ps1` defaults to
  `$env:TEMP\fomo-board.json` and `profile-stats.ps1` to
  `$env:TEMP\fomo-entries.json`; both accept `-OutFile`. The scripts never
  write into `zcode-bot/data/` — import is the server CLI's job.
- **Calibration is per display/zoom.** Row and stats Y-coordinates assume 100%
  zoom and are overridable via `-RowYs` / `-StatsY`; content validation is the
  real guard, so a wrong height skips a row rather than writing bad data.
- **No PnL or activity collection here.** PnL comes from the Dawn compact card
  and swaps from the Helius activity refresh; do not invent extra fields.

## Work Guidance

- Keep the scripts pure UI-drivers: parse → validate → write JSON. Import and
  database work belongs to `apps/server/src/cli/fomo-import.ts`.
- Any new selector or coordinate must be verified against a live screenshot
  first and documented in `README.md`.
- Follow the pacing and verification steps in
  `docs/FOMO_DAWN_FETCHING.md`; the scripts are Stage 0/1 only.

## Verification

- Run the script against a visible leaderboard and confirm every row it emits
  has a clipboard-matching profile URL.
- Confirm skipped rows are reported as warnings, not silently dropped.
- After import, verify the candidate list in the dashboard/audit trail.

## Child DOX Index

None.
