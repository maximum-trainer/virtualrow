/**
 * #493 AC24 (NFR10) — recorded Overpass fixtures stay within a per-course byte
 * budget. A real request's response size is roughly the fixture's compressed
 * weight; the raw JSON here is a loose upper bound. Over 3 MB a course is
 * probably pulling too much on the live app too, so this is a regression
 * guard for the query margin and selectors, not a hard limit on OSM itself.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(process.cwd(), 'src/__tests__/fixtures/osm');
const PER_FIXTURE_BUDGET_BYTES = 3 * 1024 * 1024;
const TOTAL_BUDGET_BYTES = 10 * 1024 * 1024;

const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json'));

describe('#493 AC24 (NFR10) — Overpass fixture size budget', () => {
  it('records the recorded response sizes (regression guard)', () => {
    const sizes = fixtures.map((f) => ({ f, bytes: statSync(join(DIR, f)).size }));
    for (const { f, bytes } of sizes) {
      expect(bytes, `${f} exceeds the per-fixture budget`).toBeLessThanOrEqual(PER_FIXTURE_BUDGET_BYTES);
    }
    const total = sizes.reduce((sum, s) => sum + s.bytes, 0);
    expect(total, 'combined fixture weight exceeds the total budget').toBeLessThanOrEqual(TOTAL_BUDGET_BYTES);
  });
});
