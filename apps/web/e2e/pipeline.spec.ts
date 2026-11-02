import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { completeSetup } from './helpers';

/**
 * Plan 07 — the pipeline dashboard. Everything asserted here is either the
 * server payload (`/api/state`) or a token-driven style: no invented numbers,
 * both themes complete, motion optional, and the layout honest at 390 and 1280.
 */

interface PipelinePayload {
  pipeline: {
    discovery: { newHandles24h: number; lastSyncAt: string | null; sources: string[] };
    pool: { total: number; withWallet: number; fundedBuyers24h: number };
    watch: { watching: number };
    roster: Array<{ activationId: string }>;
    exits: { fired24h: number };
    edges: Array<{ from: string; to: string; count24h: number }>;
  };
  counters: { rosterSize?: number };
}

async function payload(page: Page) {
  return (await page.evaluate(async () => {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    return res.json();
  })) as PipelinePayload;
}

test.describe('pipeline spine (plan 07)', () => {
  test('desktop 1280×800: hero above the fold, five stages and five seats, counts from the payload', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await completeSetup(page);

    // Section order (AC1): equity → pipeline → roster → positions/watch.
    const y = async (selector: string) => {
      const box = await page.locator(selector).first().boundingBox();
      expect(box, selector).not.toBeNull();
      return box!.y;
    };
    const equityY = await y('[aria-label="equity"]');
    const pipelineY = await y('[data-testid="pipeline-panel"]');
    const rosterY = await y('[data-testid="roster-panel"]');
    const railY = await y('[data-testid="watch-rail"]');
    expect(equityY).toBeLessThan(pipelineY);
    expect(pipelineY).toBeLessThan(rosterY);
    expect(rosterY).toBeLessThan(railY);

    // The hero is fully visible without scrolling.
    const hero = (await page.locator('[aria-label="equity"]').first().boundingBox())!;
    expect(hero.y + hero.height).toBeLessThanOrEqual(800);

    // Five stages, with the counts rendered verbatim from the payload (AC2).
    await expect(page.locator('[data-testid^="pipeline-stage-"]')).toHaveCount(5);
    const p = await payload(page);
    const stageValue = async (id: string) =>
      Number(await page.getByTestId(`pipeline-stage-${id}`).locator('[data-stage-value]').innerText());
    expect(await stageValue('discovery')).toBe(p.pipeline.discovery.newHandles24h);
    expect(await stageValue('pool')).toBe(p.pipeline.pool.total);
    expect(await stageValue('watch')).toBe(p.pipeline.watch.watching);
    expect(await stageValue('roster')).toBe(p.pipeline.roster.length);
    expect(await stageValue('exits')).toBe(p.pipeline.exits.fired24h);

    // The fired lane renders (empty state early in the replay is explicit).
    await expect(page.getByTestId('fired-lane')).toBeVisible();

    // Five seats: filled + empty = the payload's chair count (AC4).
    const filled = await page.locator('[data-testid^="roster-seat-"]').count();
    const empty = await page.getByTestId('roster-empty-seat').count();
    expect(filled).toBe(p.pipeline.roster.length);
    expect(filled + empty).toBe(p.counters.rosterSize ?? filled);

    // Edges exist as structure, are aria-hidden, and the nav/list is the a11y surface (AC9).
    await expect(page.locator('[data-edge="discovery-pool"]')).toHaveCount(1);
    // The return lane is drawn (Fired → Watch)…
    await expect(page.locator('[data-edge="exits-watch"] path.flow-edge').first()).toBeAttached();
    // …and an edge carrying volume shows its direction chevron (none when 0).
    const discoveryPool = p.pipeline.edges.find((e) => e.to === 'pool')?.count24h ?? 0;
    if (discoveryPool > 0) {
      await expect(page.locator('[data-edge="discovery-pool"] [data-edge-chevron]')).toHaveCount(1);
    }
    await expect(page.locator('nav[aria-label="Trading pipeline"] ol li button')).toHaveCount(5);
    expect(await page.locator('nav[aria-label="Trading pipeline"] svg').getAttribute('aria-hidden')).toBe(
      'true',
    );
    // Stage buttons carry counts in their accessible names.
    await expect(page.getByTestId('pipeline-stage-pool')).toHaveAttribute(
      'aria-label',
      new RegExp(`${p.pipeline.pool.total} candidates`),
    );
  });

  test('mobile 390×844: stepper, single-column seats, no horizontal overflow, ≥44px controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await completeSetup(page);

    await expect(page.locator('[data-testid^="pipeline-stage-"]')).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // The seat grid is one column at phone width.
    const columns = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="roster-panel"] ul');
      return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    });
    expect(columns).toBe(1);

    // Every plan-07 control is at least 44px tall at phone width.
    for (const selector of [
      '[data-testid="theme-toggle"]',
      '[data-testid="pipeline-stage-pool"]',
      '[data-testid="rail-tab-watch"]',
    ]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.height, selector).toBeGreaterThanOrEqual(44);
    }

    // The hero comes before the spine in document order.
    const equityY = (await page.locator('[aria-label="equity"]').first().boundingBox())!.y;
    const pipelineY = (await page.locator('[data-testid="pipeline-panel"]').first().boundingBox())!.y;
    expect(equityY).toBeLessThan(pipelineY);
  });

  test('a roster seat expands to its open positions, collapsed by default', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await completeSetup(page);
    // The demo replay owns the store while it runs, and a rebuild during it is
    // discarded. Wait for it to stop publishing (generatedAt freezes), then seed.
    await expect
      .poll(
        async () => {
          const read = () =>
            page.evaluate(async () => {
              const state = await fetch('/api/state', { credentials: 'same-origin' }).then((r) => r.json());
              return state.generatedAt as string;
            });
          const first = await read();
          await page.waitForTimeout(1_500);
          return (await read()) === first;
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
    // A seeded chair with one open position: independent of the replay timing.
    const seeded = await page.request.post('/api/test/seed-seat', {
      data: { handle: 'e2e_seat', usd: 10, minutesAgo: 30 },
    });
    expect(seeded.ok()).toBe(true);
    const { candidateId } = (await seeded.json()) as { candidateId: string };
    const payload = async () =>
      page.evaluate(async () => fetch('/api/state', { credentials: 'same-origin' }).then((r) => r.json()));
    // The demo replay owns the store until it ends; wait for the builder state
    // that carries the seeded seat.
    await expect
      .poll(
        async () =>
          ((await payload()).pipeline?.roster ?? []).some(
            (seat: { candidateId: string }) => seat.candidateId === candidateId,
          ),
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
    await page.reload();

    const seat = page.locator('[data-testid^="roster-seat-"]').filter({ hasText: '@e2e_seat' }).first();
    const toggle = seat.locator('[data-testid^="seat-positions-toggle-"]');
    // The seeded position is two copy buys, so the expander counts buys, not coins.
    await expect(toggle).toContainText('Buys (2)');
    await expect(seat.locator('[data-testid^="seat-position-"]')).toHaveCount(0);
    await toggle.click();
    const rows = seat.locator('[data-testid^="seat-position-"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('SEED');
    await expect(rows.first()).toContainText('$10.00');
    // Each buy is its own line, with its own USDC figure.
    const buys = seat.locator('[data-testid^="seat-buy-"]');
    await expect(buys).toHaveCount(2);
    await expect(buys.first()).toContainText('$5.00');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('a long firing reason wraps inside the lane instead of widening the page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await completeSetup(page);
    // The demo replay owns the store while it runs, and only a rebuild replaces
    // it. Wait for it to stop publishing (generatedAt freezes), then seed: the
    // seed route rebuilds, so the builder state (with the seeded row) takes over.
    await expect
      .poll(
        async () => {
          const read = () =>
            page.evaluate(async () => {
              const state = await fetch('/api/state', { credentials: 'same-origin' }).then((r) => r.json());
              return state.generatedAt as string;
            });
          const first = await read();
          await page.waitForTimeout(1_500);
          return (await read()) === first;
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
    const seeded = await page.request.post('/api/test/seed-firing', {
      data: {
        handle: 'e2e_long_firing',
        reason:
          'RANK: OUTSIDE TOP-3 IN 2 CONSECUTIVE SCANS (RANK 5 AT 2026-10-31T14:47:11.313Z, RANK 5 AT 2026-10-31T14:16:52.107Z BEFORE)',
        minutesAgo: 5,
      },
    });
    expect(seeded.ok()).toBe(true);
    const { candidateId } = (await seeded.json()) as { candidateId: string };
    await page.reload();

    const row = page.getByTestId(`fired-row-${candidateId}`).first();
    await expect(row).toBeVisible();
    // The page must not widen, and the reason must stay inside the card.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const card = await page.getByTestId('fired-lane').boundingBox();
    const chip = await row.locator('span.chip').first().boundingBox();
    expect(chip!.x + chip!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
  });

  test('320px width and 200% zoom stack without clipping or page overflow (AC11)', async ({ page }) => {
    // 320px width (the WCAG reflow width): no horizontal page overflow, and the
    // layout stacks to a single column.
    await page.setViewportSize({ width: 320, height: 640 });
    await completeSetup(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const columns = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="roster-panel"] ul');
      return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    });
    expect(columns).toBe(1);

    // 200% zoom of a normal desktop (1280 → a 640px CSS viewport, via CSS
    // zoom): still no card clipped and no sideways page scroll.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const clipped = await page.evaluate(() => {
      const vw = window.innerWidth;
      return [...document.querySelectorAll('.card')].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.right > vw + 1 || rect.left < -1;
      }).length;
    });
    expect(clipped).toBe(0);
  });

  test('light and dark are both complete, token-driven and persistent (AC7/AC8)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await completeSetup(page);
    const toggle = page.getByTestId('theme-toggle');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const darkGlass = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="pipeline-panel"]')!;
      return getComputedStyle(card).backgroundColor;
    });

    // system → dark → light: the whole page switches.
    await toggle.click();
    await toggle.click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lightGlass = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="pipeline-panel"]')!;
      return getComputedStyle(card).backgroundColor;
    });
    expect(lightBg).not.toBe(darkBg);
    expect(lightGlass).not.toBe(darkGlass);
    // The body color IS the token in both themes: no hardcoded hex anywhere.
    const pageToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-page').trim(),
    );
    expect(lightBg).toBe('rgb(245, 246, 248)');
    expect(pageToken.toLowerCase()).toContain('f5f6f8');

    // The choice persists across a reload (and the pre-paint script applies it).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Back to system: with a dark OS preference it resolves dark again.
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('reduced motion: no chip moves, the counts still update (AC5)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await completeSetup(page);
    // Force a fresh replay so a transition (the 6s switch) lands in our window.
    await page.getByTestId('demo-banner').getByRole('button').click();

    // Wait for an edge count to grow — the transition happened.
    await expect
      .poll(async () => (await payload(page)).pipeline.edges.find((e) => e.to === 'exits')?.count24h ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    // …but nothing travelled: the reduced-motion state is static.
    expect(await page.locator('[data-chip]').count()).toBe(0);
  });

  test('a transition animates a chip when motion is allowed (AC5)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await completeSetup(page);
    await page.getByTestId('demo-banner').getByRole('button').click();
    await expect(page.locator('[data-chip]').first()).toBeVisible({ timeout: 30_000 });
  });

  test('loading, error and empty states are explicit (AC10)', async ({ page }) => {
    await completeSetup(page);

    // Empty seat + the discovery stage's un-run state are honest, not blank.
    await expect(page.getByTestId('roster-empty-seat').first()).toContainText('Open seat');
    await page.getByTestId('pipeline-stage-discovery').click();
    await expect(page.getByTestId('pipeline-detail')).toContainText('synced never');

    // The rail's audit tab: a slow response shows its loading state…
    await page.route('**/api/audit', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.getByTestId('rail-tab-audit').click();
    await expect(page.getByTestId('rail-audit-loading')).toBeVisible();
    await expect(page.getByTestId('rail-audit')).toContainText(/audit|demo|replay/i);

    // …and a refused response shows the error state, not a spinner forever.
    await page.unroute('**/api/audit');
    await page.route('**/api/audit', (route) => route.abort());
    await page.getByTestId('rail-tab-watch').click();
    await page.getByTestId('rail-tab-audit').click();
    await expect(page.getByTestId('rail-audit').getByRole('alert')).toBeVisible();
  });
});
