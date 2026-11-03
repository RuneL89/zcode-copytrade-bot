import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test.describe('demo dashboard (fictional)', () => {
  test('setup wizard → dashboard renders with demo labeling', async ({ page }) => {
    await completeSetup(page);

    // Header
    await expect(page.getByRole('heading', { name: 'Copydesk' })).toBeVisible();
    await expect(page.getByText('Copy trading · FOMO')).toBeVisible();
    await expect(page.getByTestId('badge-demo')).toBeVisible();

    // Fictional banner persists throughout
    await expect(page.getByTestId('demo-banner')).toContainText('Fictional demo · not a performance claim');

    // Equity hero with source labeling
    await expect(page.getByTestId('equity-source')).toContainText('Fictional demo fixtures');

    // D4 watch list panel: the replay keeps no watch record, so the panel shows
    // its empty state with the real targets and the discovery reason.
    await expect(page.getByTestId('watchlist-panel')).toBeVisible();
    await expect(page.getByTestId('watchlist-empty')).toContainText('No wallets on the watch list');
    await expect(page.getByTestId('watchlist-counts')).toContainText('watching');
    await expect(page.getByTestId('watchlist-footer')).toContainText('Next discovery:');

    // The roster panel (plan 05) replaces the single-trader card: the replay
    // runs one fictional chair, and firing it asks for the word FIRE.
    await expect(page.getByTestId('roster-panel')).toBeVisible();
    await expect(page.getByTestId('roster-counts')).toContainText('shared pool');
    const seat = page.locator('[data-testid^="roster-seat-"]').first();
    await expect(seat).toBeVisible();
    await expect(seat.getByText('ACTIVE', { exact: false }).first()).toBeVisible();
    for (const field of ['REALIZED', 'UNREALIZED', 'OPEN']) {
      await expect(seat.getByText(field, { exact: true }).first()).toBeVisible();
    }
    const fireButton = page.locator('[data-testid^="roster-fire-"]').first();
    await fireButton.click();
    // The confirmation dialog names the chair and requires the word.
    await expect(page.getByRole('dialog')).toContainText('FIRE');
    await page.keyboard.press('Escape');

    // Charts + candidates panel
    await expect(page.getByText('Every copied close · ledger all-time')).toBeVisible();
    await expect(page.getByTestId('candidates-panel')).toBeVisible();
    await expect(page.getByText('Who we copy')).toBeVisible();
  });

  test('settings, ops and audit routes render on separate views', async ({ page }) => {
    await completeSetup(page);
    await page.getByRole('button', { name: 'Ops', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await expect(page.getByTestId('ops-status')).toBeVisible();
    await expect(page.getByText('Output', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Commands' }).click();
    await expect(page.getByTestId('op-backup-data')).toBeVisible();
    // D3 inlet: the discovery sync action is present (never clicked here — the
    // suite must not spend real fomoapi credits).
    await expect(page.getByTestId('op-discovery-sync-now')).toBeVisible();
    await expect(page.getByTestId('op-discovery-sync-now')).toContainText('Sync discovery now');
    // The D4 watch list is reachable from Operations as well as the dashboard.
    await expect(page.getByTestId('watchlist-panel')).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // MIN_PER_BUY_USD is a hard floor (D1): the field help must say so and
    // must not imply the buy would be skipped.
    await page.getByRole('tab', { name: 'Risk' }).click();
    const floorHelp = page.getByTestId('risk-help-MIN_PER_BUY_USD');
    await expect(floorHelp).toContainText('Hard floor: every copied buy is at least this');
    await expect(floorHelp).toContainText('never skipped');
    await expect(floorHelp).not.toContainText('minimum to copy');
    await page.getByRole('tab', { name: 'Imports' }).click();
    await expect(page.getByText('Manual FOMO leaderboard import')).toBeVisible();
    await expect(page.getByText('fallback only').first()).toBeVisible();
    // D3: the fomoapi inlet shows configured/not configured, never the key.
    await page.getByRole('tab', { name: 'Keys' }).click();
    await expect(page.getByTestId('provider-fomoapi')).toContainText(/configured|not configured/);
    await page.getByRole('tab', { name: 'Live' }).click();
    await expect(page.getByText('Live readiness & arming')).toBeVisible();

    await page.getByRole('button', { name: 'Audit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
    await expect(page.getByText('Event log')).toBeVisible();

    await page.getByRole('button', { name: 'Trade', exact: true }).click();
    await expect(page.getByTestId('roster-panel')).toBeVisible();
  });
});

/**
 * D4 watch list with real rows: the state comes from the server (seeded through
 * the NODE_ENV=test-only route, whose write path is a chain scan the demo server
 * never runs). Pins the panel's fields, the blocked reason and the Promote-now
 * enablement. Promotion itself is refused in demo mode (it would hire into the
 * live tables) and is covered by the paper-mode API tests.
 */
test.describe('D4 watch list panel', () => {
  test('renders rows with the shadow record and the gate reason', async ({ page }) => {
    await completeSetup(page);
    const ready = await page.request.post('/api/test/seed-watch', {
      data: { handle: 'e2e_ready', closedTrades: 8, netPerTradeUsd: 2, lastBuyMinutesAgo: 5 },
    });
    expect(ready.ok()).toBe(true);
    const readyId = ((await ready.json()) as { candidateId: string }).candidateId;
    const blocked = await page.request.post('/api/test/seed-watch', {
      data: {
        handle: 'e2e_blocked',
        // No closed record at all: unambiguously below the runtime's K = 8, so
        // the row must report FEWER_THAN_K_CLOSED whatever else is on the bench.
        closedTrades: 0,
        netPerTradeUsd: 0,
        openNotionalUsd: 7,
        openAgeHours: 2,
      },
    });
    expect(blocked.ok()).toBe(true);
    const blockedId = ((await blocked.json()) as { candidateId: string }).candidateId;

    await page.reload();
    await expect(page.getByTestId('watchlist-panel')).toBeVisible();
    await expect(page.getByTestId('watchlist-empty')).toHaveCount(0);
    await expect(page.getByTestId('watchlist-counts')).toContainText('watching');

    // The promotable row: every field the AC lists is rendered.
    const readyRow = page.getByTestId(`watch-row-${readyId}`);
    await expect(readyRow).toContainText('@e2e_ready');
    await expect(readyRow).toContainText('WATCHING');
    await expect(readyRow).toContainText('SHADOW LEDGER');
    await expect(readyRow).toContainText('LAST BUY');
    await expect(readyRow).toContainText('BUYS/SELLS 24H');
    await expect(readyRow).toContainText('CLOSED');
    await expect(readyRow).toContainText('NET');
    await expect(readyRow).toContainText('OPEN');
    await expect(readyRow).toContainText('AT CEILING');
    await expect(page.getByTestId(`watch-lastbuy-${readyId}`)).not.toHaveText('—');
    await expect(page.getByTestId(`watch-promote-${readyId}`)).toBeEnabled();
    await expect(page.getByTestId(`watch-blocked-${readyId}`)).toHaveCount(0);

    // The blocked row: its reason is shown and Promote now is disabled.
    const blockedRow = page.getByTestId(`watch-row-${blockedId}`);
    await expect(blockedRow).toContainText('@e2e_blocked');
    await expect(page.getByTestId(`watch-blocked-${blockedId}`)).toContainText('FEWER_THAN_K_CLOSED');
    await expect(page.getByTestId(`watch-promote-${blockedId}`)).toBeDisabled();

    // Archive works from the panel (confirm word), then Unarchive comes back.
    await page.getByTestId(`watch-archive-${blockedId}`).click();
    await page.getByRole('dialog').getByRole('textbox').fill('ARCHIVE');
    await page.getByRole('dialog').getByRole('button', { name: 'ARCHIVE' }).click();
    // Demo mode refuses the write (it would touch live tables), so the row keeps
    // its status — the refusal is what the demo dashboard must show.
    await expect(page.getByRole('alert')).toContainText('demo mode');
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

/**
 * D4 settings (plan 02): the watch/promotion thresholds save from the Risk
 * tab and come back after a reload; PER_MINT_CAP_USD = 0 is a meaningful value
 * (cap disabled), not an empty field.
 */
test.describe('D4 settings save from the Risk tab', () => {
  test('saves the watch/promotion fields and shows them after a reload', async ({ page }) => {
    await completeSetup(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Risk' }).click();
    await expect(page.getByTestId('risk-help-PER_MINT_CAP_USD')).toContainText('0 disables the per-mint cap');

    await page.getByTestId('risk-WATCH_LIST_SIZE').fill('24');
    await page.getByTestId('risk-BENCH_TARGET').fill('12');
    await page.getByTestId('risk-PER_MINT_CAP_USD').fill('0');
    await page.getByTestId('risk-ROSTER_SIZE').fill('3');
    await page.getByTestId('risk-SHADOW_BACKFILL_ON_ADMIT').uncheck();
    await page.getByTestId('save-risk').click();
    await expect(page.getByTestId('save-risk-status')).toContainText('SAVED & APPLIED');

    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Risk' }).click();
    await expect(page.getByTestId('risk-WATCH_LIST_SIZE')).toHaveValue('24');
    await expect(page.getByTestId('risk-BENCH_TARGET')).toHaveValue('12');
    await expect(page.getByTestId('risk-PER_MINT_CAP_USD')).toHaveValue('0');
    await expect(page.getByTestId('risk-ROSTER_SIZE')).toHaveValue('3');
    await expect(page.getByTestId('risk-SHADOW_BACKFILL_ON_ADMIT')).not.toBeChecked();

    // An inverted pair is refused at save time, not silently stored.
    await page.getByTestId('risk-BENCH_TARGET').fill('40');
    await page.getByTestId('save-risk').click();
    await expect(page.getByTestId('save-risk-status')).toContainText('NOT SAVED');
  });
});
