import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E_BASE_URL, E2E_DATA_DIR } from './paths';

/** First-run setup when needed, then land on the dashboard. */
export async function completeSetup(page: Page) {
  await page.goto('/');
  const setupVisible = await page
    .getByText('Create the dashboard user')
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (setupVisible) {
    const token = await readSetupToken(page);
    await page.getByPlaceholder('one-time token from console').fill(token);
    await page.locator('input[value="admin"]').fill('admin');
    await page.locator('input[type="password"]').first().fill('e2e-password-123');
    await page.getByRole('button', { name: 'Create user & sign in' }).click();
  } else {
    await page.locator('input:not([type="password"])').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('e2e-password-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByText('FICTIONAL DEMO', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Token source: the test-only `testSetupToken` field of /api/bootstrap
 * (NODE_ENV=test only — see Runtime.currentSetupTokenForTests). Files written
 * by the spawned server process are not reliably visible to the test worker
 * under this runner, so the file is only a fallback for local manual runs.
 */
export async function readSetupToken(page: Page): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const boot = await page.request.get(`${E2E_BASE_URL}/api/bootstrap`);
    if (boot.ok()) {
      const body = (await boot.json()) as { needsSetup: boolean; testSetupToken?: string | null };
      if (body.needsSetup && body.testSetupToken) return body.testSetupToken;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  // Fallback for manual runs outside this runner: setup-token.txt.
  const file = resolve(E2E_DATA_DIR, 'setup-token.txt');
  try {
    const text = readFileSync(file, 'utf8');
    const m = text.match(/setup token \(valid 30 minutes\): (\S+)/);
    if (m) return m[1]!;
  } catch {
    /* fallthrough */
  }
  const listing = existsSync(E2E_DATA_DIR) ? readdirSync(E2E_DATA_DIR).join(', ') : '<dir missing>';
  throw new Error(`no setup token via bootstrap API or ${file} (data dir: [${listing}])`);
}

export async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).waitFor({ timeout: 10_000 });
  const inputs = page.locator('input:not([type="password"])');
  await inputs.first().fill('admin');
  await page.locator('input[type="password"]').first().fill('e2e-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('FICTIONAL DEMO', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
}
