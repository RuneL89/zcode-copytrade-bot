import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { loadConfig, findRepoRoot, resolveDataDir, type AppConfig } from '@zcode-bot/config';

/**
 * Application bootstrap shared by the server entry point and every CLI.
 *
 * - Locates the workspace root independently of the current working directory
 *   (pnpm runs package scripts with cwd set to the package folder).
 * - Loads `<repo>/.env` explicitly instead of relying on cwd.
 * - Anchors a relative DATA_DIR at the repo root so `./data` always means
 *   `<repo>/data`.
 */
export const REPO_ROOT = findRepoRoot(import.meta.url);

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotenv({ path: join(REPO_ROOT, '.env'), quiet: true });
  const config = loadConfig(env);
  config.env.DATA_DIR = resolveDataDir(config.env.DATA_DIR, REPO_ROOT);
  return config;
}

export function migrationsFolder(): string {
  return join(REPO_ROOT, 'packages', 'db', 'drizzle');
}

export function webDist(): string {
  return join(REPO_ROOT, 'apps', 'web', 'dist');
}

export function demoFixtures(): string {
  return join(REPO_ROOT, 'fixtures', 'demo-timeline.json');
}
