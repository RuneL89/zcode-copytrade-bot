import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppConfig } from '../bootstrap.js';
import { openDatabase } from '@zcode-bot/db';
import { HeliusProvider } from '@zcode-bot/providers';
import { formatBaseAmount, USDC_DECIMALS, SOL_DECIMALS } from '@zcode-bot/core';
import { ControlService } from '../services/control.js';
import { WithdrawalService, createSolanaBroadcaster, heliusRpcUrl } from '../services/withdraw.js';
import { createTradingLocks } from '../services/locks.js';
import { walletExists } from '../wallet.js';

/**
 * Withdraw from the bot's wallet, from a terminal.
 *
 * Shows what is actually available (bankroll only — funds in open positions
 * cannot leave), asks for destination/amount, unlocks the wallet with the
 * encryption secret (never echoed, never stored), requires typing SEND, then
 * prints the transaction signature. The private key is never displayed.
 *
 * Exit codes: 0 sent, 1 refused/failed, 2 submitted but unconfirmed.
 */

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveProm) =>
    rl.question(question, (answer) => {
      rl.close();
      resolveProm(answer.trim());
    }),
  );
}

/** Prompt without echoing what is typed (same approach as wallet-create). */
function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { stdin, stdout } = process;
  const onData = (ch: Buffer) => {
    const text = ch.toString();
    if (ch[0] === 3) process.exit(130); // Ctrl-C
    if (ch[0] === 10 || ch[0] === 13) return; // newline is handled by rl
    if (text.includes('\r') || text.includes('\n')) return;
    stdout.clearLine(0);
    stdout.cursorTo(0);
    stdout.write(question + '*'.repeat(1));
  };
  if (stdin.isTTY) stdin.on('data', onData);
  return new Promise((resolveProm) =>
    rl.question(question, (answer) => {
      if (stdin.isTTY) stdin.off('data', onData);
      rl.close();
      stdout.write('\n');
      resolveProm(answer);
    }),
  );
}

function usdc(base: bigint): string {
  return formatBaseAmount(base, USDC_DECIMALS);
}

function sol(base: bigint): string {
  return formatBaseAmount(base, SOL_DECIMALS);
}

async function main(): Promise<number> {
  const config = loadAppConfig();
  const dataDir = config.env.DATA_DIR;
  if (!walletExists(dataDir, config.env.WALLET_FILE)) {
    console.error('No wallet found. Create one first (pnpm wallet:create or OPS → Create wallet).');
    return 1;
  }
  if (!existsSync(join(dataDir, 'zcode-bot.db'))) {
    console.error(`No database at ${dataDir}; is DATA_DIR correct?`);
    return 1;
  }

  const handle = openDatabase(dataDir);
  const control = new ControlService(handle.db);
  const helius = new HeliusProvider(config.env.HELIUS_API_KEY);
  // Same equity baseline the runtime uses, so "free cash" matches the dashboard.
  const equityStartUsdMicro =
    config.env.EQUITY_START_USD != null
      ? BigInt(Math.round(config.env.EQUITY_START_USD * 1_000_000))
      : 1_000_000_000n;
  const service = new WithdrawalService(
    handle.db,
    config,
    control,
    helius,
    equityStartUsdMicro,
    createSolanaBroadcaster(() => heliusRpcUrl(config.env.HELIUS_API_KEY)),
    createTradingLocks(),
  );

  try {
    const info = await service.available();
    console.log(`\nWallet: ${info.publicKey}`);
    console.log(
      `On chain:  ${info.usdcBase ? usdc(BigInt(info.usdcBase)) : '?'} USDC · ${
        info.solLamports ? sol(BigInt(info.solLamports)) : '?'
      } SOL`,
    );
    console.log(
      `Withdrawable (bankroll only): ${usdc(BigInt(info.withdrawableUsdcBase))} USDC · ${sol(
        BigInt(info.withdrawableSolBase),
      )} SOL`,
    );
    console.log(
      `Note: funds held in open positions cannot be withdrawn, and ${sol(
        BigInt(info.solReserveLamports),
      )} SOL stays behind for network fees.\n`,
    );

    const assetAnswer = (await prompt('Asset — type USDC or SOL: ')).toUpperCase();
    if (assetAnswer !== 'USDC' && assetAnswer !== 'SOL') {
      console.error('Unknown asset; nothing sent.');
      return 1;
    }
    const asset = assetAnswer;
    const destination = await prompt('Destination Solana address: ');
    const amount = await prompt(`Amount in ${asset} (e.g. 12.5): `);
    const walletSecret = await promptSecret('Wallet encryption secret (hidden): ');

    console.log('\n--- review ---');
    console.log(`Send:      ${amount} ${asset}`);
    console.log(`To:        ${destination}`);
    console.log(`From:      ${info.publicKey}`);
    const confirmation = await prompt('Type SEND to broadcast this transaction: ');
    if (confirmation !== 'SEND') {
      console.error('Not confirmed; nothing sent.');
      return 1;
    }

    const result = await service.send({
      asset,
      destination,
      amount,
      walletSecret,
      confirm: 'SEND',
    });

    if (!result.ok) {
      console.error(`\nRefused/failed: ${result.error} (${result.code})`);
      return 1;
    }
    if (result.unconfirmed) {
      console.error(`\nSubmitted but UNCONFIRMED — verify on chain, do not retry:`);
      console.log(`  https://solscan.io/tx/${result.signature}`);
      return 2;
    }
    console.log(
      `\nSent: ${formatBaseAmount(BigInt(result.amountBase), asset === 'SOL' ? SOL_DECIMALS : USDC_DECIMALS)} ${asset}`,
    );
    console.log(`Signature: ${result.signature}`);
    console.log(`Explorer:  https://solscan.io/tx/${result.signature}`);
    return 0;
  } finally {
    handle.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
