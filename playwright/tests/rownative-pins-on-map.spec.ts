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

  // At least one rownative pin lands on the map. The bundled snapshot has
  // ~166 established courses, so not finding one would mean the loader or
  // the map wiring is broken.
  await expect(page.locator('[data-testid="route-pin-rownative"]').first()).toBeVisible();
  const count = await page.locator('[data-testid="route-pin-rownative"]').count();
  expect(count).toBeGreaterThan(0);

  // AC10 / NFR3: guests never touch the live mirror or rownative.icu.
  expect(upstreamHits).toEqual([]);
});
