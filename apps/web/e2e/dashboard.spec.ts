import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test.describe('demo dashboard (fictional)', () => {
  test('setup wizard → dashboard renders with demo labeling', async ({ page }) => {
    await completeSetup(page);

    // Header
    await expect(page.getByRole('heading', { name: 'ZCode Bot' })).toBeVisible();
    await expect(page.getByText('Copy trading · FOMO')).toBeVisible();
    await expect(page.getByTestId('badge-demo')).toBeVisible();

    // Fictional banner persists throughout
    await expect(page.getByTestId('demo-banner')).toContainText('Fictional demo · not a performance claim');

    // Equity hero with source labeling
    await expect(page.getByTestId('equity-source')).toContainText('Fictional demo fixtures');

    // Active trader card with copy scale + fire rule + pipeline
    await expect(page.getByTestId('active-trader')).toBeVisible();
    await expect(page.getByTestId('active-trader').getByText('COPY 0.25x')).toBeVisible();
    await expect(page.getByTestId('active-trader').getByText(/FIRE AT 2 L/)).toBeVisible();
    await expect(page.getByTestId('hiring-pipeline')).toBeVisible();

    // Charts + candidates panel
    await expect(page.getByText('Every copied close · ledger all-time')).toBeVisible();
    await expect(page.getByTestId('candidates-panel')).toBeVisible();
    await expect(page.getByText('Who we copy')).toBeVisible();
  });

  test('28s replay: two fired handoffs, final stats exact', async ({ page }) => {
    await completeSetup(page);
    // Restart the replay deterministically from the banner button.
    await page.getByRole('button', { name: /Replay 28s/i }).click();

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
    await expect(
      page.getByRole('region', { name: 'trade history' }).getByText('48', { exact: true }),
    ).toBeVisible();
  });

  test('settings, ops and audit routes render on separate views', async ({ page }) => {
    await completeSetup(page);
    await page.getByRole('button', { name: 'Ops', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await expect(page.getByTestId('ops-status')).toBeVisible();
    await expect(page.getByText('Output', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Commands' }).click();
    await expect(page.getByTestId('op-backup-data')).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('tab', { name: 'Imports' }).click();
    await expect(page.getByText('Manual FOMO leaderboard import')).toBeVisible();
    await page.getByRole('tab', { name: 'Live' }).click();
    await expect(page.getByText('Live readiness & arming')).toBeVisible();

    await page.getByRole('button', { name: 'Audit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
    await expect(page.getByText('Event log')).toBeVisible();

    await page.getByRole('button', { name: 'Trade', exact: true }).click();
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
