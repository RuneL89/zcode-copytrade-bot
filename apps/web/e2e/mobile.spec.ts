import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test('mobile 375px: bottom nav, funnel and seats fit without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await completeSetup(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await expect(page.getByRole('tab', { name: 'Line', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Seats', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Credits', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Risk', exact: true })).toBeVisible();

  await expect(page.getByTestId('funnel-panel')).toBeVisible();
  await expect(page.getByTestId('arena-panel')).toBeVisible();
  await expect(page.getByTestId('seat-1')).toBeVisible();

  // The mobile funnel switches to its vertical layout and still exposes all
  // five stages.
  for (const id of ['discovered', 'screening', 'shadow', 'review', 'bench']) {
    await expect(page.getByTestId(`funnel-stage-${id}`)).toBeVisible();
  }

  await page.getByRole('tab', { name: 'Seats', exact: true }).click();
  await expect(page.getByTestId('desk-seats')).toBeVisible();
  await expect(page.getByTestId('seat-card-1')).toBeVisible();
  await expect(page.getByTestId('positions-panel')).toBeVisible();

  const seatsOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(seatsOverflow).toBeLessThanOrEqual(1);
});
