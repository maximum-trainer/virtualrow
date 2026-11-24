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

  // The SVG fallback stays at FALLBACK_ZOOM (2) with 166 established
  // courses, so Supercluster rolls most previews into a handful of
  // clusters — standalone `route-pin-rownative` pins only appear once
  // a cluster breaks apart on zoom. The map is still proving it
  // surfaces previews so long as at least one cluster or pin carries
  // rownative preview ids.
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
