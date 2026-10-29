import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from './connection.js';
import { findRepoRoot, resolveDataDir } from '@zcode-bot/config';
import { join } from 'node:path';

/**
 * Apply SQLite migrations. pnpm runs this with cwd = packages/db, so both the
 * data directory and the migrations folder are resolved against the workspace
 * root found from this file's own URL — never from process.cwd().
 */
const repoRoot = findRepoRoot(import.meta.url);
const dataDir = resolveDataDir(process.argv[2] ?? process.env.DATA_DIR ?? './data', repoRoot);
const migrationsFolder = join(repoRoot, 'packages', 'db', 'drizzle');

const handle = openDatabase(dataDir);
try {
  migrate(handle.db, { migrationsFolder });
  console.log(`migrations applied to ${dataDir}`);
} finally {
  handle.close();
}
