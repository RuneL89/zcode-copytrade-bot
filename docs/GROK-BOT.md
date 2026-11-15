# Grok Bot integration (Copytrader)

This document explains how **Copytrader**, Rune's Grok Bot assistant, works with Copydesk: what it does, when, where, how, and why. It's written for Rune and for any human or AI agent that touches this folder.

Last updated: 2026-11-15.

---

## 1. Who is who

| Role                      | Who                                                    | Does                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                     | Rune                                                   | Makes decisions, merges PRs, funds the wallet, turns on live trading                                                                                  |
| Project manager / on-call | Copytrader (Grok Bot)                                  | Monitors, deploys, triages, picks hires, briefs Rune                                                                                                  |
| Builder                   | **ZCode** on this PC (headless), briefed by Copytrader | Writes all code changes on a branch in `Documents\projects\copydesk-dev`, pushes, and Copytrader opens a PR on github.com/RuneL89/zcode-copytrade-bot |
| Worker                    | Copydesk server on this PC                             | The deterministic copy engine: watch, size, quote, sign, send, exit                                                                                   |

**The core principle:** the worker decides and acts on its own each tick, based on fixed rules. Copytrader adds judgement around it, never inside the trade path. Copytrader **never signs transactions or places orders**.

---

## 2. What Copytrader does

1. **Health monitoring.** Copytrader checks that the server, watchdog and credit-guard are running and that the API answers on `127.0.0.1:8787`. If something is down, it reads the logs, fixes obvious causes, and restarts the desk through the service script.
2. **Credit budgeting.** The Helius free tier gives 1M credits a month, and the old setup burned through that in days.
   - Copytrader watches the daily projection against a hard cap of **13.6k credits/day**. The design target is about 2–6k/day.
   - If the projection goes over the cap or 429s spike, it stops the worker immediately.
   - It also keeps Fomo API usage modest (250k credits a month).
3. **Desk oversight.** It reviews the traders discovered, the seats filled, paper/live fills, open positions, P&L, exits firing, and any stuck seats.
4. **Hiring decisions.** When a seat opens, Copytrader picks the trader to hire. Rune is notified and can overrule.
5. **Exit tightening (agentic layer).** Copytrader may _tighten_ an exit, for example by cutting a position early, but never loosen one. The hard rules always apply: 5h max hold, −25% stop, and a trailing stop.
6. **Build management.** Copytrader turns bugs and issues into briefs for ZCode, runs ZCode headless in `copydesk-dev` on a feature branch, checks the tests and diff, pushes the branch and opens a PR.
   - After **Rune** merges to `main`, Copytrader deploys: it backs up the DB, pulls, installs, builds, restarts, then re-measures credits for about 15 minutes and rolls back if they run over budget.
   - It never edits repo code by hand.
7. **Reporting.** Copytrader keeps a running log and sends Rune a morning status.

---

## 3. When

| When (Helsinki time)  | What                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every 30 min, all day | Routine **"Copydesk watch (every 30 min)"** runs health, credit, desk and build checks, and writes one entry to `logs/pm-log.md`                                    |
| 06:15–06:45           | **"Good morning"** message with one unified status of the night                                                                                                     |
| 23:00–06:15           | Quiet hours: no messages unless the desk is down and can't be recovered, or the credit guard tripped                                                                |
| Daytime               | Copytrader messages Rune only for something he'd want right away: the desk down, the budget guard tripped, a PR ready for review, or a hire he may want to overrule |
| On demand             | Whenever Rune asks in the Grok Bot chat (phone or desktop)                                                                                                          |

---

## 4. Where

