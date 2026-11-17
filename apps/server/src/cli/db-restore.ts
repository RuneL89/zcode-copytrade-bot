import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { findRepoRoot } from '@zcode-bot/config';
import { openDatabase } from '@zcode-bot/db';
import { loadAppConfig } from '../bootstrap.js';
import { walletFilePath } from '../wallet.js';

/**
 * Restore a backup written by OPS → Back up data now.
 *
 * The server MUST be stopped: the CLI refuses while `worker.lock` names a live
 * PID. It takes a safety snapshot of the current database first, restores the
 * backup, and applies migrations. The wallet file is only copied when
 * `--wallet` is passed (a custom WALLET_FILE may live outside DATA_DIR).
 *
 * Usage: pnpm db:restore <backup-dir> [--wallet]
 */
const args = process.argv.slice(2);
const backupDir = args.find((a) => !a.startsWith('--'));
const restoreWallet = args.includes('--wallet');
if (!backupDir) {
  console.error('usage: pnpm db:restore <backup-dir> [--wallet]');
  process.exit(1);
}

const repoRoot = findRepoRoot(import.meta.url);
const config = loadAppConfig();
const dataDir = resolve(config.env.DATA_DIR);
const sourceDb = join(resolve(backupDir), 'zcode-bot.db');
if (!existsSync(sourceDb)) {
  console.error(`backup database not found: ${sourceDb}`);
  process.exit(1);
}

const lockPath = join(dataDir, 'worker.lock');
if (existsSync(lockPath)) {
  const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
  let alive = false;
  if (Number.isInteger(pid)) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  if (alive) {
    console.error(`refusing to restore: worker lock held by live PID ${pid}. Stop the server first.`);
    process.exit(1);
  }
}

mkdirSync(join(dataDir, 'backups'), { recursive: true });
const targetDb = join(dataDir, 'zcode-bot.db');
if (existsSync(targetDb)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safety = join(dataDir, 'backups', `pre-restore-${stamp}.db`);
  copyFileSync(targetDb, safety);
  console.log(`safety snapshot: ${safety}`);
}

copyFileSync(sourceDb, targetDb);
rmSync(`${targetDb}-wal`, { force: true });
rmSync(`${targetDb}-shm`, { force: true });

const handle = openDatabase(dataDir);
try {
  migrate(handle.db, { migrationsFolder: join(repoRoot, 'packages', 'db', 'drizzle') });
} finally {
  handle.close();
}
console.log(`database restored from ${sourceDb} and migrated`);

// The wallet is not part of the trading DB. Copy it only on explicit request.
const sourceWallet = join(
  resolve(backupDir),
  'wallet',
  basename(walletFilePath(dataDir, config.env.WALLET_FILE)),
);
const targetWallet = walletFilePath(dataDir, config.env.WALLET_FILE);
if (existsSync(sourceWallet) && restoreWallet) {
  mkdirSync(dirname(targetWallet), { recursive: true });
  copyFileSync(sourceWallet, targetWallet);
  const sourceUnlock = join(resolve(backupDir), 'wallet-unlock.dpapi');
  if (existsSync(sourceUnlock)) {
    copyFileSync(sourceUnlock, join(dataDir, 'wallet-unlock.dpapi'));
    console.log('DPAPI passphrase restored for this Windows account');
  }
  console.log(`wallet restored to ${targetWallet}`);
} else if (existsSync(sourceWallet)) {
  console.log(
    `wallet backup available at ${sourceWallet}; re-run with --wallet to copy it to ${targetWallet}`,
  );
}
console.log('start the server with the normal launch path.');
