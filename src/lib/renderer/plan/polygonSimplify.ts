/**
 * Area-preserving polygon simplification for the #493 polygon-water pass.
 *
 * Phase 5 / FR9 / AC7. The polygon-water pass draws every outer ring and
 * hole straight from OSM; a lake can be tens of thousands of vertices,
 * which the `basic` tier can't afford. This simplifier removes the
 * vertex whose removal costs the least triangle area (Visvalingam-Whyatt),
 * which preserves shape at a vertex budget. Deterministic: ties are
 * broken by index, so the same ring + budget always produces the same
 * output.
 *
 * The holes keep every vertex; a lake's island is already small and
 * the budget targets the outer ring where the win is. The budget is
 * read from `BuildingTierCaps.polygonWaterMaxVertices` per performance
 * tier, so changing tier re-simplifies without a fetch.
 *
 * Pure — no GPU context, no DOM, no `window`.
 */

import type { Vec2XZ, PolygonWithHoles } from './waterPolygon';

const triangleArea = (a: Vec2XZ, b: Vec2XZ, c: Vec2XZ): number => {
  // Twice the signed area; we want the magnitude, so abs at the end.
  return Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
};

/**
 * Simplify a closed ring down to at most `maxVertices` vertices.
 *
 * Keeps at least 3 vertices so the result still bounds an area, drops
 * vertices one at a time by smallest triangle-area contribution, and
 * breaks ties by the ring index. A ring already under the budget is
 * returned verbatim (same object identity preserved by callers who
 * care). A ring with fewer than 3 vertices is returned verbatim.
 */
export function simplifyRing(ring: Vec2XZ[], maxVertices: number): Vec2XZ[] {
  if (ring.length <= 3) return ring;
  const target = Math.max(3, Math.floor(maxVertices));
  if (ring.length <= target) return ring;

  // Working copy; we splice in place.
  const points = ring.slice();
  while (points.length > target) {
    let worstIdx = -1;
    let worstArea = Infinity;
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i - 1 + points.length) % points.length];
      const cur = points[i];
      const next = points[(i + 1) % points.length];
      const area = triangleArea(prev, cur, next);
      // Strict less-than keeps the lower index on ties — determinism.
      if (area < worstArea) {
        worstArea = area;
        worstIdx = i;
      }
    }
    if (worstIdx < 0) break;
    points.splice(worstIdx, 1);
  }
  return points;
}

/**
 * Simplify one polygon-with-holes to the per-ring budget. The budget
 * applies to the outer ring; holes are kept verbatim since an island's
 * vertex count is already small relative to a lake outer. Returns the
 * same `polygon` reference when nothing was simplified so callers can
 * cheaply skip unchanged work.
 */
export function simplifyPolygon(
  polygon: PolygonWithHoles,
  maxVertices: number,
): PolygonWithHoles {
  const outer = simplifyRing(polygon.outer, maxVertices);
  if (outer === polygon.outer) return polygon;
  return { outer, holes: polygon.holes };
}

/** Convenience: simplify every polygon in a batch. */
export function simplifyPolygons(
  polygons: PolygonWithHoles[],
  maxVertices: number,
): PolygonWithHoles[] {
  let changed = false;
  const next: PolygonWithHoles[] = polygons.map((p) => {
    const simplified = simplifyPolygon(p, maxVertices);
    if (simplified !== p) changed = true;
    return simplified;
  });
  return changed ? next : polygons;
}
