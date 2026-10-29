import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Personal-Chrome profile copy for the Fomo adapter.
 *
 * Why: Google refuses OAuth in automation browsers and (since Chrome 136)
 * blocks remote debugging on the default user-data-dir outright, so the
 * adapter can never log in to Fomo through Google by itself. Instead we run
 * the adapter on a SELECTIVE copy of the operator's real desktop Chrome
 * profile (cookies + local storage only — no caches), refreshed whenever the
 * real Chrome is closed. The operator's existing Fomo/Google session is thus
 * reused with no login ceremony; credentials are never read or transmitted.
 *
 * The copy lives under DATA_DIR and is only ever pointed at the configured
 * fomo URLs by the adapter.
 */

export interface PersonalProfileSyncOptions {
  /** Real Chrome user-data dir, e.g. %LOCALAPPDATA%\Google\Chrome\User Data. */
  sourceDir: string;
  /** Adapter profile dir (a selective mirror of sourceDir). */
  copyDir: string;
  /** Refresh the copy when older than this AND Chrome is closed. */
  staleAfterMs: number;
}

/** Profile pieces that carry login state; deliberately excludes caches. */
const REL_PATHS = [
  'Local State',
  'Default/Network/Cookies',
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/Preferences',
  'Default/Secure Preferences',
];

export function isChromeRunningOnProfile(sourceDir: string): boolean {
  try {
    const needle = sourceDir.replace(/'/g, "''");
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${needle}*' } | Measure-Object).Count"`,
      { encoding: 'utf8', timeout: 30_000 },
    );
    return Number(out.trim()) > 0;
  } catch {
    return true; // cannot determine -> assume in use (never copy under contention)
  }
}

/**
 * Stream copy via read/write: copyFileSync fails with EPERM on files that
 * Chrome's flush leaves with restrictive sharing modes, while a plain
 * read+write copies them fine.
 */
function copyFileStreaming(src: string, dest: string): void {
  writeFileSync(dest, readFileSync(src));
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDirRecursive(s, d);
    else copyFileStreaming(s, d);
  }
}

function copyItem(src: string, dest: string): void {
  if (!existsSync(src)) return;
  if (statSync(src).isDirectory()) copyDirRecursive(src, dest);
  else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileStreaming(src, dest);
  }
}

export function syncPersonalChromeProfile(opts: PersonalProfileSyncOptions): {
  synced: boolean;
  reason: string;
} {
  if (!existsSync(opts.sourceDir)) return { synced: false, reason: 'personal Chrome profile not found' };
  const marker = join(opts.copyDir, '.sync-stamp');
  if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < opts.staleAfterMs) {
    return { synced: false, reason: 'profile copy is fresh' };
  }
  if (isChromeRunningOnProfile(opts.sourceDir)) {
    return {
      synced: false,
      reason: 'personal Chrome is open; copy skipped (use existing, retry refresh later)',
    };
  }
  for (const rel of REL_PATHS) copyItem(join(opts.sourceDir, rel), join(opts.copyDir, rel));
  mkdirSync(opts.copyDir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());
  return { synced: true, reason: 'profile copy refreshed from personal Chrome' };
}
