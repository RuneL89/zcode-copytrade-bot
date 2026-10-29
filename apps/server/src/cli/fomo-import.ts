import { readFileSync } from 'node:fs';
import { loadAppConfig } from '../bootstrap.js';
import { openDatabase } from '@zcode-bot/db';
import { repo } from '@zcode-bot/db';
import { audit } from '@zcode-bot/db/repo.js';

interface ManualEntry {
  handle: string;
  rank?: number | null;
  pnlUsd?: number | null;
  address?: string | null;
  profileUrl?: string | null;
  /** Day-trader signals captured in the same GUI pass (clipboard, no OCR). */
  avgHoldHours?: number | null;
  trades7d?: number | null;
  winRatePct?: number | null;
  realizedOnchainUsd?: number | null;
}

function sanitizeCandidateId(handle: string): string {
  return 'cand_' + handle.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}

function isLikelySolanaAddress(value: string): boolean {
  const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return value.length >= 32 && value.length <= 44 && base58.test(value);
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: tsx src/cli/fomo-import.ts <entries.json>');
    console.error(
      'entries.json: [{"handle":"unipcs","rank":1,"pnlUsd":155003.6,"address":"...","profileUrl":"https://fomo.family/profile/unipcs"}]',
    );
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`cannot read/parse ${path}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('expected a non-empty JSON array of entries');
    process.exit(1);
  }

  const config = loadAppConfig();
  const dataDir = config.env.DATA_DIR;
  const handle = openDatabase(dataDir);
  const observedAt = new Date().toISOString();
  const importId = 'manual-' + Date.now();
  let imported = 0;
  const warnings: string[] = [];
  const rankCounts = new Map<number, string[]>();

  for (const raw of parsed as Record<string, unknown>[]) {
    const entry = raw as unknown as ManualEntry;
    const handleName = typeof entry.handle === 'string' ? entry.handle.trim().replace(/^@/, '') : '';
    if (!handleName) {
      warnings.push('skipped entry without handle');
      continue;
    }
    const rank =
      typeof entry.rank === 'number' && Number.isFinite(entry.rank) && entry.rank >= 1
        ? Math.trunc(entry.rank)
        : null;
    const pnlUsd = typeof entry.pnlUsd === 'number' && Number.isFinite(entry.pnlUsd) ? entry.pnlUsd : null;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const avgHoldHours = num(entry.avgHoldHours);
    const trades7d = num(entry.trades7d);
    const winRatePct = num(entry.winRatePct);
    const realizedOnchainUsd = num(entry.realizedOnchainUsd);
    const address = typeof entry.address === 'string' ? entry.address.trim() : '';
    if (address && !isLikelySolanaAddress(address)) {
      warnings.push(`${handleName}: address does not look like a Solana address; skipping address`);
    }
    const candidateId = sanitizeCandidateId(handleName);
    repo.upsertCandidate(handle.db, {
      candidateId,
      handle: handleName,
      weeklyRank: rank,
      displayedWeeklyPnlUsdMicro: pnlUsd !== null ? BigInt(Math.trunc(pnlUsd * 1e6)).toString() : null,
      profileUrl: typeof entry.profileUrl === 'string' && entry.profileUrl ? entry.profileUrl : null,
      avatarUrl: null,
      enabled: true,
      source: 'fomo-web-manual',
      // undefined = "not captured by this import", so the repo preserves
      // whatever Dawn or Helius already stored (explicit null would clear it).
      avgHoldHours: avgHoldHours ?? undefined,
      tradesCount7d: trades7d ?? undefined,
      winRatePct: winRatePct ?? undefined,
      realizedOnchainUsd: realizedOnchainUsd ?? undefined,
      statsCheckedAt: avgHoldHours !== null || trades7d !== null ? observedAt : undefined,
      observedAt,
    });
    if (address && isLikelySolanaAddress(address)) {
      repo.upsertCandidateAddress(handle.db, candidateId, {
        chain: 'solana',
        address,
        verification: 'reported',
      });
    }
    repo.recordLeaderboardObservation(handle.db, {
      handle: handleName,
      weeklyRank: rank,
      displayedPnlUsdMicro: pnlUsd !== null ? BigInt(Math.trunc(pnlUsd * 1e6)).toString() : null,
      source: 'fomo-web-manual',
      observedAt,
      importId,
    });
    if (rank !== null) {
      const seen = rankCounts.get(rank) ?? [];
      seen.push(handleName);
      rankCounts.set(rank, seen);
    }
    imported++;
  }

  for (const [rank, handles] of rankCounts) {
    if (handles.length > 1) {
      warnings.push('duplicate weekly rank ' + rank + ': ' + handles.join(', '));
    }
  }

  audit(handle.db, 'fomo-web-manual', `manual leaderboard import: ${imported} candidates`, {
    importId,
    warnings: warnings.slice(0, 10),
  });
  handle.close();

  console.log(`imported ${imported} candidates (importId ${importId})`);
  for (const w of warnings) console.log(`warning: ${w}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
