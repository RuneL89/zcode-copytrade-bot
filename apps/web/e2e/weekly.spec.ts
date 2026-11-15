import { expect, test } from '@playwright/test';
import { completeSetup } from './helpers';

/**
 * The weekly review is a read-only report view. The endpoint is generated from
 * the DB on demand; the page only renders the returned markdown.
 */
test('weekly review page renders the read-only report', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/#/weekly');
  await expect(page.getByRole('heading', { name: 'Weekly review' })).toBeVisible();
  await expect(page.locator('pre')).toContainText('# Copydesk weekly review');
  await expect(page.getByText('Read-only: the generator reads the DB and writes nothing.')).toBeVisible();
  await expect(page.getByText('No closed paper positions', { exact: false })).toBeVisible();
});

test('the audit page links to the weekly review', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/#/audit');
  await page.getByRole('button', { name: 'weekly review' }).click();
  await expect(page.getByRole('heading', { name: 'Weekly review' })).toBeVisible();
});
