import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, cpSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as repo from '@zcode-bot/db/repo.js';
import type { AppDatabase } from '@zcode-bot/db';
import { generateWalletFile, walletExists, walletPublicKey } from '../wallet.js';
import type { Runtime } from '../runtime.js';

/**
 * Whitelisted operations runner for the no-terminal Operations console.
 *
 * Security model:
 * - Every runnable command is a SERVER-DEFINED constant below. Client input
 *   NEVER reaches argv, the shell, or the filesystem paths used by spawns.
 * - Ops run strictly one at a time (mutex) so a build can never interleave
 *   with a migration.
 * - Output is a bounded ring buffer (never unbounded memory).
 * - Destructive ops require a confirmation word validated server-side.
 * - Everything is audited (start, success, failure, rejection).
 */

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

export type OpGroup = 'setup' | 'server' | 'testing' | 'maintenance' | 'wallet';
export type Danger = 'normal' | 'confirm' | 'destructive';

export interface OpDefinition {
  id: string;
  label: string;
  group: OpGroup;
  description: string;
  kind: 'spawn' | 'action';
  /** Fixed command string (shell), server-defined only. */
  command?: string;
  action?: (ctx: OpActionContext) => Promise<string> | string;
  danger: Danger;
  /** Required body.confirm for 'confirm' (RUN) / 'destructive' (custom word) ops. */
  confirmWord?: string;
  /** Ops whose success ends the current server process (restart/stop/reset). */
  terminatesServer?: boolean;
  /** Timeout in ms (spawn ops). */
  timeoutMs?: number;
}

export interface OpActionContext {
  rt: Runtime;
  repoRoot: string;
  /** Spawn a detached, server-defined helper (survives server exit). */
  spawnDetached: (command: string) => void;
}

export interface OpRun {
  runId: number;
  opId: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'timeout';
  exitCode: number | null;
  summary: string | null;
  lines: string[];
}

