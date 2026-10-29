import { z } from 'zod';
import type { LeaderboardEntry, LeaderboardImportResult } from './types.js';
import { randomUUID } from 'node:crypto';

const entrySchema = z.object({
  handle: z.string().min(1).max(64),
  weeklyRank: z.number().int().positive().nullable().optional(),
  displayedPnlUsd: z.number().finite().nullable().optional(),
  profileUrl: z.string().url().nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  solanaAddresses: z.array(z.string().min(32).max(44)).max(4).optional(),
  enabled: z.boolean().optional(),
  observedAt: z.string().optional(),
});

export function isLikelySolanaAddress(value: string): boolean {
  return base58Re.test(value.trim());
}

const base58Re = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Manual JSON import. Input is a JSON array of entry objects; every row is
 * validated and length-limited, duplicates are handled explicitly (same handle
 * keeps the LAST occurrence and records a warning), never silently dropped.
 */
export function parseManualJson(text: string, now = new Date()): LeaderboardImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error('expected a JSON array of leaderboard entries');
  return normalizeRows(raw as Record<string, unknown>[], now, 'manual-json');
}

/** Parse "1,234.56"-style or plain numeric CSV cell to number or null. */
function parseCsvNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const t = cell
    .trim()
    .replace(/[$,%+]/g, '')
    .replace(/,/g, '');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Manual CSV import. Header required:
 * handle,weekly_rank,displayed_pnl_usd,profile_url,avatar_url,solana_addresses,enabled,observed_at
 * solana_addresses may contain multiple addresses separated by '|'.
 */
export function parseManualCsv(text: string, now = new Date()): LeaderboardImportResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase().replace(/[\s-]+/g, '_'));
  const idx = (name: string) => header.indexOf(name);
  if (idx('handle') === -1) throw new Error('CSV header must include a handle column');
  const rows: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    const handle = cells[idx('handle')]?.trim() ?? '';
    row.handle = handle;
    const rank = parseCsvNumber(cells[idx('weekly_rank') ?? -1]);
    row.weeklyRank = rank !== null && Number.isInteger(rank) && rank > 0 ? rank : null;
    row.displayedPnlUsd = parseCsvNumber(cells[idx('displayed_pnl_usd') ?? -1]);
    row.profileUrl = cells[idx('profile_url') ?? -1]?.trim() || null;
    row.avatarUrl = cells[idx('avatar_url') ?? -1]?.trim() || null;
    const addrs = (cells[idx('solana_addresses') ?? -1] ?? '')
      .split('|')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    row.solanaAddresses = addrs;
    const enabled = cells[idx('enabled') ?? -1]?.trim().toLowerCase();
    row.enabled = enabled === '' || enabled === 'true' || enabled === '1' || enabled === 'yes';
    row.observedAt = cells[idx('observed_at') ?? -1]?.trim() || now.toISOString();
    rows.push(row);
  }
  return normalizeRows(rows, now, 'manual-csv');
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeRows(rows: Record<string, unknown>[], now: Date, source: string): LeaderboardImportResult {
  const warnings: string[] = [];
  const skipped: LeaderboardImportResult['skipped'] = [];
  const byHandle = new Map<string, LeaderboardEntry>();
  let index = 0;
  for (const row of rows) {
    index++;
    const parsed = entrySchema.safeParse(row);
    if (!parsed.success) {
      const handle = typeof row.handle === 'string' ? row.handle : `row ${index}`;
      skipped.push({ handle, reason: parsed.error.issues[0]?.message ?? 'invalid row' });
      continue;
    }
    const p = parsed.data;
    const handle = p.handle.trim();
    if (!handle) {
      skipped.push({ handle: `row ${index}`, reason: 'empty handle' });
      continue;
    }
    const addresses = (p.solanaAddresses ?? []).filter((a) => {
      if (base58Re.test(a)) return true;
      warnings.push(`${handle}: invalid-looking Solana address ignored (${a.slice(0, 6)}...)`);
      return false;
    });
    if ((p.solanaAddresses ?? []).length > 1) {
      warnings.push(
        `${handle}: multiple Solana addresses imported; eligibility will require resolving ambiguity`,
      );
    }
    const entry: LeaderboardEntry = {
      handle,
      weeklyRank: p.weeklyRank ?? null,
      displayedPnlUsd: p.displayedPnlUsd ?? null,
      profileUrl: p.profileUrl ?? null,
      avatarUrl: p.avatarUrl ?? null,
      solanaAddresses: addresses,
      enabled: p.enabled ?? true,
      observedAt: p.observedAt ?? now.toISOString(),
    };
    if (Number.isNaN(Date.parse(entry.observedAt))) {
      warnings.push(`${handle}: unparseable observedAt, replaced with import time`);
      entry.observedAt = now.toISOString();
    }
    if (byHandle.has(handle)) warnings.push(`${handle}: duplicate handle, later row (from ${source}) wins`);
    byHandle.set(handle, entry);
  }
  return { entries: [...byHandle.values()], importId: randomUUID(), warnings, skipped };
}

export class ManualLeaderboardProvider {
  readonly name = 'manual';
  async available(): Promise<boolean> {
    return true;
  }
  async fetchLatest(): Promise<LeaderboardImportResult> {
    throw new Error('manual provider is import-driven; call parseManualJson/parseManualCsv');
  }
}
