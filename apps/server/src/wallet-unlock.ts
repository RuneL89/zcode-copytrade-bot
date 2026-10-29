import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Unattended wallet unlock for restarts.
 *
 * The wallet file stays AES-256-GCM encrypted under the operator's passphrase.
 * That passphrase is additionally sealed with Windows DPAPI (CurrentUser scope)
 * so a restart can restore live arming without the passphrase ever sitting in
 * plaintext on disk. The sealed blob is usable only by this Windows account:
 * copying the data directory to another machine does not unlock it.
 *
 * The secret travels over stdin, never argv, so it cannot leak through the
 * process table while PowerShell runs.
 */

const UNLOCK_FILE = 'wallet-unlock.dpapi';

function powershell(script: string, input: string): string {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  if (res.error) throw new Error(`dpapi: ${res.error.message}`);
  if (res.status !== 0) {
    const err = (res.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`dpapi: powershell exited ${res.status}${err ? ` (${err})` : ''}`);
  }
  const out = (res.stdout || '').trim();
  if (!out) throw new Error('dpapi: empty response from powershell');
  return out;
}

// Windows PowerShell 5.1 does not expose ProtectedData until System.Security
// is loaded, so both scripts add it explicitly.
const PROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Console]::In.ReadToEnd().Trim();' +
  '$p=[System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($b),$null,"CurrentUser");' +
  '[Console]::Out.Write([Convert]::ToBase64String($p))';

const UNPROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Console]::In.ReadToEnd().Trim();' +
  '$p=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b),$null,"CurrentUser");' +
  '[Console]::Out.Write([Convert]::ToBase64String($p))';

export function unattendedUnlockSupported(): boolean {
  return process.platform === 'win32';
}

/**
 * Seal the wallet passphrase for unattended re-arming.
 * Returns false when the platform cannot do it (arming still works, it just
 * will not survive a restart).
 */
export function rememberWalletPassphrase(dataDir: string, passphrase: string): boolean {
  if (!unattendedUnlockSupported() || passphrase.length === 0) return false;
  mkdirSync(dataDir, { recursive: true });
  const sealed = powershell(PROTECT, Buffer.from(passphrase, 'utf8').toString('base64'));
  writeFileSync(join(dataDir, UNLOCK_FILE), sealed, 'utf8');
  return true;
}

/**
 * Read the sealed passphrase. Returns null when none is stored; throws when a
 * blob exists but cannot be unsealed (different Windows account, corrupted).
 */
export function readRememberedPassphrase(dataDir: string): string | null {
  const path = join(dataDir, UNLOCK_FILE);
  if (!existsSync(path)) return null;
  const sealed = readFileSync(path, 'utf8').trim();
  if (!sealed) return null;
  return Buffer.from(powershell(UNPROTECT, sealed), 'base64').toString('utf8');
}

/** Drop the sealed passphrase — an explicit disarm must not auto-rearm later. */
export function forgetWalletPassphrase(dataDir: string | null): void {
  if (!dataDir) return;
  rmSync(join(dataDir, UNLOCK_FILE), { force: true });
}
