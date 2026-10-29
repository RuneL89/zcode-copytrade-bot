import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo-root path resolution.
 *
 * `pnpm --filter <pkg> run <script>` executes with the CURRENT WORKING
 * DIRECTORY set to that package's folder. Anything resolved from
 * `process.cwd()` — `dotenv` looking for `.env`, and a relative `DATA_DIR`
 * such as `./data` — therefore lands in the wrong place
 * (e.g. `packages/db/data` instead of `<repo>/data`).
 *
 * These helpers locate the workspace root by walking up from a module's own
 * file URL until `pnpm-workspace.yaml` is found, so the answer is identical
 * whether the code runs from `src` (tsx/vitest) or `dist` (node), and
 * independent of the shell's cwd.
 */

const MARKER = 'pnpm-workspace.yaml';

export function findRepoRoot(fromUrl: string | URL): string {
  // Accept a file:// URL (import.meta.url) or a plain filesystem path.
  const raw =
    fromUrl instanceof URL
      ? fileURLToPath(fromUrl)
      : fromUrl.startsWith('file:')
        ? fileURLToPath(fromUrl)
        : fromUrl;
  let dir = dirname(raw);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, MARKER))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the workspace root (${MARKER}) above ${raw}`);
}

/** Absolute data directory: relative values are anchored at the repo root. */
export function resolveDataDir(dataDir: string, repoRoot: string): string {
  return isAbsolute(dataDir) ? dataDir : resolve(repoRoot, dataDir.replace(/^\.\//, ''));
}
