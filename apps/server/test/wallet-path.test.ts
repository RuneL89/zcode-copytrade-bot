import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '@zcode-bot/db';
import { loadConfig } from '@zcode-bot/config';
import {
  checkWalletFilePermissions,
  generateWalletFile,
  loadWalletSecret,
  walletExists,
  walletPublicKey,
} from '../src/wallet.js';
import { ControlService } from '../src/services/control.js';
import { readinessReport } from '../src/services/readiness.js';
import { OpsRunner } from '../src/services/ops.js';
import { Runtime } from '../src/runtime.js';

/**
 * The wallet path is configurable through WALLET_FILE. Every consumer —
 * readiness, bootstrap, the engine taker, fee ledger, withdrawals, OPS and both
 * CLIs — must follow it; the default `DATA_DIR/wallet/...` path is only a
 * fallback.
 */
describe('configured wallet path', () => {
  const dirs: string[] = [];
  function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-wallet-path-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates, finds, unlocks and permission-checks a custom WALLET_FILE', () => {
    const dataDir = temp();
    const custom = join(temp(), 'secrets', 'wallet.json');
    const generated = generateWalletFile(dataDir, 'test-encryption-secret', new Date(), custom);

    expect(generated.file).toBe(custom);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(join(dataDir, 'wallet', 'zcode-bot-wallet.json'))).toBe(false);
    expect(walletExists(dataDir, custom)).toBe(true);
    expect(walletExists(dataDir)).toBe(false);
    expect(walletPublicKey(dataDir, custom)).toBe(generated.publicKey);
    expect(checkWalletFilePermissions(custom).ok).toBe(true);
    expect(loadWalletSecret(dataDir, 'test-encryption-secret', custom)).toHaveLength(64);
    // Never overwrite an existing wallet: the key would be lost.
    expect(() => generateWalletFile(dataDir, 'test-encryption-secret', new Date(), custom)).toThrow(
      /already exists/,
    );
    expect(walletPublicKey(dataDir, custom)).toBe(generated.publicKey);
  });

  it('reports the wallet ready when WALLET_FILE points outside DATA_DIR', async () => {
    const dataDir = temp();
    const custom = join(temp(), 'wallet.json');
    const generated = generateWalletFile(dataDir, 'test-encryption-secret', new Date(), custom);

    const handle = openDatabase(dataDir);
    try {
      migrate(handle.db, {
        migrationsFolder: resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          '..',
          '..',
          '..',
          'packages',
          'db',
          'drizzle',
        ),
      });
      const config = loadConfig({
        SESSION_SECRET: 'w'.repeat(48),
        DATA_DIR: dataDir,
        MODE: 'paper',
        WALLET_FILE: custom,
      });
      config.env.DATA_DIR = dataDir; // the runtime uses the resolved absolute dir
      const report = await readinessReport(handle.db, config, new ControlService(handle.db), null, false);
      const wallet = report.items.find((item) => item.id === 'wallet')!;
      expect(wallet.ok).toBe(true);
      expect(wallet.detail).toContain(generated.publicKey);
      // The separate hard switch is its own readiness item, not implied by MODE.
      expect(report.items.find((item) => item.id === 'live_trading')!.ok).toBe(false);
    } finally {
      handle.close();
    }
  });

  it('backs up the configured WALLET_FILE, not the default path', async () => {
    const dataDir = temp();
    const custom = join(temp(), 'secrets', 'wallet.json');
    generateWalletFile(dataDir, 'backup-secret-123456', new Date(), custom);
    const config = loadConfig({
      SESSION_SECRET: 'b'.repeat(48),
      DATA_DIR: dataDir,
      MODE: 'paper',
      WALLET_FILE: custom,
    });
    config.env.DATA_DIR = dataDir;
    const rt = new Runtime(config);
    try {
      const runner = new OpsRunner(rt, rt.db.db, process.cwd());
      const result = await runner.run('backup-data');
      expect(result.ok).toBe(true);
      const backups = readdirSync(join(dataDir, 'backups'));
      expect(backups).toHaveLength(1);
      const dest = join(dataDir, 'backups', backups[0]!);
      expect(existsSync(join(dest, 'zcode-bot.db'))).toBe(true);
      expect(existsSync(join(dest, 'wallet', 'wallet.json'))).toBe(true);
      // The default wallet path is not what the configured WALLET_FILE points at.
      expect(existsSync(join(dest, 'wallet', 'zcode-bot-wallet.json'))).toBe(false);
      const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as {
        files: Array<{ file: string; sha256: string }>;
      };
      const wallet = manifest.files.find((file) => file.file === 'wallet/wallet.json');
      expect(wallet).toBeDefined();
      expect(wallet!.sha256).toHaveLength(64);
    } finally {
      rt.stop();
    }
  });
});
