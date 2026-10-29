# docs/

## Purpose

Operator-facing documentation: how to install and run the bot, how to recover
it, how ZCode research is wired, and the canonical procedure for reading
leaderboard/profile data out of the operator's desktop Chrome.

## Ownership

- `FOMO_DAWN_FETCHING.md` — canonical, operator-verified procedure for FOMO
  leaderboard refresh and Dawn wallet resolution. Explicitly "law".
- `ZCODE_AUTOMATION.md` — the MCP + scheduled-research contract: tool list,
  workspace config, task prompt, verification, and the JSON fallback.
- `RUNBOOK.md` — everyday startup, pause/resume, emergencies, restart recovery,
  reconciliation, live arming, backups, troubleshooting, and provider plan
  decisions.
- `GETTING_STARTED.md` — the short "what do I do now" onboarding.
- `research-sweep-automation.md` — the exact CronCreate recipe for the hourly
  research sweep, currently paused.

## Local Contracts

- **Procedure docs are contracts, not suggestions.** `FOMO_DAWN_FETCHING.md`
  reflects operator-verified steps; do not "optimize", reorder, or relax them
  without the operator confirming a new procedure. The same applies to the
  exact task prompt and confirmation strings in `ZCODE_AUTOMATION.md` and
  `RUNBOOK.md`.
- **Never put secrets in docs.** No keys, tokens, seed phrases, session cookies,
  or real wallet addresses. Placeholders only.
- **Commands must match `package.json`.** Every `pnpm …`, `.bat`, or CLI
  invocation in a doc is verified against the root or package scripts.
- **State what the system cannot do** as plainly as what it can: demo/paper are
  not returns; emergency stop cannot recall submitted transactions; ZCode is
  research only, never the runtime.
- **When behavior changes, docs change in the same commit** — especially live
  arming strings, readiness items, MCP tool lists, and env variable names.

## Work Guidance

- Prefer concrete commands and expected output over prose.
- Keep the RUNBOOK symptom→action table current; it is the first place an
  operator looks during an incident.
- Link to the single authoritative doc instead of restating a procedure in two
  places (deduplication is deliberate here).

## Verification

- Read the edited procedure end to end against the code path it describes.
- Re-run any command you changed, or state that you could not.
- `pnpm format:check` covers markdown formatting.

## Child DOX Index

None.
