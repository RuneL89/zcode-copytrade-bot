import { defineConfig, devices } from '@playwright/test';
import { E2E_DATA_DIR, E2E_BASE_URL, E2E_PORT } from './e2e/paths';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: E2E_BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'pnpm --filter @zcode-bot/server exec tsx src/index.ts',
    cwd: '../..',
    url: `${E2E_BASE_URL}/api/bootstrap`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // webServer.env REPLACES the environment — merge the host env explicitly.
      ...process.env,
      MODE: 'demo',
      PORT: String(E2E_PORT),
      HOST: '127.0.0.1',
      DATA_DIR: E2E_DATA_DIR,
      SESSION_SECRET: 'e2e-test-secret-0123456789abcdef0123456789',
      NODE_ENV: 'test',
      // Each test signs in from a fresh context; the 5-per-10-min default
      // would rate-limit the suite itself.
      LOGIN_RATE_LIMIT_MAX: '200',
    },
  },
});
