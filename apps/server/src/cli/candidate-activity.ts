/**
 * Refresh on-chain activity (swaps in the last 24h + time since the last
 * swap) for enabled candidates that already have a wallet, using Helius.
 * These are the same numbers the pre-hire activity gate enforces, so the
 * research snapshot and the gate agree.
 *
 * usage: tsx src/cli/candidate-activity.ts [--limit 30]
 * Read-only on-chain; writes only the candidate activity columns.
 */
import { loadAppConfig } from '../bootstrap.js';
import { openDatabase, repo } from '@zcode-bot/db';
import { audit } from '@zcode-bot/db/repo.js';
import { HeliusProvider } from '@zcode-bot/providers';

async function main() {
  const args = process.argv.slice(2);
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? Number(args[limitFlag + 1]) || 30 : 30;

  const config = loadAppConfig();
  const db = openDatabase(config.env.DATA_DIR);
  const helius = new HeliusProvider(config.env.HELIUS_API_KEY);
  if (!helius.configured) {
    console.error('HELIUS_API_KEY is not configured');
    db.close();
    process.exit(1);
  }

  const wallets = new Map<string, string>();
  for (const a of repo.listCandidateAddresses(db.db)) {
    if (a.chain === 'solana' && !wallets.has(a.candidateId)) wallets.set(a.candidateId, a.address);
  }
  const targets = repo
    .listCandidates(db.db)
    .filter((c) => c.enabled && wallets.has(c.candidateId))
    .sort((x, y) => {
      const ax = x.activityCheckedAt ?? '';
      const ay = y.activityCheckedAt ?? '';
      return ax < ay ? -1 : ax > ay ? 1 : 0;
    })
    .slice(0, limit);
  if (targets.length === 0) {
    console.log('nothing to refresh: no enabled candidate has a wallet');
    db.close();
    return;
  }
  console.log('refreshing activity for ' + targets.length + ' candidate(s)…');

  const nowIso = new Date().toISOString();
  let verified = 0;
  let failed = 0;
  for (const cand of targets) {
    const address = wallets.get(cand.candidateId);
    if (!address) continue;
    try {
      const activity = await helius.walletActivity24h(address);
      const lastSwapAt =
        activity.lastSwapAgeHours === null
          ? null
          : new Date(Date.now() - activity.lastSwapAgeHours * 3600_000).toISOString();
      repo.updateCandidateActivity(db.db, cand.candidateId, {
        swaps24h: activity.swaps24h,
        lastSwapAt,
        checkedAt: nowIso,
      });
      const passesGate =
        activity.lastSwapAgeHours !== null &&
        activity.lastSwapAgeHours <= config.risk.MAX_LEADER_STALL_HOURS &&
        activity.swaps24h >= config.risk.MIN_LEADER_SWAPS_24H;
      if (passesGate) {
        repo.upgradeCandidateAddressVerification(db.db, cand.candidateId, 'solana', address);
        verified++;
      }
      console.log(
        '  ' +
          cand.handle.padEnd(18) +
          ' swaps24h=' +
          activity.swaps24h +
          ' lastSwapAge=' +
          (activity.lastSwapAgeHours === null ? 'none' : activity.lastSwapAgeHours.toFixed(1) + 'h') +
          (passesGate ? ' [gate: pass]' : ' [gate: fail]'),
      );
    } catch (e) {
      failed++;
      console.warn('  ' + cand.handle + ': ' + (e as Error).message);
    }
  }

  audit(db.db, 'activity', 'CLI activity refresh: ' + verified + ' verified, ' + failed + ' failed', {});
  db.close();
  console.log('done: ' + verified + ' verified, ' + failed + ' failed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
