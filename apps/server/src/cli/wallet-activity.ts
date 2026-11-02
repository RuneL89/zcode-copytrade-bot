/**
 * Ad-hoc copyable-activity check for ONE wallet via the free public Solana RPC,
 * with Jupiter prices for the $1 floor and the "can we buy this coin" test.
 * Prints the same numbers the activity refresh stores — useful to verify a
 * leader's wallet without spending Helius credits or touching the database.
 *
 * usage: tsx src/cli/wallet-activity.ts <address> [--hours 24]
 * Read-only; writes nothing.
 */
import { loadAppConfig } from '../bootstrap.js';
import {
  HeliusProvider,
  JupiterPriceProvider,
  JupiterProvider,
  PublicSolanaProvider,
} from '@zcode-bot/providers';
import { checkWalletActivity } from '../services/activity-check.js';

async function main() {
  const args = process.argv.slice(2);
  const address = args.find((a) => !a.startsWith('--'));
  const hoursFlag = args.indexOf('--hours');
  const hours = hoursFlag !== -1 ? Number(args[hoursFlag + 1]) || 24 : 24;
  if (!address) {
    console.error('usage: tsx src/cli/wallet-activity.ts <address> [--hours 24]');
    process.exit(1);
  }

  const config = loadAppConfig();
  const helius = new HeliusProvider(config.env.HELIUS_API_KEY);
  const publicSolana = new PublicSolanaProvider(config.env.PUBLIC_SOLANA_RPC_URL, 4, helius);
  if (!publicSolana.configured) {
    console.error('no provider: set PUBLIC_SOLANA_RPC_URL');
    process.exit(1);
  }
  const jupiter = new JupiterProvider(config.env.JUPITER_BASE_URL, config.env.JUPITER_API_KEY);
  const prices = new JupiterPriceProvider(jupiter, config.risk.PRICE_MAX_AGE_SECONDS * 1000);

  console.log('checking ' + address + ' (lookback ' + hours + 'h, public RPC + Jupiter quotes)…');
  const reading = await checkWalletActivity(publicSolana, prices, address, { lookbackHours: hours });
  const iso = (v: string | null) => (v ? v.replace('T', ' ').slice(0, 19) + 'Z' : 'none');
  console.log(
    JSON.stringify(
      {
        source: reading.source,
        copyableTrades: reading.copyableTrades24h,
        entries: reading.entries24h,
        exits: reading.exits24h,
        unattributedTrades: reading.unattributedTrades24h,
        lastTradeAt: iso(reading.lastTradeAt),
        lastEntryAt: iso(reading.lastEntryAt),
        pricedMints: reading.pricedMints,
        unbuyableMints: reading.unbuyableMints,
        scannedTxs: reading.scannedTxs,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
