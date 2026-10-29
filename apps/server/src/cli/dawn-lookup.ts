/**
 * Resolve Solana wallet addresses for candidate handles via the Dawn Telegram
 * bot, reading the wallets Dawn displays for each fomo trader. Read-only on
 * Dawn: sends plain "@handle" text messages, never taps "Copy trader" and
 * never creates a copytrade task.
 *
 * usage:
 *   tsx src/cli/dawn-lookup.ts --handles unipcs,cosby,heat
 *   tsx src/cli/dawn-lookup.ts --all-missing [--limit 25]
 *
 * The Telegram Web session must already exist in the dedicated profile
 * (data/browser-profile-dawn): scan the QR once via the dashboard action
 * "Open Telegram (Dawn) browser for login". Prefer that dashboard action
 * ("Resolve trader addresses via Dawn") while the server is running — it
 * owns the same browser profile.
 */
import { join } from 'node:path';
import { loadAppConfig } from '../bootstrap.js';
import { openDatabase, repo } from '@zcode-bot/db';
import { audit } from '@zcode-bot/db/repo.js';
import { DawnNeedsLoginError, DawnTraderLookupProvider, DEFAULT_DAWN_CONFIG } from '@zcode-bot/providers';

function sanitizeCandidateId(handle: string): string {
  return 'cand_' + handle.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}

async function main() {
  const args = process.argv.slice(2);
  const handlesFlag = args.indexOf('--handles');
  const allMissing = args.includes('--all-missing');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? Number(args[limitFlag + 1]) || 25 : 25;
  if (handlesFlag === -1 && !allMissing) {
    console.error('usage: tsx src/cli/dawn-lookup.ts --handles a,b,c | --all-missing [--limit N]');
    process.exit(1);
  }

  const config = loadAppConfig();
  const db = openDatabase(config.env.DATA_DIR);

  let targets: { candidateId: string; handle: string; profileUrl?: string }[] = [];
  if (handlesFlag !== -1) {
    const handles = (args[handlesFlag + 1] ?? '')
      .split(',')
      .map((h) => h.trim().replace(/^@/, ''))
      .filter(Boolean);
    const known = new Map(repo.listCandidates(db.db).map((c) => [c.candidateId, c]));
    for (const h of handles) {
      const id = sanitizeCandidateId(h);
      const row = known.get(id);
      if (row)
        targets.push({
          candidateId: id,
          handle: row.handle,
          profileUrl: (row as { profileUrl?: string | null }).profileUrl ?? undefined,
        });
      else console.warn(`warning: no candidate for handle ${h} (import it first via fomo-import)`);
    }
  } else {
    const have = new Set(
      repo
        .listCandidateAddresses(db.db)
        .filter((a) => a.chain === 'solana')
        .map((a) => a.candidateId),
    );
    const staleCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const all = repo.listCandidates(db.db).filter((c) => c.enabled);
    // Discovery first (no wallet yet), then the freshness wave (stats older
    // than 24h) — the same two queues the scheduled runtime run uses.
    const walletless = all.filter((c) => !have.has(c.candidateId));
    const staleStats = all.filter(
      (c) => have.has(c.candidateId) && (c.statsCheckedAt == null || c.statsCheckedAt < staleCutoff),
    );
    targets = [...walletless, ...staleStats].slice(0, limit).map((c) => ({
      candidateId: c.candidateId,
      handle: c.handle,
      profileUrl: (c as { profileUrl?: string | null }).profileUrl ?? undefined,
    }));
  }
  if (targets.length === 0) {
    console.log('nothing to do: every enabled candidate has a wallet and fresh stats');
    db.close();
    return;
  }
  console.log(
    `resolving ${targets.length} handle(s) via @${config.env.DAWN_BOT_USERNAME ?? 'DawnTradeBot'}…`,
  );

  const provider = new DawnTraderLookupProvider({
    ...DEFAULT_DAWN_CONFIG,
    botUsername: config.env.DAWN_BOT_USERNAME ?? 'DawnTradeBot',
    webAppUrl: config.env.DAWN_WEB_URL,
    profileDir: join(config.env.DATA_DIR, 'browser-profile-dawn'),
    channel: config.env.DAWN_BROWSER_CHANNEL,
    headless: false,
  });

  try {
    const state = await provider.sessionState();
    if (state === 'needs-login') {
      await provider.openForManualLogin();
      console.error(
        'Telegram Web session missing: QR login window opened — scan it with your phone, then rerun.',
      );
      db.close();
      process.exit(2);
    }
  } catch (e) {
    console.error(`session check failed (fail closed): ${(e as Error).message}`);
    db.close();
    process.exit(1);
  }

  let resolved = 0;
  let failed = 0;
  const warnings: string[] = [];
  for (const t of targets) {
    try {
      const info = await provider.lookupHandle(t.handle, t.profileUrl);
      if (info.solanaAddress) {
        repo.upsertCandidateAddress(db.db, t.candidateId, {
          chain: 'solana',
          address: info.solanaAddress,
          verification: 'reported',
        });
        resolved++;
      } else {
        failed++;
        warnings.push(`${t.handle}: no Solana address in Dawn reply`);
      }
      // Persist everything the card carried (nulls are skipped by the repo,
      // so a compact card never erases a richer earlier reading).
      repo.updateCandidateStats(db.db, t.candidateId, {
        winRatePct: info.winRatePct,
        realizedOnchainUsd: info.realizedOnchainUsd,
        pnl24hUsd: info.pnl24hUsd,
        pnl7dUsd: info.pnl7dUsd,
        pnl30dUsd: info.pnl30dUsd,
        pnlAllTimeUsd: info.pnlAllTimeUsd,
        rank24h: info.rank24h,
        rank7d: info.rank7d,
        rankAllTime: info.rankAllTime,
        tradesTotal: info.tradesTotal,
        volumeUsd: info.volumeUsd,
        recentBuys: info.recentBuys,
        recentSells: info.recentSells,
        coinsTraded: info.coinsTraded,
        lastTradeAgeHours: info.lastTradeAgeHours,
        checkedAt: new Date().toISOString(),
      });
      const money = (v: number | null): string =>
        v === null ? '?' : '$' + Math.round(v).toLocaleString('en-US');
      console.log(
        '  ' +
          t.handle.padEnd(18) +
          ' [' +
          info.cardVariant +
          '] pnl24h=' +
          money(info.pnl24hUsd) +
          ' pnl7d=' +
          money(info.pnl7dUsd) +
          ' pnl30d=' +
          money(info.pnl30dUsd) +
          ' trades=' +
          (info.tradesTotal ?? '?') +
          ' lastTrade=' +
          (info.lastTradeAgeHours ?? '?') +
          'h',
      );
    } catch (e) {
      if (e instanceof DawnNeedsLoginError) {
        console.error(`session lost mid-run; rerun to continue (${(e as Error).message})`);
        break;
      }
      failed++;
      warnings.push(`${t.handle}: ${(e as Error).message}`);
      console.warn(`  ${t.handle}: failed: ${(e as Error).message}`);
    }
  }

  audit(db.db, 'dawn-lookup', `CLI resolved ${resolved} address(es), ${failed} unresolved`, {
    warnings: warnings.slice(0, 10),
  });
  await provider.close();
  db.close();
  console.log(`done: ${resolved} resolved, ${failed} unresolved`);
  if (failed > 0 && resolved === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
