import { expect, test } from '@playwright/test';
import { completeSetup, E2E_RISK_PIN } from './helpers';

test.describe('redesigned demo desk', () => {
  test('setup → the line renders the header, funnel, arena and feed', async ({ page }) => {
    await completeSetup(page);

    await expect(page.getByRole('heading', { name: 'Copydesk' })).toBeVisible();
    await expect(page.getByTestId('badge-demo')).toBeVisible();
    await expect(page.getByTestId('demo-banner')).toContainText('Fictional demo · not a performance claim');

    await expect(page.getByTestId('desk-line')).toBeVisible();
    for (const id of ['discovered', 'screening', 'shadow', 'review', 'bench']) {
      await expect(page.getByTestId(`funnel-stage-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('arena-panel')).toBeVisible();
    await expect(page.getByTestId('arena-health')).toContainText('healthy');
    await expect(page.getByTestId('seat-1')).toBeVisible();
    await expect(page.getByTestId('seat-5')).toBeVisible();
    await expect(page.getByTestId('live-feed')).toBeVisible();
    await expect(page.getByTestId('equity-panel')).toBeVisible();

    // A seat opens its drawer; the drawer is the only place a fire starts.
    await page.getByTestId('seat-1').click();
    await expect(page.getByTestId('seat-drawer')).toBeVisible();
    await expect(page.getByTestId('seat-drawer')).toContainText('Seat performance');
    await expect(page.getByTestId('seat-fire')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('seat-drawer')).toHaveCount(0);

    await page.getByTestId('fire-seat').click();
    await expect(page.getByTestId('fire-modal')).toBeVisible();
    await expect(page.getByTestId('fire-modal')).toContainText('Fire a seat');
    await page.getByTestId('fire-modal').getByRole('button', { name: 'Close' }).click();
  });

  test('tabs and footer routes reach seats, credits, one risk editor, ops, audit and keys', async ({
    page,
  }) => {
    await completeSetup(page);

    await page.getByRole('tab', { name: 'Seats' }).click();
    await expect(page.getByTestId('desk-seats')).toBeVisible();
    await expect(page.getByTestId('sol-headline')).toBeVisible();
    await expect(page.getByTestId('positions-panel')).toBeVisible();
    await expect(page.getByTestId('seat-card-1')).toBeVisible();

    await page.getByRole('tab', { name: 'Credits' }).click();
    await expect(page.getByTestId('desk-credits')).toBeVisible();
    await expect(page.getByTestId('helius-meter')).toBeVisible();

    await page.getByRole('tab', { name: 'Risk' }).click();
    await expect(page.getByTestId('desk-risk')).toBeVisible();
    // ONE risk editor: the legacy Settings risk tab is not reachable.
    await expect(page.getByRole('heading', { name: 'Risk settings' })).toHaveCount(1);

    await page.getByRole('link', { name: 'Ops console' }).click();
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await page.getByRole('button', { name: '← dashboard' }).click();
    await expect(page.getByTestId('desk-line')).toBeVisible();

    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
    await page.getByRole('button', { name: '← dashboard' }).click();

    // Provider keys and the manual import are still reachable; the legacy risk
    // editor stays hidden, but the Live tab is the arm/disarm/lock control.
    await page.getByRole('link', { name: 'Provider keys & imports' }).click();
    await expect(page.getByTestId('provider-fomoapi')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Risk', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Live', exact: true })).toBeVisible();
  });

  test('control endpoints reject requests without a CSRF header; state needs a session', async ({
    page,
    request,
  }) => {
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

    const unauth = await request.get('/api/state');
    expect(unauth.status()).toBe(401);
  });
});

test.describe('risk editor', () => {
  test('saves watch/promotion fields and rejects an inverted pair', async ({ page }) => {
    await completeSetup(page);
    await page.getByRole('tab', { name: 'Risk' }).click();
    await expect(page.getByTestId('risk-help-MIN_PER_BUY_USD')).toContainText(
      'Hard floor: every copied buy is at least this',
    );
    await expect(page.getByTestId('risk-help-MIN_PER_BUY_USD')).toContainText('never skipped');
    await expect(page.getByTestId('risk-help-PER_MINT_CAP_USD')).toContainText('0 disables the cap');

    await page.getByTestId('risk-WATCH_LIST_SIZE').fill('24');
    await page.getByTestId('risk-BENCH_TARGET').fill('12');
    await page.getByTestId('risk-PER_MINT_CAP_USD').fill('0');
    await page.getByTestId('risk-ROSTER_SIZE').fill('3');
    await page.getByTestId('risk-SHADOW_BACKFILL_ON_ADMIT-off').click();
    await page.getByTestId('save-risk').click();
    await expect(page.getByTestId('risk-confirm')).toBeVisible();
    await page.getByTestId('risk-confirm-save').click();
    await expect(page.getByTestId('save-risk-status')).toContainText('Saved');

    await page.reload();
    await page.getByRole('tab', { name: 'Risk' }).click();
    await expect(page.getByTestId('risk-WATCH_LIST_SIZE')).toHaveValue('24');
    await expect(page.getByTestId('risk-BENCH_TARGET')).toHaveValue('12');
    await expect(page.getByTestId('risk-PER_MINT_CAP_USD')).toHaveValue('0');
    await expect(page.getByTestId('risk-ROSTER_SIZE')).toHaveValue('3');
    await expect(page.getByTestId('risk-SHADOW_BACKFILL_ON_ADMIT-off')).toHaveClass(/on/);

    // The merged config refuses an inverted pair at save time.
    await page.getByTestId('risk-BENCH_TARGET').fill('40');
    await page.getByTestId('save-risk').click();
    await page.getByTestId('risk-confirm-save').click();
    await expect(page.getByTestId('risk-confirm-error')).toContainText('invalid settings patch');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Restore the shipped defaults so later specs see the five-chair roster.
    await page.getByTestId('risk-WATCH_LIST_SIZE').fill('20');
    await page.getByTestId('risk-BENCH_TARGET').fill('10');
    await page.getByTestId('risk-PER_MINT_CAP_USD').fill('0');
    await page.getByTestId('risk-ROSTER_SIZE').fill('5');
    await page.getByTestId('risk-SHADOW_BACKFILL_ON_ADMIT-on').click();
    await page.getByTestId('save-risk').click();
    await page.getByTestId('risk-confirm-save').click();
    await expect(page.getByTestId('save-risk-status')).toContainText('Saved');
  });

  test('a risk increase needs the PIN, and a wrong PIN is refused', async ({ page }) => {
    await completeSetup(page);
    await page.getByRole('tab', { name: 'Risk' }).click();

    // Raising the per-trade cap is risk-increasing.
    await page.getByTestId('risk-MAX_PER_BUY_PCT').fill('20');
    await page.getByTestId('save-risk').click();
    await expect(page.getByTestId('risk-confirm')).toBeVisible();
    const pin = page.getByLabel('Risk PIN');
    await expect(pin).toBeVisible();
    await expect(page.getByTestId('risk-confirm-save')).toBeDisabled();

    await pin.fill('0000');
    await page.getByTestId('risk-confirm-save').click();
    await expect(page.getByTestId('risk-confirm-error')).toContainText('raising risk needs the PIN');

    await pin.fill(E2E_RISK_PIN);
    await page.getByTestId('risk-confirm-save').click();
    await expect(page.getByTestId('save-risk-status')).toContainText('Saved');

    await page.reload();
    await page.getByRole('tab', { name: 'Risk' }).click();
    await expect(page.getByTestId('risk-MAX_PER_BUY_PCT')).toHaveValue('20');

    // Restore the default cap (a decrease, so no PIN).
    await page.getByTestId('risk-MAX_PER_BUY_PCT').fill('10');
    await page.getByTestId('save-risk').click();
    await page.getByTestId('risk-confirm-save').click();
    await expect(page.getByTestId('save-risk-status')).toContainText('Saved');
  });
});
