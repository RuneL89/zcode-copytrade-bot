import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test('desk shows the SOL headline, seats, credits, and a risk confirm step', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await completeSetup(page);
  await page.getByRole('button', { name: 'Desk', exact: true }).click();
  await expect(page.getByTestId('sol-headline')).toBeVisible();
  await expect(page.getByTestId('desk-line')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('tab', { name: 'Seats' }).click();
  await expect(page.getByTestId('desk-seats')).toBeVisible();
  await page.getByRole('tab', { name: 'Credits' }).click();
  await expect(page.getByTestId('desk-credits')).toBeVisible();
  await page.getByRole('tab', { name: 'Risk' }).click();
  await page.getByRole('button', { name: 'Review change' }).click();
  await expect(page.getByTestId('risk-confirm')).toBeVisible();
  await expect(page.getByLabel('Risk PIN')).toBeVisible();
});
