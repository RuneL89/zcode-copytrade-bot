import { rmSync, mkdirSync } from 'node:fs';
import { E2E_DATA_DIR } from './paths';

/**
 * Runs ONCE in a dedicated process before the webServer starts.
 * Never put cleanup in playwright.config.ts top-level: worker processes
 * re-load that module and would delete live server data mid-run.
 */
export default function globalSetup() {
  try {
    rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Best effort: a crashed previous run may still hold handles.
  }
  mkdirSync(E2E_DATA_DIR, { recursive: true });
}
