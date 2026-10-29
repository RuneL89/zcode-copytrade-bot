/**
 * Seed: create the initial research snapshot dir + optionally load example
 * leaderboard fixtures. Run AFTER db:migrate. Never inserts demo fixtures
 * into live trading tables (demo mode is fully in-memory).
 */
import { openDatabase } from './connection.js';
import * as repo from './repo.js';
import { parseManualJson } from '@zcode-bot/providers';
import { findRepoRoot, resolveDataDir } from '@zcode-bot/config';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// cwd is packages/db here (pnpm --filter); anchor everything at the workspace root.
const repoRoot = findRepoRoot(import.meta.url);

async function main() {
  const dataDir = resolveDataDir(process.argv[2] ?? process.env.DATA_DIR ?? './data', repoRoot);
  const handle = openDatabase(dataDir);
  const db = handle.db;
  try {
    // Research dirs used by the MCP server.
    mkdirSync(join(dataDir, 'research', 'snapshot'), { recursive: true });
    mkdirSync(join(dataDir, 'research', 'inbox'), { recursive: true });

    // Optional: import the example manual leaderboard fixture.
    const example = resolve(repoRoot, 'fixtures', 'leaderboard.example.json');
    if (existsSync(example)) {
      const parsed = parseManualJson(readFileSync(example, 'utf-8'));
      for (const entry of parsed.entries) {
        const candidateId = 'cand_' + entry.handle.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        repo.upsertCandidate(db, {
          candidateId,
          handle: entry.handle,
          weeklyRank: entry.weeklyRank,
          displayedWeeklyPnlUsdMicro:
            entry.displayedPnlUsd !== null
              ? BigInt(Math.trunc(entry.displayedPnlUsd * 1e6)).toString()
              : null,
          profileUrl: entry.profileUrl,
          avatarUrl: entry.avatarUrl,
          enabled: entry.enabled,
          source: 'manual',
          observedAt: entry.observedAt,
        });
        for (const addr of entry.solanaAddresses) {
          repo.upsertCandidateAddress(db, candidateId, {
            chain: 'solana',
            address: addr,
            verification: 'reported',
          });
        }
        repo.recordLeaderboardObservation(db, {
          handle: entry.handle,
          weeklyRank: entry.weeklyRank,
          displayedPnlUsdMicro:
            entry.displayedPnlUsd !== null
              ? BigInt(Math.trunc(entry.displayedPnlUsd * 1e6)).toString()
              : null,
          source: 'seed',
          observedAt: entry.observedAt,
          importId: parsed.importId,
        });
      }
      console.log(`seeded ${parsed.entries.length} candidates from ${example}`);
    }

    // Write a placeholder so operators see where sanitized snapshots live.
    const marker = join(dataDir, 'research', 'snapshot', '.gitkeep');
    if (!existsSync(marker)) writeFileSync(marker, '');

    console.log(`seed complete (data dir ${resolve(dataDir)})`);
  } finally {
    handle.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
