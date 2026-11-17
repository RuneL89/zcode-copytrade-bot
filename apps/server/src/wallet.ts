import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import nacl from 'tweetnacl';

/**
 * Dedicated Solana hot wallet. The secret key is encrypted at rest with
 * AES-256-GCM; the key is derived (scrypt) from a user-supplied local
 * encryption secret that is prompted for in the terminal and NEVER stored,
 * logged, printed, or sent to the browser or MCP process.
 */

export interface EncryptedWalletFile {
  version: 1;
  publicKey: string;
  createdAt: string;
  kdf: 'scrypt';
  salt: string; // base64
  cipher: 'aes-256-gcm';
  iv: string; // base64
  authTag: string; // base64
  ciphertext: string; // base64
}

export interface GeneratedWallet {
  publicKey: string;
  file: string;
}

// tweetnacl-util is tiny; avoid the extra dependency with local helpers.
const b64 = {
  encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  decode: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
};

/**
 * Create the encrypted wallet. `walletFile` wins over the default
 * `DATA_DIR/wallet/zcode-bot-wallet.json`; every reader (readiness, bootstrap,
 * engine, fee ledger, withdrawal, CLIs) must pass the same configured path.
 */
export function generateWalletFile(
  dataDir: string,
  encryptionSecret: string,
  now = new Date(),
  walletFile?: string,
): GeneratedWallet {
  if (encryptionSecret.trim().length < 16) {
    throw new Error('encryption secret must be at least 16 characters');
  }
  const keypair = nacl.sign.keyPair();
  const publicKey = b58Encode(keypair.publicKey);
  const salt = randomBytes(16);
  const key = scryptSync(encryptionSecret, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({ secretKey: b64.encode(keypair.secretKey) }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const file: EncryptedWalletFile = {
    version: 1,
    publicKey,
    createdAt: now.toISOString(),
    kdf: 'scrypt',
    salt: b64.encode(salt),
    cipher: 'aes-256-gcm',
    iv: b64.encode(iv),
    authTag: b64.encode(cipher.getAuthTag()),
    ciphertext: ciphertext.toString('base64'),
  };
  const path = walletFilePath(dataDir, walletFile);
  if (existsSync(path)) {
    throw new Error(
      `wallet file already exists; refusing to overwrite (back it up and remove it first): ${path}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows NTFS: POSIX modes are advisory; ownership-based ACLs apply.
  }
  return { publicKey, file: path };
}

export function walletFilePath(dataDir: string, walletFile?: string): string {
  const explicit = walletFile?.trim();
  return explicit ? explicit : join(dataDir, 'wallet', 'zcode-bot-wallet.json');
}

export function loadWalletSecretFromFile(path: string, encryptionSecret: string): Uint8Array {
  if (!existsSync(path)) throw new Error('no wallet file; run `pnpm wallet:create` first');
  const file = JSON.parse(readFileSync(path, 'utf8')) as EncryptedWalletFile;
  const key = scryptSync(encryptionSecret, b64.decode(file.salt), 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv('aes-256-gcm', key, b64.decode(file.iv));
  decipher.setAuthTag(Buffer.from(b64.decode(file.authTag)));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString('utf8')) as { secretKey: string };
    return b64.decode(parsed.secretKey);
  } catch {
    throw new Error('wallet decryption failed (wrong encryption secret or corrupted file)');
  }
}

export function loadWalletSecret(dataDir: string, encryptionSecret: string, walletFile?: string): Uint8Array {
  return loadWalletSecretFromFile(walletFilePath(dataDir, walletFile), encryptionSecret);
}

export function walletExists(dataDir: string, walletFile?: string): boolean {
  return existsSync(walletFilePath(dataDir, walletFile));
}

export function walletPublicKey(dataDir: string, walletFile?: string): string | null {
  const path = walletFilePath(dataDir, walletFile);
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, 'utf8')) as EncryptedWalletFile;
  return file.publicKey;
}

/** Reject world-readable wallet files where the platform supports mode bits. */
export function checkWalletFilePermissions(path: string): { ok: boolean; detail: string } {
  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      return { ok: false, detail: `wallet file mode ${mode.toString(8)} is too permissive; expected 600` };
    }
    return { ok: true, detail: 'ok' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

// Minimal base58 (Bitcoin alphabet) encoder — avoids a runtime dependency for
// one function; bs58 stays available for decode paths in the live executor.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let n = BigInt(0);
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n = n / 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

/** Deterministic hash helper for idempotency keys. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
