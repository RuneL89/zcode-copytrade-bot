import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test('mobile 375px layout: no clipped cards, readable labels', async ({ page }) => {
  await completeSetup(page);

  // No horizontal overflow at mobile width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // Every top-level card fits within the viewport width.
  const tooWide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll('section.card')]
      .filter((el) => el.getBoundingClientRect().width > vw)
      .map((el) => el.getAttribute('aria-label') ?? el.className);
  });
  expect(tooWide).toEqual([]);

  await expect(page.getByTestId('active-trader')).toBeVisible();
  await expect(page.getByTestId('candidates-panel')).toBeVisible();
});

test('handoff overlay fits the mobile viewport', async ({ page }) => {
  await completeSetup(page);
  await page.getByRole('button', { name: /Replay 28s/i }).click();
  const overlay = page.getByTestId('handoff-overlay');
  await expect(overlay).toBeVisible({ timeout: 12_000 });
  const fits = await overlay.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= document.documentElement.clientWidth;
  });
  expect(fits).toBe(true);
  await expect(page.getByTestId('fired-stamp')).toBeVisible();
});
