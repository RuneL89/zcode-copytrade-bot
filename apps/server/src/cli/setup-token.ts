import { openDatabase } from '@zcode-bot/db';
import * as repo from '@zcode-bot/db/repo.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppConfig } from '../bootstrap.js';

/** Re-print the one-time first-run setup token (only before the user exists). */
const config = loadAppConfig();
const handle = openDatabase(config.env.DATA_DIR);
try {
  if (repo.countUsers(handle.db) > 0) {
    console.log('setup already completed; to reset credentials, delete DATA_DIR/zcode-bot.db (destructive).');
    process.exit(0);
  }
  const file = join(config.env.DATA_DIR, 'setup-token.txt');
  if (!existsSync(file)) {
    console.log(`no setup token yet; start the server once, then read ${file}`);
  } else {
    console.log(readFileSync(file, 'utf8').trim());
  }
} finally {
  handle.close();
}
