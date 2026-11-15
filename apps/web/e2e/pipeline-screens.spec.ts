import { test } from '@playwright/test';
import { completeSetup } from './helpers';

/**
 * Captures the redesigned Line / Seats / Credits / Risk screens at mobile and
 * desktop widths into `test-results/pipeline-screens/`. These are review
 * artifacts for the same demo state the suite asserts; the committed set lives
 * in `docs/screenshots/redesign/`.
 */
test('capture the redesigned screens (390 and 1280)', async ({ browser }) => {
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await completeSetup(page);
    for (const [route, name] of [
      ['line', 'line'],
      ['seats', 'seats'],
      ['credits', 'credits'],
      ['risk', 'risk'],
    ] as const) {
      if (route !== 'line') {
        await page
          .getByRole('tab', { name: name === 'seats' ? 'Seats' : name, exact: false })
          .first()
          .click();
        await page.waitForTimeout(300);
      }
      // Keep the 28s demo story alive for every capture.
      const replay = page.getByRole('button', { name: /Replay/ });
      if ((await replay.count()) > 0) {
        await replay
          .first()
          .click()
          .catch(() => undefined);
        await page.waitForTimeout(800);
      }
      await page.screenshot({
        path: `test-results/pipeline-screens/${width}-${name}.png`,
        fullPage: width >= 1000,
      });
    }
    await context.close();
  }
});