| Thing                           | Location                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desk, live (this folder)        | `C:\Users\atavi\Documents\projects\copydesk`. Moved here on 2026-11-15 from `C:\Users\atavi\copydesk`, which no longer exists                     |
| Dev checkout (ZCode works here) | `C:\Users\atavi\Documents\projects\copydesk-dev`                                                                                                  |
| ZCode launcher                  | `C:\Users\atavi\.zcode\grokbot-cli\zc.ps1`                                                                                                        |
| Logs                            | `logs\` (server log, Helius/Fomo credit logs, credit-guard, `pm-log.md`)                                                                          |
| Database                        | `data\` (SQLite; backups in `data\backups\` before every deploy)                                                                                  |
| Secrets                         | `C:\Users\atavi\.copydesk-secrets\` (ACL: Rune's Windows user only). Holds the encrypted wallet keystore and API keys. **Never commit or share.** |
| Dashboard                       | `http://127.0.0.1:8787` (Tailscale for phone access is planned)                                                                                   |
| Code                            | github.com/RuneL89/zcode-copytrade-bot, branch `main`                                                                                             |
| Trading wallet                  | The dedicated Solana hot wallet, with its address kept in the operator's local records and never in this document                                 |
| Copytrader's old copy           | `/home/box/copydesk` on Copytrader's own cloud computer. **Deliberately stopped**, because two desks would double Helius usage                    |

---

## 5. How

- **Access.** Copytrader runs PowerShell commands on this PC through the Grok Bot desktop app. This needs:
  - the Grok Bot app running and signed in;
  - Settings → Computer → "Execution on this computer" allowed;
  - the PC awake, with sleep set to Never on AC.

  If the app is closed or the PC is offline, Copytrader can't reach it, **but the desk keeps running on its own**.

- **Service control** (from anywhere):
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\atavi\Documents\projects\copydesk\scripts\copydesk-service.ps1 start
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\atavi\Documents\projects\copydesk\scripts\copydesk-service.ps1 stop
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\atavi\Documents\projects\copydesk\scripts\copydesk-service.ps1 status
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\atavi\Documents\projects\copydesk\scripts\copydesk-service.ps1 restart
  ```
- **Auto-start.** The Startup shortcut `Copydesk start.lnk` (hidden window) starts the desk when you log on. For a start at boot plus restart on crash, run this once in PowerShell **as administrator**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File C:\Users\atavi\Documents\projects\copydesk\scripts\install-copydesk-task.ps1
  ```
