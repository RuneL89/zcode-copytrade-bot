/**
 * paper-reset.mjs — reset the paper experiment to a clean slate.
 *
 * Wipes ALL paper-experiment state: the copied book (positions, intents,
 * fills, realized lots), the roster (activations, cursors, firings, streaks),
 * the shadow ledger (watch wallets, events, pretend lots), and every
 * position-scoped kv key. Keeps: discovery (candidates, addresses,
 * leaderboard observations), users, audit_events (the trail), control_events,
 * provider health, and the discovery/report/telegram kv keys.
 *
 * Safety:
 *  - refuses to run while the worker lock is held by a live process
 *    (stop the desk first: scripts\copydesk-service.ps1 stop)
 *  - copies data/zcode-bot.db (+ -wal/-shm) to data/backups/pre-paper-reset-<ts>/
 *    before touching anything, so the reset is reversible
 *  - all deletes run in one transaction
 *
 * Usage: node scripts/paper-reset.mjs
 */
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = 'C:/Users/atavi/Documents/projects/copydesk';
const DATA = join(ROOT, 'data');
const Database = require(join(ROOT, 'node_modules', '.pnpm', 'better-sqlite3@12.11.1', 'node_modules', 'better-sqlite3'));

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 1. refuse while the desk runs (worker lock is held by a live server).
const lockPath = join(DATA, 'worker.lock');
if (existsSync(lockPath)) {
  const raw = parseInt(require('node:fs').readFileSync(lockPath, 'utf8').trim(), 10);
  if (Number.isInteger(raw) && isAlive(raw)) {
    console.error(`REFUSING: the desk is running (pid ${raw} holds data/worker.lock).`);
    console.error('Stop it first:  scripts\\copydesk-service.ps1 stop');
    process.exit(1);
  }
  console.log('stale worker lock present (pid ' + raw + ' gone) — continuing');
}

// 2. backup first: db + wal + shm into data/backups/.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = join(DATA, 'backups', `pre-paper-reset-${stamp}`);
mkdirSync(backupDir, { recursive: true });
for (const ext of ['', '-wal', '-shm']) {
  const f = join(DATA, 'zcode-bot.db' + ext);
  if (existsSync(f)) copyFileSync(f, join(backupDir, 'zcode-bot.db' + ext));
}
console.log('backup →', backupDir);

// 3. open read-write (recovers/checkpoints the WAL) and wipe in one transaction.
const db = new Database(join(DATA, 'zcode-bot.db'));
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = OFF');

const before = {};
const wipe = [
  'trader_activations',
  'leader_cursors',
  'observed_leader_events',
  'copied_positions',
  'order_intents',
  'fills',
  'execution_attempts',
  'realized_pnl_lots',
  'loss_streak_events',
  'firing_events',
  'handoff_events',
  'risk_rejections',
  'candidate_rejections',
  'reconciliation_cases',
  'shadow_trades',
  'watch_events',
  'watch_wallets',
  'watch_cursors',
];

const reset = db.transaction(() => {
  for (const t of wipe) {
    before[t] = db.prepare(`select count(*) n from ${t}`).get().n;
    db.prepare(`delete from ${t}`).run();
  }
  // Position-scoped and experiment-scoped kv keys. Kept: discovery.*, control.*,
  // telegram.*, reports.*, token.symbols, helius.usage, settings/providers keys.
  for (const k of db
    .prepare("select key from kv where key like 'monitor.lastOpenAt:%' or key like 'exit.%' or key like 'timeexit.grace:%' or key like 'admission.%' or key in ('seat.opens','fees.ledger')")
    .all()) {
    db.prepare('delete from kv where key = ?').run(k.key);
  }
});
reset();

console.log('\n=== wiped ===');
for (const t of wipe) console.log('  ', t.padEnd(26), before[t], 'rows');
const kvLeft = db.prepare('select count(*) n from kv').get().n;
console.log('   kv keys remaining (discovery/control/telegram/report caches):', kvLeft);

// 4. sanity: the paper book is empty and the bank resets to its seed.
const bank = {
  fills: db.prepare('select count(*) n from fills').get().n,
  lots: db.prepare('select count(*) n from realized_pnl_lots').get().n,
  positions: db.prepare('select count(*) n from copied_positions').get().n,
  activations: db.prepare('select count(*) n from trader_activations').get().n,
  watch: db.prepare('select count(*) n from watch_wallets').get().n,
  candidates: db.prepare('select count(*) n from trader_candidates').get().n,
};
console.log('\n=== post-reset sanity (fills/lots/positions/activations must all be 0) ===');
console.log('  ', JSON.stringify(bank));
if (bank.fills + bank.lots + bank.positions + bank.activations !== 0) {
  console.error('RESET INCOMPLETE — restore the backup and investigate.');
  process.exit(1);
}
console.log('\npaper bank resets to EQUITY_START_USD ($100 from .env) on next boot.');
db.close();
console.log('done. start the desk:  scripts\\copydesk-service.ps1 start');
