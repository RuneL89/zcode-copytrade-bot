import { createInterface } from 'node:readline';
import { generateWalletFile, checkWalletFilePermissions } from '../wallet.js';
import { loadAppConfig } from '../bootstrap.js';

function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    // Muted echo: characters are replaced with nothing (no secret in TTY scrollback).
    const stdin = process.stdin;
    const onData = (ch: Buffer) => {
      const s = ch.toString('utf8');
      if (s === '\r' || s === '\n') return;
      // clear the just-typed character
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(question);
    };
    if (stdin.isTTY) stdin.on('data', onData);
    rl.question(question, (answer) => {
      if (stdin.isTTY) stdin.off('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolvePromise(answer);
    });
  });
}

async function main() {
  const config = loadAppConfig();
  console.log('ZCode Bot — dedicated Solana hot wallet creation\n');
  console.log('The wallet is encrypted locally (AES-256-GCM, scrypt-derived key).');
  console.log('The encryption secret is ONLY in your head — losing it means losing the wallet.\n');

  const secret = await promptSecret(
    'Enter an encryption secret (min 16 chars, never stored, never in chat): ',
  );
  const confirm = await promptSecret('Repeat the encryption secret: ');
  if (secret !== confirm) {
    console.error('secrets do not match; aborting');
    process.exit(1);
  }

  const { publicKey, file } = generateWalletFile(config.env.DATA_DIR, secret);
  const perms = checkWalletFilePermissions(file);

  console.log('\nWallet created.');
  console.log(`  Public address: ${publicKey}`);
  console.log(`  Encrypted file: ${file}`);
  if (!perms.ok) console.warn(`  WARNING: file permissions: ${perms.detail}`);
  console.log('\nBackup procedure:');
  console.log('  1. Copy the encrypted wallet file to TWO offline locations (USB, encrypted drive).');
  console.log('  2. Store the encryption secret separately from the file (password manager / paper).');
  console.log('  3. To restore: install ZCode Bot anywhere, place the file under DATA_DIR/wallet/,');
  console.log('     and provide the encryption secret when arming live mode.');
  console.log('\nFund this dedicated hot wallet with a LIMITED operating balance only.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
