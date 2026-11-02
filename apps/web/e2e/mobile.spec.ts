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

  await expect(page.getByTestId('roster-panel')).toBeVisible();
  await expect(page.getByTestId('watchlist-panel')).toBeVisible();
  await expect(page.getByTestId('candidates-panel')).toBeVisible();
});
