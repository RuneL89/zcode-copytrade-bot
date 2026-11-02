import { test } from '@playwright/test';
import { completeSetup } from './helpers';

/**
 * Captures the four plan-07 review screenshots (390×844 and 1280×800, dark and
 * light) into `test-results/pipeline-screens/` so the verifier — and anyone
 * reviewing the design — inspects the same artifacts the suite renders. The
 * theme is forced through localStorage before first paint (the same key the
 * pre-paint script in index.html reads).
 */
test('capture the four review screenshots (390/1280 × dark/light)', async ({ browser }) => {
  const shots: Array<[number, number, 'dark' | 'light']> = [
    [390, 844, 'dark'],
    [390, 844, 'light'],
    [1280, 800, 'dark'],
    [1280, 800, 'light'],
  ];
  for (const [width, height, theme] of shots) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.addInitScript((t) => localStorage.setItem('zcode-theme', t), theme);
    await completeSetup(page);
    await page.screenshot({
      path: `test-results/pipeline-screens/${width}x${height}-${theme}.png`,
      fullPage: true,
    });
    await context.close();
  }
});