const MAX_LINES = 800;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function opDefinitions(rt: Runtime): OpDefinition[] {
  const port = rt.config.env.PORT;
  return [
    // --- setup -------------------------------------------------------------
    {
      id: 'install-deps',
      label: 'Install / update dependencies',
      group: 'setup',
      description: 'pnpm install across the workspace.',
      kind: 'spawn',
      command: 'pnpm install',
      danger: 'normal',
      timeoutMs: 15 * 60_000,
    },
    {
      id: 'build',
      label: 'Build all packages',
      group: 'setup',
      description: 'Compile every workspace package and the web bundle.',
      kind: 'spawn',
      command: 'pnpm build',
      danger: 'normal',
      timeoutMs: 15 * 60_000,
    },
    {
      id: 'migrate',
      label: 'Apply database migrations',
      group: 'setup',
      description: 'Bring the SQLite schema to the latest version.',
      kind: 'spawn',
      command: 'pnpm db:migrate',
      danger: 'normal',
      timeoutMs: 5 * 60_000,
    },
    {
      id: 'seed',
      label: 'Seed example candidates',
      group: 'setup',
      description: 'Import fixtures/leaderboard.example.json as candidates.',
      kind: 'spawn',
      command: 'pnpm db:seed',
      danger: 'confirm',
      confirmWord: 'RUN',
      timeoutMs: 5 * 60_000,
    },
    {
      id: 'format',
      label: 'Format code',
      group: 'setup',
      description: 'Run prettier over the repository.',
      kind: 'spawn',
      command: 'pnpm format',
      danger: 'normal',
      timeoutMs: 5 * 60_000,
    },
    // --- testing -------------------------------------------------------------
    {
      id: 'test-unit',
      label: 'Run all unit + integration tests',
      group: 'testing',
      description: 'Builds first, then runs every workspace test suite.',
      kind: 'spawn',
      command: 'pnpm test',
      danger: 'normal',
      timeoutMs: 20 * 60_000,
    },
    {
      id: 'test-e2e',
      label: 'Run browser tests (Playwright)',
      group: 'testing',
      description: 'Starts its own server on port 8791 and runs the e2e suite (several minutes).',
      kind: 'spawn',
      command: 'pnpm e2e',
      danger: 'normal',
      timeoutMs: 30 * 60_000,
    },
    {
      id: 'typecheck',
      label: 'Typecheck',
      group: 'testing',
      description: 'tsc --noEmit across every package.',
      kind: 'spawn',
      command: 'pnpm typecheck',
      danger: 'normal',
      timeoutMs: 10 * 60_000,
    },
    // --- server ---------------------------------------------------------------
    {
      id: 'restart-server',
      label: 'Restart server',
      group: 'server',
      description: 'Graceful restart: this process exits and relaunches automatically.',
      kind: 'action',
      danger: 'confirm',
      confirmWord: 'RUN',
      terminatesServer: true,
      action: (ctx) => {
        ctx.spawnDetached(restartCommand(ctx.repoRoot));
        setTimeout(() => process.exit(0), 400);
        return 'restart scheduled';
      },
    },
    {
      id: 'shutdown-server',
      label: 'Shut server down',
      group: 'server',
      description: 'Stops the app. Relaunch with the Desktop shortcut or install.bat.',
      kind: 'action',
      danger: 'confirm',
      confirmWord: 'RUN',
      terminatesServer: true,
      action: (ctx) => {
        spawnDetachedRaw(`taskkill /F /PID ${process.pid} /T`);
        return 'shutdown scheduled';
      },
    },
    {
      id: 'discovery-sync-now',
      label: 'Sync discovery now',
      group: 'setup',
      description:
        'Unions the fomoapi 24h/7d/30d leaderboards plus the alerts feed into the candidate pool (D3 inlet). Requires FOMOAPI_KEY in .env; spends ~750 API credits per run.',
      kind: 'action',
      danger: 'confirm',
      confirmWord: 'RUN',
      action: async (ctx) => {
        const r = await ctx.rt.syncDiscoveryNow(true);
        if (r.skipped) return `skipped: ${r.reason}`;
        return (
          `${r.traders} trader(s): ${r.tradersNew} added, ${r.tradersUpdated} updated, ${r.merged} merged` +
          ` · alerts +${r.alertsAdded}` +
          ` · ${r.creditsSpent} credit(s) spent${r.creditsRemaining === null ? '' : `, ${r.creditsRemaining} left`}`
        );
      },
    },
    {
      id: 'open-dashboard',
      label: 'Open dashboard in browser',
      group: 'server',
      description: `Opens http://127.0.0.1:${port} in your default browser.`,
      kind: 'action',
      danger: 'normal',
      action: () => {
        spawnDetachedRaw(`start "" http://127.0.0.1:${port}`);
        return 'browser opened';
      },
    },
    {
      id: 'open-data-folder',
      label: 'Open data folder',
      group: 'server',
      description: 'Reveals the SQLite database and wallet files in Explorer.',
      kind: 'action',
      danger: 'normal',
      action: (ctx) => {
        spawnDetachedRaw(`explorer "${resolve(ctx.rt.config.env.DATA_DIR)}"`);
        return 'explorer opened';
      },
    },
    {
      id: 'demo-replay',
      label: 'Restart demo replay (28s)',
      group: 'server',
      description: 'Only in demo mode: restarts the fictional timeline.',
      kind: 'action',
      danger: 'normal',
      action: (ctx) => {
        if (ctx.rt.config.mode !== 'demo') throw new Error('demo replay is only available in demo mode');
        ctx.rt.startDemo();
        return 'demo replay restarted';
      },
    },
    {
      id: 'fomo-open-login',
      label: 'Open Fomo browser for login',
      group: 'server',
      description:
        'Opens the read-only Fomo browser on the PC so you can log in once. The session is saved for automatic leaderboard refresh. Requires FOMO_LEADERBOARD_URL in .env.',
      kind: 'action',
      danger: 'normal',
      action: async (ctx) => {
        await ctx.rt.fomoWebOpenLogin();
        return 'Fomo window opened on the PC — log in, then run "Fetch Fomo leaderboard now"';
      },
    },
    {
      id: 'fomo-fetch-now',
      label: 'Fetch Fomo leaderboard now',
      group: 'server',
      description:
        'Reads the leaderboard (and trader addresses when configured) through your logged-in session and refreshes the candidate pool.',
      kind: 'action',
      danger: 'normal',
      action: async (ctx) => {
        const r = await ctx.rt.fomoWebImportNow();
        return `imported ${r.imported} candidates${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}`;
      },
    },
    {
      id: 'fomo-debug-capture',
      label: 'Capture Fomo page (setup)',
      group: 'server',
      description:
        'Setup helper: saves the page currently open in the Fomo browser so the leaderboard selectors can be configured. Navigate to the leaderboard first, then run this.',
      kind: 'action',
      danger: 'normal',
      action: async (ctx) => {
        const d = await ctx.rt.fomoWebDebugCapture();
        return `captured ${d.url} -> ${d.file}`;
      },
    },
    {
      id: 'dawn-open-login',
      label: 'Open Telegram (Dawn) browser for login',
      group: 'server',
      description:
        'Opens the Telegram Web browser on the PC so you can scan the QR once with your phone (Settings > Devices > Link Desktop Device). The session is saved for automatic address resolution. Requires DAWN_BOT_USERNAME in .env.',
      kind: 'action',
      danger: 'normal',
      action: async (ctx) => {
        await ctx.rt.dawnOpenLogin();
        return 'Telegram window opened on the PC — scan the QR, then run "Resolve trader addresses via Dawn"';
      },
    },
    {
      id: 'dawn-lookup-now',
      label: 'Resolve trader addresses via Dawn',
      group: 'server',
      description:
        'Asks the Dawn bot (through your Telegram session) about every candidate that has no Solana address yet and stores the wallets from the reply. Read-only: plain text messages only, never a copytrade task.',
      kind: 'action',
      danger: 'normal',
      action: async (ctx) => {
        const r = await ctx.rt.dawnLookupNow();
        return `resolved ${r.resolved} address(es), ${r.failed} unresolved${
          r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''
        }`;
      },
    },
    {
      id: 'activity-refresh-now',
      label: 'Refresh candidate activity now',
      group: 'server',
      description:
        'Queries Helius for every enabled candidate wallet: swaps in the last 24h and hours since the last swap. Stores them for ranking and marks an address verified when the pre-hire gate would pass.',
      kind: 'action',
      danger: 'normal',
      action: async (ctx) => {
        const r = await ctx.rt.activityRefreshNow();
        return (
          'refreshed ' + r.checked + ' candidate(s), ' + r.verified + ' verified, ' + r.failed + ' failed'
        );
      },
    },
    // --- maintenance ------------------------------------------------------------
    {
      id: 'backup-data',
      label: 'Back up data now',
      group: 'maintenance',
      description: 'Copies the SQLite database (with WAL files) into data/backups/<timestamp>.',
      kind: 'action',
      danger: 'normal',
      action: (ctx) => backupData(ctx.rt),
    },
    {
      id: 'reset-db',
      label: 'Reset database (destructive)',
      group: 'maintenance',
      description:
        'Stops the server, DELETES the database (all trades, audit, users), migrates fresh, and restarts. Requires typing RESET.',
      kind: 'action',
      danger: 'destructive',
      confirmWord: 'RESET',
      terminatesServer: true,
      action: (ctx) => {
        const dataDir = resolve(ctx.rt.config.env.DATA_DIR);
        ctx.spawnDetached(
          resetDbCommand(
            ctx.repoRoot,
            dataDir,
            String(ctx.rt.config.env.PORT),
            process.pid,
            process.execPath,
            process.argv
              .slice(1)
              .map((a) => `"${a}"`)
              .join(' '),
          ),
        );
        setTimeout(() => process.exit(0), 400);
        return 'reset scheduled';
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class OpsRunner {
  private current: OpRun | null = null;
  private history: OpRun[] = [];
  private runCounter = 0;
  private definitions: OpDefinition[];

  constructor(
    private rt: Runtime,
    private db: AppDatabase,
    private repoRootDir: string,
    definitions?: OpDefinition[],
  ) {
    // Injectable definitions keep tests fast and spawn-free; production uses
    // the fixed whitelist above.
    this.definitions = definitions ?? opDefinitions(rt);
  }

  catalog(): Array<Omit<OpDefinition, 'action' | 'command'>> {
    return this.definitions.map(({ action, command, ...rest }) => {
      void action;
      void command;
      return rest;
    });
  }

  snapshot(): {
    current: OpRun | null;
    history: OpRun[];
    system: ReturnType<OpsRunner['systemInfo']>;
  } {
    return { current: this.current, history: this.history, system: this.systemInfo() };
  }

  systemInfo() {
    const dataDir = resolve(this.rt.config.env.DATA_DIR);
    const dbPath = join(dataDir, 'zcode-bot.db');
    const dbBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
    const backupsDir = join(dataDir, 'backups');
    const backups = existsSync(backupsDir) ? readdirSync(backupsDir).sort().reverse().slice(0, 8) : [];
    return {
      nodeVersion: process.version,
      mode: this.rt.config.mode,
      port: this.rt.config.env.PORT,
      uptimeSeconds: Math.round(process.uptime()),
      workerRunning: Boolean(this.rt.monitor?.running) || this.rt.config.mode === 'demo',
      lockHeld: Boolean(this.rt.lock),
      dbBytes,
      walletExists: walletExists(dataDir),
      walletPublicKey: walletPublicKey(dataDir),
      dataDir,
      backups,
    };
  }

  async run(
    opId: string,
    confirm?: string,
  ): Promise<{ ok: boolean; error?: string; code?: 'CONFIRMATION_REQUIRED'; run?: OpRun }> {
    const def = this.definitions.find((d) => d.id === opId);
    if (!def) return { ok: false, error: `unknown operation '${opId}'` };
    if (this.current) {
      return { ok: false, error: `operation '${this.current.opId}' is still running; wait for it to finish` };
    }
    if (def.danger === 'confirm' && confirm !== (def.confirmWord ?? 'RUN')) {
      repo.audit(this.db, 'ops', `operation '${opId}' needs confirmation`, {});
      return {
        ok: false,
        code: 'CONFIRMATION_REQUIRED',
        error: 'confirmation required (send the confirmation word in the body)',
      };
    }
    if (def.danger === 'destructive' && confirm !== def.confirmWord) {
      repo.audit(
        this.db,
        'ops',
        `destructive operation '${opId}' refused (missing/incorrect confirmation)`,
        {},
      );
      return {
        ok: false,
        code: 'CONFIRMATION_REQUIRED',
        error: `destructive operation requires typing "${def.confirmWord}"`,
      };
    }

    const run: OpRun = {
      runId: ++this.runCounter,
      opId: def.id,
      label: def.label,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      exitCode: null,
      summary: null,
      lines: [],
    };
    this.current = run;
    this.history.unshift(run);
    if (this.history.length > 25) this.history.pop();
    repo.audit(this.db, 'ops', `operation started: ${def.id}`, {});

    try {
      if (def.kind === 'spawn' && def.command) {
        await this.runSpawn(def, run);
      } else if (def.action) {
        const summary = await def.action({
          rt: this.rt,
          repoRoot: this.repoRootDir,
          spawnDetached: (command) => spawnDetachedRaw(command),
        });
        run.summary = summary;
        run.status = 'succeeded';
        run.exitCode = 0;
      }
    } catch (e) {
      run.status = 'failed';
      run.exitCode = run.exitCode ?? 1;
      run.lines.push(`[error] ${(e as Error).message}`.slice(0, 2000));
    }

    run.endedAt = new Date().toISOString();
    if (this.current === run) this.current = null;
    repo.audit(this.db, 'ops', `operation ${run.status}: ${def.id}`, {
      exitCode: run.exitCode,
      summary: run.summary,
    });
    return { ok: run.status === 'succeeded', run };
  }

  private runSpawn(def: OpDefinition, run: OpRun): Promise<void> {
    return new Promise((resolvePromise) => {
      const child = spawn(def.command!, {
        shell: true, // fixed server-defined command strings only
        cwd: this.repoRootDir,
        env: sanitizedEnv(),
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        run.status = 'timeout';
        killTree(child.pid);
      }, def.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const push = (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          run.lines.push(line.slice(0, 500));
          if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
        }
      };
      child.stdout?.on('data', push);
      child.stderr?.on('data', push);
      child.on('error', (e) => {
        clearTimeout(timer);
        run.status = 'failed';
        run.lines.push(`[spawn error] ${e.message}`);
        resolvePromise();
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        run.exitCode = code ?? (signal ? -1 : 1);
        if (run.status !== 'timeout') run.status = code === 0 ? 'succeeded' : 'failed';
        resolvePromise();
      });
    });
  }

  /** Wallet creation from the console. Secret stays in this request only. */
  createWallet(secret: string, confirm: string): { ok: boolean; error?: string; publicKey?: string } {
    if (!secret || secret.length < 16)
      return { ok: false, error: 'encryption secret must be at least 16 characters' };
    if (secret !== confirm) return { ok: false, error: 'secret and confirmation do not match' };
    if (walletExists(this.rt.config.env.DATA_DIR)) {
      return {
        ok: false,
        error: 'a wallet already exists; delete data/wallet/ first (and make sure you have a backup)',
      };
    }
    const { publicKey } = generateWalletFile(this.rt.config.env.DATA_DIR, secret);
    repo.audit(this.db, 'wallet', 'wallet created from Operations console', { publicKey });
    return { ok: true, publicKey };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizedEnv(): NodeJS.ProcessEnv {
  const allow = [
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERPROFILE',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PROCESSOR_ARCHITECTURE',
  ];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, shell: false });
  } catch {
    /* best effort */
  }
}

/** Detached command that survives this process (restart/stop/reset helpers). */
function spawnDetachedRaw(command: string): void {
  const child = spawn('cmd.exe', ['/c', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  child.unref();
}

function restartCommand(repoRootDir: string): string {
  const args = process.argv
    .slice(1)
    .map((a) => `"${resolve(a)}"`)
    .join(' ');
  // cd first, then relaunch with the exact same interpreter + script.
  return `cd /d "${repoRootDir}" && "${process.execPath}" ${args}`;
}

function resetDbCommand(
  repoRootDir: string,
  dataDir: string,
  port: string,
  serverPid: number,
  execPath: string,
  serverArgs: string,
): string {
  void port; // the relaunched server reads PORT from the environment it inherits
  const script = [
    '@echo off',
    `taskkill /F /PID ${serverPid} /T >nul 2>&1`,
    'timeout /t 2 /nobreak >nul',
    `del /q "${join(dataDir, 'zcode-bot.db')}" 2>nul`,
    `del /q "${join(dataDir, 'zcode-bot.db-wal')}" 2>nul`,
    `del /q "${join(dataDir, 'zcode-bot.db-shm')}" 2>nul`,
    `cd /d "${repoRootDir}"`,
    `start "" /b "${execPath}" ${serverArgs}`,
  ].join('\r\n');
  // Persist the helper for auditability, then the returned command runs it detached.
  const helperPath = join(dataDir, 'reset-db-helper.cmd');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(helperPath, script + '\r\n', 'utf8');
  return `"${helperPath}"`;
}

function backupData(rt: Runtime): string {
  const dataDir = resolve(rt.config.env.DATA_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = join(dataDir, 'backups', stamp);
  mkdirSync(dest, { recursive: true });
  for (const name of ['zcode-bot.db', 'zcode-bot.db-wal', 'zcode-bot.db-shm']) {
    const src = join(dataDir, name);
    if (existsSync(src)) cpSync(src, join(dest, name));
  }
  // Wallet + research config (never any secret plaintext — wallet is encrypted at rest).
  const wallet = join(dataDir, 'wallet', 'zcode-bot-wallet.json');
  if (existsSync(wallet)) {
    mkdirSync(join(dest, 'wallet'), { recursive: true });
    cpSync(wallet, join(dest, 'wallet', 'zcode-bot-wallet.json'));
  }
  return `backup written to ${basename(dest)}`;
}

export { repoRoot as opsRepoRoot };
