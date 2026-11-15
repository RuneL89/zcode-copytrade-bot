# docs/

## Purpose

Operator-facing documentation: how to install and run the bot, how to recover
it and operate the roster, and the canonical _fallback_ procedure for reading
leaderboard/profile data out of the operator's desktop Chrome.

## Ownership

- `FOMO_DAWN_FETCHING.md` — canonical, operator-verified procedure for FOMO
  leaderboard refresh and Dawn wallet resolution. Explicitly "law".
- `ZCODE_AUTOMATION.md` — retirement note: the MCP + scheduled-research
  contract is gone with D6; admission is the deterministic D3/D4 path.
- `RUNBOOK.md` — everyday startup, pause/resume, emergencies, restart recovery,
  reconciliation, live arming, backups, troubleshooting, provider plan
  decisions, and the read-only counterfactual parameter sweep.
- `GETTING_STARTED.md` — the short "what do I do now" onboarding.
- `GROK-BOT.md` — the operator-facing account of Copytrader's role: the
  30-minute health and credit watch, hire review, tighten-only exits, the
  ZCode mailbox and model ladder, the deploy path, and the hard limits.
- `research-sweep-automation.md` — retirement note: the 5-minute research
  tick and the 30-minute sweep are gone (D3/D6); discovery is demand-driven.

## Local Contracts

- **Procedure docs are contracts, not suggestions.** `FOMO_DAWN_FETCHING.md`
  reflects operator-verified steps; do not "optimize", reorder, or relax them
  without the operator confirming a new procedure. The same applies to the
  confirmation strings in `RUNBOOK.md`.
- **Never put secrets in docs.** No keys, tokens, seed phrases, session cookies,
  or real wallet addresses. Placeholders only.
- **Commands must match `package.json`.** Every `pnpm …`, `.bat`, or CLI
  invocation in a doc is verified against the root or package scripts.
- **State what the system cannot do** as plainly as what it can: demo/paper are
  not returns; emergency stop cannot recall submitted transactions; an empty
  roster chair is normal, not a fault.
- **When behavior changes, docs change in the same commit** — especially live
  arming strings, readiness items, the D4 thresholds, and env variable names.

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
