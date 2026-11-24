import { test, expect, type Page } from '../fixtures/crash-watch';

/**
 * #822 phase 1 — every rownative mirror course renders as a pin on the
 * `/search` world map, read from the bundled snapshot
 * (`/assets/rownative/rownative-index.json`). A guest session must see them
 * without any network call to the public mirror or rownative.icu (NFR3 /
 * AC10).
 */

const UPSTREAM_PATTERNS = [
  /raw\.githubusercontent\.com\/rownative\//i,
  /rownative\.icu/i,
];

async function recordUpstreamCalls(page: Page): Promise<string[]> {
  const hits: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (UPSTREAM_PATTERNS.some((p) => p.test(url))) hits.push(url);
  });
  return hits;
}

test('guest sees rownative pins on the Routes world map, with no mirror fetch (#822)', async ({
  page,
}) => {
  const upstreamHits = await recordUpstreamCalls(page);

  await page.goto('/virtualrow/app/search', { waitUntil: 'networkidle' });

  // The overview opens on the whole set (user routes + previews), so at
  // world zoom Supercluster rolls most of the ~166 courses into clusters.
  // A rownative pin, or a cluster carrying rownative ids, proves the
  // previews reached the map.
  await expect(page.locator('[data-testid="route-overview-map"]')).toBeVisible();
  const previewLocator = page.locator(
    '[data-testid="route-pin-rownative"], [data-testid="route-cluster"][data-rownative-count]:not([data-rownative-count="0"])',
  );
  await expect(previewLocator.first()).toBeVisible();
  const previewCount = await previewLocator.count();
  expect(previewCount).toBeGreaterThan(0);

  // AC10 / NFR3: guests never touch the live mirror or rownative.icu.
  expect(upstreamHits).toEqual([]);
});

test('zooming into a cluster lists the routes in that area in place of "My routes" (#822)', async ({
  page,
}) => {
  await page.goto('/virtualrow/app/search', { waitUntil: 'networkidle' });
  const title = page.getByTestId('routes-list-title');
  await expect(title).toHaveText('My routes');

  // A cluster click flies the map in, which counts as the user moving it.
  const cluster = page.locator('[data-testid="route-cluster"]').first();
  await expect(cluster).toBeVisible();
  await cluster.click();

  await expect(title).toHaveText(/^Routes in this area \(\d+\)$/);
  await expect(page.getByTestId('route-item-rownative').first()).toBeVisible();
});
