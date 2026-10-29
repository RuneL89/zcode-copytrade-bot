import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { findRepoRoot, resolveDataDir } from '../src/paths.js';

/**
 * Regression: pnpm runs package scripts with cwd set to the package folder, so
 * anything resolved from process.cwd() (dotenv's .env, a relative DATA_DIR)
 * lands in the wrong place — this bit the installer (migrations went to
 * packages/db/data). Resolution must come from the module's own URL instead.
 */
describe('workspace path resolution', () => {
  const root = findRepoRoot(import.meta.url);

  it('finds the workspace root from a nested package file', () => {
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(join(root, 'apps', 'server'))).toBe(true);
    expect(existsSync(join(root, 'packages', 'db', 'drizzle'))).toBe(true);
    // The root is the repo itself, never a nested package folder.
    expect(root.endsWith(sep + 'zcode-bot')).toBe(true);
  });

  it('anchors a relative data dir at the workspace root, not the cwd', () => {
    expect(resolveDataDir('./data', root)).toBe(join(root, 'data'));
    expect(resolveDataDir('data', root)).toBe(join(root, 'data'));
    // Independently of where the process happens to be running.
    expect(resolveDataDir('./data', root)).not.toContain(join('packages', 'db', 'data'));
  });

  it('passes absolute data dirs through unchanged', () => {
    const abs = join(root, 'elsewhere');
    expect(resolveDataDir(abs, root)).toBe(abs);
  });
});
