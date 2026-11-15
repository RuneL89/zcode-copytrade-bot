/**
 * Counterfactual parameter sweep (read-only).
 *
 * usage (from the live folder):
 *   pnpm sweep --db data/zcode-bot.db --out reports
 *   pnpm sweep --db data/backups/<copy>.db --out docs/samples --name param-sweep-sample
 *
 * The source DB is snapshotted with SQLite's online backup API and the
 * snapshot is opened read-only. It never writes the source, never calls a
 * provider, and never applies a parameter. Reports are Markdown + JSON.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_RISK, riskConfigSchema, type RiskConfig } from '@zcode-bot/config';
import { openReadOnlyDatabase } from '@zcode-bot/db';
import {
  buildSweepReport,
  loadSweepDataset,
  renderSweepMarkdown,
  type ParamSweepOptions,
} from '../services/paramSweep.js';
import type { SimulationParams, SweepGrid } from '@zcode-bot/core';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function numberValue(args: string[], name: string): number | undefined {
  const raw = value(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function loadGrid(path: string | undefined): SweepGrid | undefined {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SweepGrid;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('grid file must be a JSON object');
  if (parsed.values && typeof parsed.values !== 'object') throw new Error('grid.values must be an object');
  if (parsed.combinations && !Array.isArray(parsed.combinations)) {
    throw new Error('grid.combinations must be an array');
  }
  if (parsed.hiring && !Array.isArray(parsed.hiring)) throw new Error('grid.hiring must be an array');
  return parsed;
}

function loadRisk(path: string | undefined): RiskConfig | undefined {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return riskConfigSchema.parse({ ...DEFAULT_RISK, ...parsed });
}

async function snapshot(source: string, destination: string): Promise<void> {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Read-only counterfactual parameter sweep.',
        '',
        '  --db <path>                 source DB (default data/zcode-bot.db)',
        '  --out <dir>                 report directory (default reports)',
        '  --name <base>               file base (default param-sweep-YYYYMMDD)',
        '  --grid <json>               custom grid file',
        '  --risk-file <json>          baseline risk overrides (JSON object)',
        '  --from/--to <iso>           replay window',
        '  --equity-start <usd>        starting equity (default 100)',
        '  --top <n>                   alternatives in the report (default 10)',
        '  --entry-slippage-bps <n>    override calibrated entry slippage',
        '  --exit-slippage-bps <n>     override exit slippage (default 30)',
        '  --fee-bps <n>               override fee bps (default 5)',
        '  --delay-seconds <n>         override copy delay',
        '  --path-step-minutes <n>     linear-path step (default 1)',
        '  --no-snapshot               open --db read-only directly (a copy only)',
        '',
        'The source is snapshotted with SQLite backup and opened read-only.',
      ].join('\n'),
    );
    return;
  }

  const source = resolve(value(args, '--db') ?? join('data', 'zcode-bot.db'));
  const outDir = resolve(value(args, '--out') ?? 'reports');
  const top = numberValue(args, '--top') ?? 10;
  if (!Number.isInteger(top) || top < 1) throw new Error('--top must be a positive integer');
  const fromRaw = value(args, '--from');
  const toRaw = value(args, '--to');
  const fromMs = fromRaw ? Date.parse(fromRaw) : undefined;
  const toMs = toRaw ? Date.parse(toRaw) : undefined;
  if (fromRaw && !Number.isFinite(fromMs)) throw new Error('--from must be an ISO timestamp');
  if (toRaw && !Number.isFinite(toMs)) throw new Error('--to must be an ISO timestamp');
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) {
    throw new Error('--from must be before --to');
  }

  const risk = loadRisk(value(args, '--risk-file'));
  const grid = loadGrid(value(args, '--grid'));
  const simOverrides: Partial<SimulationParams> = {};
  const entrySlippage = numberValue(args, '--entry-slippage-bps');
  const exitSlippage = numberValue(args, '--exit-slippage-bps');
  const feeBps = numberValue(args, '--fee-bps');
  const delaySeconds = numberValue(args, '--delay-seconds');
  const pathStepMinutes = numberValue(args, '--path-step-minutes');
  for (const [name, amount] of [
    ['--entry-slippage-bps', entrySlippage],
    ['--exit-slippage-bps', exitSlippage],
    ['--fee-bps', feeBps],
    ['--delay-seconds', delaySeconds],
  ] as const) {
    if (amount !== undefined && amount < 0) throw new Error(`${name} must not be negative`);
  }
  if (pathStepMinutes !== undefined && pathStepMinutes <= 0) {
    throw new Error('--path-step-minutes must be positive');
  }
  if (entrySlippage !== undefined) simOverrides.entrySlippageBps = entrySlippage;
  if (exitSlippage !== undefined) simOverrides.exitSlippageBps = exitSlippage;
  if (feeBps !== undefined) simOverrides.feeBps = feeBps;
  if (delaySeconds !== undefined) simOverrides.delaySeconds = delaySeconds;
  if (pathStepMinutes !== undefined) simOverrides.pathStepMinutes = pathStepMinutes;

  const equityStart = numberValue(args, '--equity-start');
  if (equityStart !== undefined && equityStart <= 0) {
    throw new Error('--equity-start must be positive');
  }
  const options: ParamSweepOptions = {
    risk,
    grid,
    sim: simOverrides,
    fromMs,
    toMs,
    top,
    sourceDb: basename(source),
    equityStartUsdMicro: equityStart === undefined ? undefined : BigInt(Math.round(equityStart * 1_000_000)),
  };

  let tempDir: string | null = null;
  let dbHandle: ReturnType<typeof openReadOnlyDatabase> | null = null;
  try {
    let dbPath = source;
    if (!args.includes('--no-snapshot')) {
      tempDir = mkdtempSync(join(tmpdir(), 'copydesk-sweep-'));
      dbPath = join(tempDir, 'snapshot.db');
      await snapshot(source, dbPath);
    }
    dbHandle = openReadOnlyDatabase(dbPath);
    const dataset = loadSweepDataset(dbHandle, options);
    const report = buildSweepReport(dataset, options);
    mkdirSync(outDir, { recursive: true });
    const day = report.generatedAt.slice(0, 10).replaceAll('-', '');
    const requestedName = value(args, '--name');
    const base = (requestedName ?? `param-sweep-${day}`).replace(/[^A-Za-z0-9._-]/g, '_');
    const jsonPath = join(outDir, `${base}.json`);
    const markdownPath = join(outDir, `${base}.md`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    writeFileSync(markdownPath, renderSweepMarkdown(report), 'utf8');

    console.log(`Param sweep (read-only) — ${basename(source)}`);
    console.log(
      `Range ${report.range.fromIso} → ${report.range.toIso}; ` +
        `${dataset.signals.length} signal(s), ${dataset.actualWindows.length} hire window(s)`,
    );
    console.log(
      `Baseline: ${report.baseline.full.netPnlUsdMicro} micro-USD net, ` +
        `${report.baseline.full.trades} trade(s), ${report.baseline.full.winRatePct ?? '—'}% win rate`,
    );
    const topRun = report.alternatives[0];
    console.log(
      topRun
        ? `Top alternative: ${topRun.label} — test ${topRun.test.netPnlUsdMicro} micro-USD, ` +
            `${topRun.test.trades} trade(s), ${topRun.riskLabel}`
        : 'No alternative produced a trade; the report says so instead of ranking noise.',
    );
    console.log(`Replay match: ${report.baselineMatch.note}`);
    console.log(`Wrote ${markdownPath}`);
    console.log(`Wrote ${jsonPath}`);
    console.log(`Runtime ${(report.runtimeMs / 1000).toFixed(1)}s`);
  } finally {
    dbHandle?.close();
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