- **Supervisor and credit-guard.** A supervisor restarts the server if it dies, and a credit-guard stops the desk if Helius projects over 13.6k credits/day or 429s storm. Both are started by the service script.
- **Secrets** are moved by file between Copytrader's computer and this PC, or entered through masked inputs in the Grok Bot chat. They are never pasted into chat and never printed in logs.
- **Code changes (Copytrader + ZCode):**
  1. **Default route: the mailbox** (see "ZCode automation mailbox" below). Copytrader drops a brief with `zc-post.ps1`, Rune's ZCode automation in the CopyDesk project picks it up, and the whole run shows up in the ZCode app.
     **Fallback for urgent work:** Copytrader runs ZCode's headless CLI through the launcher at `C:\Users\atavi\.zcode\grokbot-cli\zc.ps1`. Those runs don't show in the app. Only use it when `mailbox\working\` is empty, so the two never edit `copydesk-dev` at once:
     ```powershell
     powershell -File $env:USERPROFILE\.zcode\grokbot-cli\zc.ps1 -Prompt "<brief>" -Cwd C:\Users\atavi\Documents\projects\copydesk-dev -Mode build   # model picked from ladder.json, see the handshake section below
     ```
     The launcher wraps ZCode's `resources\glm\zcode.cjs`. It exists because the bundled CLI can't find its provider config when started from outside the app, and it refreshes that config from the install on every run.
  2. ZCode works on a feature branch in **`copydesk-dev`**, never in the live `copydesk` folder, and runs `pnpm test`.
  3. Copytrader reviews the diff, then pushes the branch and opens a PR.
  4. **Rune merges**, then Copytrader deploys `main` to the live folder: it backs up the DB, pulls, installs, builds, restarts, and re-measures credits.

  ZCode sessions can be continued with `-Resume <sessionId>`. Rune can also open `copydesk-dev` in the ZCode desktop app himself and work alongside.

### Copytrader ↔ ZCode handshake (model ladder, quota checks, status files)

Added 2026-11-15 after a README run looked "stuck". ZCode's `--json` mode prints nothing until it finishes, so a working run and a hung run looked the same. The launcher now checks the model before every job, watches the run, and leaves a status file behind.

**Model ladder.** `C:\Users\atavi\.zcode\grokbot-cli\ladder.json` (editable) lists the models in Rune's priority order:

| #   | Model                                      | ZCode providerId / modelId                                   |
| --- | ------------------------------------------ | ------------------------------------------------------------ |
| 1   | GLM-5.3-Flash, Z.ai Start plan             | `account:zai-start-plan` / `GLM-5.3-Flash`                   |
| 2   | GLM-5.3-Flash, Z.ai Individual coding plan | `account:zai-individual-coding-plan` / `GLM-5.3-Flash`       |
| 3   | deepseek-flash, DeepSeek API               | `560f4a7e-…` (Rune's "Deepseek" provider) / `deepseek-flash` |
| 4   | DeepSeek V4.1 Flash, OpenRouter            | `openrouter` / `deepseek/deepseek-v4.1-flash`                |

Each rung also sets `reasoningLevel` (`max`, which is ZCode's own default). ZCode ignores a pinned model that has no reasoning level.

**How a model is pinned.** The CLI has no `--model` flag. For each attempt the launcher writes a temporary copy of ZCode's `provider_config.json` with `defaultModelSelection` set to that rung. The copy goes in `grokbot-cli\cfg\`, which only Rune's user can read. The launcher points the CLI at the copy with the env var `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` and deletes it when the attempt ends. Rune's real ZCode config is never modified.

**What happens on every run** (`zc.ps1 -Prompt …`):

1. **Preflight per rung.**
   - Checks that the provider and model exist in ZCode and that an API key is set. Only whether a key is present is checked; its value is never printed.
   - For DeepSeek and OpenRouter, it reads the remaining account balance, which costs no tokens.
   - It prints the provider, model and balance it will use.
2. **Model check.** ZCode logs which model it actually resolved for the session. If that isn't the pinned rung, the launcher stops the run before the first model call. This happens when ZCode silently falls back because a plan isn't active, the model is disabled, and so on. It then moves to the next rung.
3. **Watchdog.**
   - Kills the process tree after 180 s with no activity. Activity means the session's lines in ZCode's log or its model-io file.
   - Also kills it at the total timeout (default 1200 s).
   - ZCode's own retries are capped at 2 (`ZCODE_MODEL_RETRY_MAX_RETRIES`), so a dead quota can't keep it retrying for 10 minutes.
4. **Error detection.** Quota, rate-limit (429), insufficient-balance, 401/403 and auth errors in the session's log lines or in stderr stop the attempt at once.
5. **Fallback.** On `quota`, `auth` or `not-configured`, the launcher moves down the ladder. A session's model is fixed once the session is created, so the next rung starts a fresh session, told that the working tree may hold partial changes. On `timeout`, `stalled` or `error` it stops without trying more rungs, because those aren't credit problems.
6. **All rungs failed** → `exitReason: all-exhausted` (exit 40). Copytrader then asks Rune in the Grok Bot chat to add credits.

**Exit reasons / codes:**

- `ok` 0
- `quota` 20
- `auth` 21
- `timeout` 30
- `stalled` 31
- `error` 1
- `all-exhausted` 40

**Files** (all in `C:\Users\atavi\.zcode\grokbot-cli\`):

- `zc.ps1` is the launcher. `zc-helper.js` does the preflight and writes the pinned config. `ladder.json` is the model ladder.
- `last-run.json` records:
  - `startedAt`, `endedAt`, `exitReason`, `provider`, `model`, `rungUsed`;
  - `mode`, `cwd`, `sessionId`, `modelVerified` (what ZCode really resolved), `modelCalls`;
  - `summary`, `skipped[]` (rungs skipped, with reasons), `attempts[]`, `usage` and the log path.
- `last-check.json` is the result of `zc.ps1 -Check`. It holds per-rung status (`ok|quota|auth|timeout|not-configured|error|not-tried`), the pong reply, the balance and the `selected` rung.
- `runs\<timestamp>.log` holds the full stdout and stderr of every attempt.

**Health check:** `zc.ps1 -Check` runs the preflight plus a tiny "pong" probe per rung, with a 60 s limit each. It stops at the first rung that works; `-AllRungs` probes every rung. Copytrader runs it before ZCode jobs when the last check is stale.

**Visibility in the ZCode app:** headless CLI sessions do **not** show up in the ZCode desktop app's task list. `--surface desktop` only changes ZCode's system prompt; it doesn't register the session in the app. To follow a run, Rune can read `last-run.json` and `runs\*.log`, or ask Copytrader in the Grok Bot chat.

I checked this in detail on 2026-11-15 and found no supported way for an outside process to start a chat the app will list:

- The desktop app starts its own `app-server` processes over private stdio and named pipes, and opens no local ports.
- The `zcode:` deep links only handle opening a workspace, OAuth, payment callbacks and imports from a share code.
- The app's "App Control" tools (create or send to a session) are only available to sessions running inside the app.

The supported way to make work visible is a ZCode automation, set up as the mailbox below.

### ZCode automation mailbox (default route, visible in the ZCode app)

Added 2026-11-15 because Rune wants to see ZCode's work in the app. Rune creates **one scheduled task** in ZCode under the **CopyDesk** project. Every run lands in that task's chat, so Rune can follow along. Copytrader never creates or edits automations itself.

**Folders** in `C:\Users\atavi\.zcode\grokbot-cli\mailbox\`:

- `inbox\` holds new briefs. Each one moves to `working\` while ZCode is on it, then to `archive\`.
- `outbox\<id>.json` holds ZCode's replies.

**Brief:** `inbox\<yyyyMMdd-HHmmss>-<slug>.md`, with a YAML header followed by the brief body:

```
---
id: 20261115-090000-fix-exit-ladder
created: 2026-11-15T09:00:00+02:00
cwd: C:\Users\atavi\Documents\projects\copydesk-dev
branch: copytrader/fix-exit-ladder
base: main
mode: build            # build | plan (no edits) | review (read-only)
deadline: 2026-11-15T13:00:00+02:00
from: Copytrader (Grok Bot)
---
<what to do>
```

**Reply:** `outbox\<id>.json` = `{id, status: done|failed|blocked, branch, commits[], testsPassed, summary, questions[], finishedAt}`.

**Scripts:**

- `zc-post.ps1 -Prompt "..." [-Slug x] [-Branch copytrader/x] [-Base main] [-Cwd ...] [-Mode build|plan|review] [-DeadlineMin 240] [-Wait] [-TimeoutMin 90] [-PollSec 15]` drops a brief. The file is written to `.tmp` first and then renamed into place, so ZCode never sees a half-written brief. With `-Wait` it prints the reply. `-WaitId <id>` waits for a brief that was posted earlier.
  - Exit codes: 0 done, 1 failed, 2 blocked, 3 timeout (it says whether the brief is still in the inbox or in working), 4 bad input.
  - It refuses the live `copydesk` folder as cwd, and `main`/`master` as the branch.
- `mailbox\peek.ps1` is the cheap gate. It prints `EMPTY`, or `NEW <id>` / `RESUME <id>` plus the brief. `RESUME` means a brief was left in `working\` without a reply because an earlier run died, so that one comes first.
- `mailbox\mbox.ps1 peek|claim -Id|finish -Id|status`:
  - `claim` moves inbox → working, and prints `EXPIRED` if the deadline has passed.
  - `finish` validates the reply JSON, stamps `finishedAt` and moves the brief to archive.
- `mailbox\RUNBOOK.md` is the full per-brief procedure. ZCode only reads it when there is a brief.
- `mailbox\AUTOMATION-PROMPT.md` holds the text Rune pastes into the automation (also in `automation-instructions.txt`).

**One automation run:**

1. ZCode runs `peek.ps1` as its very first action.
2. On `EMPTY` it replies exactly "Inbox empty." and stops.
3. Otherwise it processes one brief per RUNBOOK:
   - claim the brief;
   - work only in the brief's cwd (copydesk-dev) on the named branch;
   - run `pnpm test`;
   - commit, but never push or merge, and never touch secrets, wallets, live-trading settings, the live desk or other projects;
   - write the reply, then `finish`;
   - summarise the run in the chat.
4. A `blocked` reply carries `questions`. Copytrader answers them by posting a follow-up brief, or asks Rune.

**After a reply:** Copytrader reads `outbox\<id>.json`, reviews the diff on the branch, pushes and opens the PR. Rune merges. Copytrader deletes old `outbox`/`archive` files after the PR is merged.

**App facts** (read from ZCode 0.17.1 and the Capitol Copy automation on 2026-11-15):

- Form fields: Task title, Schedule (Every hour / day / weekday / week / month / Custom), Instructions, and a toolbar under Instructions with the project, permission mode and model.
- Custom repeat can be every 1–200 minutes. It is stored as cron, e.g. `*/15 * * * *`.
- There is a Repeat indefinitely toggle, or Max runs.
- Runs append to the automation's target chat.
- There's a Run now button. A second run never overlaps a running one ("A run is already in progress").
- Runs only fire while the PC is awake and ZCode is running; missed slots are skipped, not caught up. ZCode starts at logon, from the HKCU Run key.
- The model is fixed per automation, so there's no ladder fallback. If DeepSeek runs dry, runs fail (visible in the task's Run history), and Copytrader falls back to `zc.ps1`.

**Cost:** every run pays ZCode's ~50k-token system prompt, even when the inbox is empty. An empty run is 2 model calls. deepseek-flash pricing per 1M tokens: $0.15 input on a cache miss, $0.003 on a cache hit, $0.60 output; peak hours cost double (weekdays 03:00–06:00 and 08:00–12:00 Helsinki). Estimated cost for empty runs:

| Interval             | If the prefix cache holds | If each run's first call misses | Worst case, no cache |
| -------------------- | ------------------------- | ------------------------------- | -------------------- |
| 15 min (96 runs/day) | ≈ $0.05–0.10              | ≈ $1.0                          | ≈ $1.9               |
| 30 min (48 runs/day) | ≈ $0.03–0.05              | ≈ $0.5                          | ≈ $0.95              |

Real jobs cost extra, like the README job (about 8.5M tokens, 97% cached, ≈ $0.10 off-peak or ≈ $0.20 at peak). Copytrader checks the DeepSeek balance after the first day to see which column is real.

---

## 6. Hard rules (what Copytrader never does)

- Never signs transactions, places orders, or moves funds on its own. The worker trades, within the risk limits Rune set.
- Never switches from paper to **live** trading. Only Rune does that.
- Never merges PRs.
- Never lets ZCode (or anyone) edit the live `copydesk` folder directly; all code goes through `copydesk-dev` and a PR.
- Never prints, pastes, or shares secrets.
- Never runs the desk on two machines at once.
- Never touches Rune's unrelated projects, processes, or scheduled tasks on this PC.

### Risk limits (set by Rune)

- $100 bankroll, max **$10 per trade**, max **$40 open per trader**.
- $2 minimum trade, **$15 daily loss stop**, **80% max deployed** ($80).
- Exits: 5h max hold, −25% stop, trailing stop, slippage ladder up to 1,000 bps.
- After a losing streak, a trader gets a 36h cooldown.

---

## 7. Why

- **Why an agent at all:** the copy engine is fast and deterministic but has no judgement. Copytrader supplies the judgement around it: who to hire, when to cut early, noticing when something looks wrong, and keeping costs inside free tiers. It also keeps Rune informed without him having to babysit.
- **Why it stays out of the trade path:** speed and safety. Copies need to land within seconds, and keeping the signing key's use inside the deterministic worker keeps behaviour predictable and auditable.
- **Why this PC:** Copytrader's cloud computer sleeps between check-ins. Stops and time-exits can't fire while it's asleep, so the desk needs an always-on host.

---

## 8. If something goes wrong

1. Ask Copytrader in the Grok Bot chat. It can read the logs and fix things from there.
2. To stop trading immediately, run `scripts\copydesk-service.ps1 stop`.
3. Check `logs\pm-log.md` for what Copytrader saw and did, and when.
