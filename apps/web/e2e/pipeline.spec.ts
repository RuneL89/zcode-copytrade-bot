import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

/**
 * The redesigned Line screen: the same funnel/arena surfaces as the approved
 * mockup, fed by the demo state. The mockup's full motion timeline is not
 * replayed here; these tests pin the structure the server state renders.
 */
test.describe('line screen', () => {
  test('shows five funnel stages, five arena seats and a live feed', async ({ page }) => {
    await completeSetup(page);
    await expect(page.getByTestId('desk-line')).toBeVisible();

    const stages = page.locator('[data-testid^="funnel-stage-"]');
    await expect(stages).toHaveCount(5);
    for (const id of ['discovered', 'screening', 'shadow', 'review', 'bench']) {
      await expect(page.getByTestId(`funnel-stage-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('funnel-panel')).toContainText('hired');

    for (let seat = 1; seat <= 5; seat++) {
      await expect(page.getByTestId(`seat-${seat}`)).toBeVisible();
    }
    await expect(page.getByTestId('arena-health')).toContainText(/healthy|watch|at risk/);
    await expect(page.getByTestId('live-feed')).toBeVisible();
    await expect(page.getByTestId('equity-panel')).toBeVisible();
  });

  test('a seat opens a drawer with performance and a fire path', async ({ page }) => {
    await completeSetup(page);
    await page.getByTestId('seat-1').click();
    const drawer = page.getByTestId('seat-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Seat performance');
    await expect(drawer).toContainText('Loss streak');
    await expect(drawer).toContainText('Idle clock');
    await page.getByTestId('seat-fire').click();
    await expect(drawer).toContainText('Fire this seat?');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('pause and resume from the funnel toolbar', async ({ page }) => {
    await completeSetup(page);
    const pause = page.getByTestId('pause-entries');
    // The control flag persists in the data dir; normalise to running first.
    if ((await pause.textContent())?.includes('Resume')) {
      await pause.click();
      await expect(pause).toContainText('Pause entries');
    }
    await pause.click();
    await expect(page.getByTestId('pause-entries')).toContainText('Resume entries');
    await page.getByTestId('pause-entries').click();
    await expect(page.getByTestId('pause-entries')).toContainText('Pause entries');
  });

  test('the demo banner labels the replay and offers a replay control', async ({ page }) => {
    await completeSetup(page);
    const banner = page.getByTestId('demo-banner');
    await expect(banner).toContainText('Fictional demo');
    await expect(banner.getByRole('button', { name: /Replay/ })).toBeVisible();
  });
});
