/**
 * One fomoapi discovery run (D3 inlet), for manual/scheduled use outside the
 * server loop: unions the 24h/7d/30d boards plus the alerts feed into the
 * candidate pool and prints the counts and credits spent.
 *
 * usage: tsx src/cli/discovery-sync.ts [--force]
 *   (default: respects the D5 demand + rate-limit gate; --force skips it)
 *
 * A missing FOMOAPI_KEY, or a skipped run, is printed and exits 0 — nothing to
 * retry. A fatal error exits non-zero.
 */
import { loadAppConfig } from '../bootstrap.js';
import { openDatabase } from '@zcode-bot/db';
import { FomoApiClient } from '@zcode-bot/providers';
import { DiscoveryService } from '../services/discovery.js';

async function main() {
  const force = process.argv.slice(2).includes('--force');
  const config = loadAppConfig();
  const handle = openDatabase(config.env.DATA_DIR);
  try {
    const client = new FomoApiClient({
      baseUrl: config.env.FOMOAPI_BASE_URL,
      apiKey: config.env.FOMOAPI_KEY ?? '',
    });
    const service = new DiscoveryService(handle.db, client, config.risk);
    const demand = service.demand();
    console.log(
      `discovery: ${demand.promotableWatchWallets} promotable / ${demand.watchListWallets} watched, ` +
        `roster ${demand.rosterInUse}/${demand.rosterSize}, bench target ${demand.benchTarget}`,
    );
    const result = await service.syncDiscovery(force);
    if (result.skipped) {
      console.log(`skipped: ${result.reason}`);
      return;
    }
    console.log(
      JSON.stringify(
        {
          windows: result.windows.map((w) => ({
            window: w.window,
            ok: w.ok,
            notModified: w.notModified,
            rows: w.rows,
            error: w.error,
          })),
          traders: result.traders,
          new: result.tradersNew,
          updated: result.tradersUpdated,
          merged: result.merged,
          alertsAdded: result.alertsAdded,
          alertsError: result.alertsError,
          creditsSpent: result.creditsSpent,
          creditsRemaining: result.creditsRemaining,
        },
        null,
        2,
      ),
    );
    if (result.windows.length > 0 && result.windows.every((w) => !w.ok)) {
      console.error('every leaderboard window failed');
      process.exitCode = 1;
    }
  } finally {
    handle.close();
  }
}

main().catch((e: unknown) => {
  console.error(`discovery failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
