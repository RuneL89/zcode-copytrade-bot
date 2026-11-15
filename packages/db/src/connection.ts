import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { mkdirSync, openSync, closeSync, rmSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export { schema };

export interface DbHandle {
  db: AppDatabase;
  sqlite: Database.Database;
  close(): void;
}

export function openDatabase(dataDir: string, filename = 'zcode-bot.db'): DbHandle {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, filename));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}

/**
 * Open an existing SQLite file read-only. Used by report generators, replay
 * and audit tools that must never write trading state: the connection itself
 * refuses writes, and the caller never migrates or seeds. The file must exist;
 * there is no create fallback.
 */
export function openReadOnlyDatabase(filename: string): DbHandle {
  if (!existsSync(filename)) {
    throw new Error(`read-only database not found: ${filename}`);
  }
  const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
  sqlite.pragma('query_only = ON');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Single-worker lock: an exclusive lockfile in the data directory. A second
// worker process refuses to start instead of double-executing orders.
// ---------------------------------------------------------------------------

export interface WorkerLock {
  release(): void;
}

export function acquireWorkerLock(dataDir: string): WorkerLock {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'worker.lock');
  if (existsSync(lockPath)) {
    if (!isStaleLock(lockPath)) {
      throw new Error(
        `worker lock held by another process (${readFileSync(lockPath, 'utf8').trim()}). Only one worker may run per data directory.`,
      );
    }
    rmSync(lockPath);
  }
  const fd = openSync(lockPath, 'wx');
  writeSync(fd, `${process.pid}\n`);
  return {
    release() {
      try {
        closeSync(fd);
      } finally {
        rmSync(lockPath, { force: true });
      }
    },
  };
}

// A lock is stale when its PID no longer exists (best-effort cross-platform).
function isStaleLock(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (!Number.isInteger(pid)) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}
