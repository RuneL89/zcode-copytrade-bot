/**
 * Refresh copyable on-chain activity for enabled candidates that already have a
 * wallet. "Activity" means COPYABLE COIN MOVEMENTS (operator decision,
 * 2026-11-01): any transaction the wallet signed that moved a priceable,
 * non-funding mint, whatever the quote asset. Raw transaction counts are gone —
 * fee payouts and dust were being counted as trading.
 *
 * Source: the free public Solana RPC classifier, plus a Jupiter price quote per
 * coin (at most five per wallet) so the $1 floor and "can we buy this coin"
 * both mean something. Helius is NOT used for measurement: its signature-count
 * call has no direction or per-mint data, and writing its numbers over a real
 * reading is what made every candidate look passive.
 *
 * usage: tsx src/cli/candidate-activity.ts [--limit 30]
 * Read-only on-chain; writes only the candidate activity columns.
 */
import { loadAppConfig } from '../bootstrap.js';
import { openDatabase, repo } from '@zcode-bot/db';
import { audit } from '@zcode-bot/db/repo.js';
import {
  HeliusProvider,
  JupiterPriceProvider,
  JupiterProvider,
  PublicSolanaProvider,
} from '@zcode-bot/providers';
import { checkWalletActivity } from '../services/activity-check.js';

async function main() {
  const args = process.argv.slice(2);
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? Number(args[limitFlag + 1]) || 30 : 30;
  if (args.includes('--source') && args[args.indexOf('--source') + 1] !== 'public') {
    console.error('candidate-activity measures copyable trades and only supports --source public');
    process.exit(1);
  }

  const config = loadAppConfig();
  const db = openDatabase(config.env.DATA_DIR);
  const helius = new HeliusProvider(config.env.HELIUS_API_KEY);
  const publicSolana = new PublicSolanaProvider(config.env.PUBLIC_SOLANA_RPC_URL, 4, helius);
  if (!publicSolana.configured) {
    console.error('PUBLIC_SOLANA_RPC_URL is empty — set the endpoint');
    db.close();
    process.exit(1);
  }
  const jupiter = new JupiterProvider(config.env.JUPITER_BASE_URL, config.env.JUPITER_API_KEY);
  const prices = new JupiterPriceProvider(jupiter, config.risk.PRICE_MAX_AGE_SECONDS * 1000);

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
  console.log('refreshing copyable activity for ' + targets.length + ' candidate(s) via public RPC…');

  const nowIso = new Date().toISOString();
  let verified = 0;
  let failed = 0;
  for (const cand of targets) {
    const address = wallets.get(cand.candidateId);
    if (!address) continue;
    try {
      const reading = await checkWalletActivity(publicSolana, prices, address, { lookbackHours: 24 });
      repo.updateCandidateActivity(db.db, cand.candidateId, {
        swaps24h: reading.copyableTrades24h,
        lastSwapAt: reading.lastTradeAt,
        lastBuyAt: reading.lastEntryAt,
        buys24h: reading.entries24h,
        sells24h: reading.exits24h,
        status: 'ok',
        checkedAt: nowIso,
      });
      const lastTradeAgeHours =
        reading.lastTradeAt === null ? null : (Date.now() - Date.parse(reading.lastTradeAt)) / 3_600_000;
      const passesGate =
        lastTradeAgeHours !== null &&
        lastTradeAgeHours <= config.risk.MAX_LEADER_STALL_HOURS &&
        reading.copyableTrades24h >= config.risk.MIN_LEADER_SWAPS_24H;
      if (passesGate) {
        repo.upgradeCandidateAddressVerification(db.db, cand.candidateId, 'solana', address);
        verified++;
      }
      console.log(
        '  ' +
          cand.handle.padEnd(18) +
          ' trades24h=' +
          reading.copyableTrades24h +
          ' entries=' +
          reading.entries24h +
          ' exits=' +
          reading.exits24h +
          ' lastTradeAge=' +
          (lastTradeAgeHours === null ? 'none' : lastTradeAgeHours.toFixed(1) + 'h') +
          (reading.unbuyableMints > 0 ? ' unbuyable=' + reading.unbuyableMints : '') +
          (passesGate ? ' [gate: pass]' : ' [gate: fail]'),
      );
    } catch (e) {
      failed++;
      repo.markCandidateActivityFailed(db.db, cand.candidateId, nowIso);
      console.warn('  ' + cand.handle + ': ' + (e as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  audit(
    db.db,
    'activity',
    'CLI activity refresh (copyable): ' + verified + ' verified, ' + failed + ' failed',
    {},
  );
  db.close();
  console.log('done: ' + verified + ' verified, ' + failed + ' failed');
}

main().catch((e) => {
  console.error('candidate-activity failed: ' + (e as Error).message);
  process.exit(1);
});
