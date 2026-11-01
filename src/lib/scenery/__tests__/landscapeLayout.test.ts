/**
 * #493 AC19 (FR18, G6) — a segment with residential left and park right gets
 * the right per-side profile; buildings land only on the residential side.
 *
 * Pre-#493 the same `SceneryProfile` fed both banks (G6). The service now
 * decides each bank from the land just beyond its measured shore, and
 * `layoutLandscape` reads `leftSceneryProfile`/`rightSceneryProfile` through
 * `getSegmentSceneryProfile` and the per-side `SCENERY_PROFILE_CONFIG`
 * densities. A profile with zero `buildingDensity` emits no buildings on
 * that side; `residential` emits them on the other.
 */
import { describe, expect, it } from 'vitest';
import { layoutLandscape } from '../landscapeLayout';
import type { RouteEnrichmentData, RouteSegmentEnrichment } from '../../services/routeEnrichmentService';
import { vec3 } from '../../renderer/math/vec3';
import type { RouteCurve } from '../../renderer/math/curve';

interface CurveSample {
  position: ReturnType<typeof vec3>;
  tangent: ReturnType<typeof vec3>;
  angle: number;
}

/** Straight line along -Z, 1 km long, with a stable tangent. */
const straightCurve = (): RouteCurve =>
  ({
    length: 1000,
    sample(t: number, out: CurveSample) {
      out.position = vec3(0, 0, -1000 * t);
      out.tangent = vec3(0, 0, -1);
      out.angle = 0;
      return out;
    },
  }) as unknown as RouteCurve;

const segment = (
  index: number,
  startMeters: number,
  endMeters: number,
  left: RouteSegmentEnrichment['leftSceneryProfile'],
  right: RouteSegmentEnrichment['rightSceneryProfile'],
): RouteSegmentEnrichment =>
  ({
    index,
    startMeters,
    endMeters,
    sceneryProfile: 'fallback',
    // High densities so the roll is almost certainly a building, but the
    // profile config will veto on the bank with zero buildingDensity.
    treeDensity: 0.1,
    vegetationDensity: 0.1,
    buildingDensity: 0.9,
    objectScale: 1,
    waterWidthMeters: 20,
    dragMultiplier: 1,
    bearing: 0,
    bearingDelta: 0,
    leftShoreMeters: 10,
    rightShoreMeters: 10,
    leftSceneryProfile: left,
    rightSceneryProfile: right,
  }) as RouteSegmentEnrichment;

describe('#493 AC19 — per-side scenery profile drives per-side landscape', () => {
  it('builds many more buildings on the commercial bank than the wetland bank', () => {
    const enrichment = {
      waterBodyType: 'river',
      waterWidthMeters: 20,
      elevations: [],
      segmentProfiles: [segment(0, 0, 1000, 'commercial', 'wetland')],
      source: 'live',
    } as unknown as RouteEnrichmentData;

    const layout = layoutLandscape({ curve: straightCurve(), enrichment });

    const leftBuildings = layout.leftElements.filter((e) => e.type === 'building').length;
    const rightBuildings = layout.rightElements.filter((e) => e.type === 'building').length;

    // Commercial's building density (0.8) swamps wetland's (0.03).
    expect(leftBuildings).toBeGreaterThan(2);
    expect(leftBuildings).toBeGreaterThan(rightBuildings);

    // Every element carries its own side's profile — G6 is fixed.
    for (const el of layout.leftElements) expect(el.sceneryProfile).toBe('commercial');
    for (const el of layout.rightElements) expect(el.sceneryProfile).toBe('wetland');
  });

  it('mirrors when the sides swap', () => {
    const enrichment = {
      waterBodyType: 'river',
      waterWidthMeters: 20,
      elevations: [],
      segmentProfiles: [segment(0, 0, 1000, 'wetland', 'commercial')],
      source: 'live',
    } as unknown as RouteEnrichmentData;

    const layout = layoutLandscape({ curve: straightCurve(), enrichment });
    const leftBuildings = layout.leftElements.filter((e) => e.type === 'building').length;
    const rightBuildings = layout.rightElements.filter((e) => e.type === 'building').length;

    expect(rightBuildings).toBeGreaterThan(2);
    expect(rightBuildings).toBeGreaterThan(leftBuildings);
    for (const el of layout.leftElements) expect(el.sceneryProfile).toBe('wetland');
    for (const el of layout.rightElements) expect(el.sceneryProfile).toBe('commercial');
  });
});
