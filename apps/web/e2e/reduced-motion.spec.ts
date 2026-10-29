import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

test('prefers-reduced-motion: handoff shows all content without animation delays', async ({ page }) => {
  // Belt and braces: contextOptions already requests reduce; this re-asserts
  // it before any animation starts.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await completeSetup(page);
  await page.getByRole('button', { name: /REPLAY 28s/ }).click();

  const overlay = page.getByTestId('handoff-overlay');
  await expect(overlay).toBeVisible({ timeout: 12_000 });

  // With animations disabled, delayed elements are visible immediately
  // (the CSS media query zeroes the delays and disables transforms).
  await expect(page.getByTestId('fired-stamp')).toBeVisible();
  await expect(page.getByTestId('now-copying').or(page.getByTestId('waiting-zcode'))).toBeVisible({
    timeout: 5_000,
  });

  // And no element keeps an animation applied.
  const animated = await overlay.evaluate((el) => {
    return [...el.querySelectorAll('*')].filter((child) => {
      const cs = getComputedStyle(child);
      return cs.animationName !== 'none' && cs.animationPlayState !== 'paused';
    }).length;
  });
  expect(animated).toBe(0);
});
