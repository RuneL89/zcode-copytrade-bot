import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test.describe('demo dashboard (fictional)', () => {
  test('setup wizard → dashboard renders with demo labeling', async ({ page }) => {
    await completeSetup(page);

    // Header
    await expect(page.getByRole('heading', { name: 'ZCode Bot' })).toBeVisible();
    await expect(page.getByText('COPY TRADING · FOMO')).toBeVisible();
    await expect(page.getByTestId('badge-demo')).toBeVisible();

    // Fictional banner persists throughout
    await expect(page.getByTestId('demo-banner')).toContainText('FICTIONAL DEMO · NOT A PERFORMANCE CLAIM');

    // Equity hero with source labeling
    await expect(page.getByTestId('equity-source')).toContainText('FICTIONAL DEMO FIXTURES');

    // Active trader card with copy scale + fire rule
    await expect(page.getByTestId('active-trader')).toBeVisible();
    await expect(page.getByTestId('active-trader').getByText('COPY 0.25x')).toBeVisible();
    await expect(page.getByTestId('active-trader').getByText(/FIRE AT 2 L/)).toBeVisible();

    // Charts + candidates panel
    await expect(page.getByText('EVERY COPIED CLOSE')).toBeVisible();
    await expect(page.getByTestId('candidates-panel')).toBeVisible();
    await expect(page.getByText('WHO WE COPY')).toBeVisible();
  });

  test('28s replay: two fired handoffs, final stats exact', async ({ page }) => {
    await completeSetup(page);
    // Restart the replay deterministically from the banner button.
    await page.getByRole('button', { name: /REPLAY 28s/ }).click();

    // Equity starts at the fictional $52.00.
    await expect(page.locator('p.money').first()).toContainText('52', { timeout: 10_000 });

    // First handoff: ape_vasco fired at ~6.2s, moonpie_max revealed.
    await expect(page.getByTestId('handoff-overlay')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTestId('fired-stamp')).toContainText('FIRED');
    await expect(page.getByTestId('handoff-card').getByText('UNFOLLOWED')).toBeVisible();
    await expect(page.getByTestId('handoff-card').getByText('@ape_vasco')).toBeVisible();
    await expect(page.getByTestId('now-copying')).toContainText('@moonpie_max');

    // Second handoff around 16.2s: moonpie fired, lunadegen revealed.
    await expect(page.getByTestId('now-copying').last()).toContainText('@lunadegen', { timeout: 15_000 });

    // Final state: $4,939.00 equity, 48 copied trades, 36 winners.
    await expect(page.getByTestId('active-trader')).toContainText('@lunadegen', { timeout: 20_000 });
    await expect(page.getByTestId('equity-source')).toBeVisible();
    await expect
      .poll(async () => page.locator('p.money').first().innerText(), { timeout: 25_000 })
      .toContain('4,939');
    await expect(page.getByRole('region', { name: 'equity' }).getByText('48', { exact: true })).toBeVisible();
  });

  test('settings, ops and audit routes render on separate views', async ({ page }) => {
    await completeSetup(page);
    await page.getByRole('button', { name: 'OPS', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await expect(page.getByTestId('ops-status')).toBeVisible();
    await expect(page.getByText('OUTPUT', { exact: true })).toBeVisible();
    await expect(page.getByTestId('op-backup-data')).toBeVisible();

    await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('MANUAL FOMO LEADERBOARD IMPORT')).toBeVisible();
    await expect(page.getByText('LIVE READINESS')).toBeVisible();

    await page.getByRole('button', { name: 'AUDIT', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
    await expect(page.getByText('EVENT LOG')).toBeVisible();

    await page.getByRole('button', { name: 'TRADE', exact: true }).click();
    await expect(page.getByTestId('active-trader')).toBeVisible();
  });
});

test.describe('security invariants in the browser', () => {
  test('control endpoints reject requests without a CSRF header', async ({ page }) => {
    await completeSetup(page);
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/control/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
      return res.status;
    });
    expect(status).toBe(403);
  });

  test('state endpoint requires a session', async ({ request }) => {
    const res = await request.get('/api/state');
    expect(res.status()).toBe(401);
  });
});
