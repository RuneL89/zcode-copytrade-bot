import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test('mobile desk: no horizontal overflow, four tabs, one PIN-gated risk editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await completeSetup(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const tooWide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll('.cdx .panel')]
      .filter((el) => el.getBoundingClientRect().width > vw + 1)
      .map((el) => el.className);
  });
  expect(tooWide).toEqual([]);

  await expect(page.getByRole('tab', { name: 'Line', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Seats', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Credits', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Risk', exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Seats', exact: true }).click();
  await expect(page.getByTestId('desk-seats')).toBeVisible();
  await expect(page.getByTestId('sol-headline')).toBeVisible();
  await expect(page.getByTestId('positions-panel')).toBeVisible();

  await page.getByRole('tab', { name: 'Credits', exact: true }).click();
  await expect(page.getByTestId('desk-credits')).toBeVisible();

  await page.getByRole('tab', { name: 'Risk', exact: true }).click();
  await expect(page.getByTestId('desk-risk')).toBeVisible();
  // The PIN prompt lives in the one risk editor and appears only for an increase.
  await page.getByTestId('risk-MAX_OPEN_PER_TRADER_USD').fill('50');
  await page.getByTestId('save-risk').click();
  await expect(page.getByTestId('risk-confirm')).toBeVisible();
  await expect(page.getByLabel('Risk PIN')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
});
