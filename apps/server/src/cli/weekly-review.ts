#!/usr/bin/env node
/**
 * Generate the weekly performance review from a read-only database.
 *
 *   pnpm --filter @zcode-bot/server exec tsx src/cli/weekly-review.ts \
 *     --db ../copydesk/data/zcode-bot.db --out ../copydesk/reports --week 2026-W46
 *
 * The command never writes trading state: `openReadOnlyDatabase` opens the
 * SQLite file with `readonly: true`, and the generator only SELECTs. The
 * report files are the only output.
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openReadOnlyDatabase } from '@zcode-bot/db';
import { lastCompletedWeek, weekRange } from '@zcode-bot/core';
import { buildWeeklyReview, writeWeeklyReview } from '../services/weeklyReview.js';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const nowArg = arg('now');
const now = nowArg ? new Date(nowArg) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error('invalid --now timestamp');
  process.exit(2);
}

const dbPath = resolve(arg('db', join(process.env.DATA_DIR ?? join(process.cwd(), 'data'), 'zcode-bot.db'))!);
if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
  console.error(`database not found: ${dbPath}`);
  process.exit(2);
}
const mode = arg('mode', process.env.MODE ?? 'paper')!;
const timeZone = arg('time-zone', 'Europe/Helsinki')!;
const weekArg = arg('week');
let week;
try {
  week = weekArg ? weekRange(weekArg, timeZone) : lastCompletedWeek(now, timeZone);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const outDir = resolve(arg('out', join(process.cwd(), 'reports'))!);
const name = arg('name');
const resetAt = arg('reset-at');
if (resetAt && Number.isNaN(Date.parse(resetAt))) {
  console.error('invalid --reset-at timestamp');
  process.exit(2);
}

const db = openReadOnlyDatabase(dbPath);
try {
  const report = buildWeeklyReview({
    sqlite: db.sqlite,
    mode,
    dbPath,
    week,
    now,
    timeZone,
    resetAt: resetAt ?? undefined,
  });
  const paths = writeWeeklyReview(outDir, report, name);
  console.log(`week: ${week.label} (${week.startIso} → ${week.endIso})`);
  console.log(`seats: ${report.summary.seats} · paper copies: ${report.summary.copies}`);
  console.log(`report written: ${paths.markdown}`);
  console.log(`json written:   ${paths.json}`);
} finally {
  db.close();
}
