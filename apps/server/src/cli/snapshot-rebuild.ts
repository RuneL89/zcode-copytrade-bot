import { loadAppConfig } from '../bootstrap.js';
import { openDatabase } from '@zcode-bot/db';
import { SnapshotService } from '../services/research.js';

/**
 * Publish a research snapshot immediately, without restarting the server.
 *
 * The canonical fetch procedure used to say "delete research_snapshots and run
 * launch.bat", which is unacceptable for an unattended refresh loop. This CLI
 * rebuilds the same derived snapshot the runtime publishes every 30 minutes:
 * it reads the candidate pool, writes research_snapshots + snapshot.json, and
 * audits the publish. WAL + busy_timeout make it safe while the server runs.
 *
 * usage: tsx src/cli/snapshot-rebuild.ts
 */
function main(): void {
  const config = loadAppConfig();
  const handle = openDatabase(config.env.DATA_DIR);
  try {
    const snapshots = new SnapshotService(handle.db, config.env.DATA_DIR, config.risk);
    const snapshot = snapshots.build();
    const observedAts = snapshot.candidates.map((c) => c.observedAt).sort();
    console.log(
      JSON.stringify(
        {
          snapshotId: snapshot.snapshotId,
          candidates: snapshot.candidates.length,
          sourceFreshnessSeconds: snapshot.sourceFreshnessSeconds,
          oldestObservedAt: snapshot.oldestObservedAt ?? null,
          staleCandidateCount: snapshot.staleCandidateCount ?? 0,
          freshestObservedAt: observedAts.length ? observedAts[observedAts.length - 1] : null,
        },
        null,
        1,
      ),
    );
  } finally {
    handle.close();
  }
}

main();
