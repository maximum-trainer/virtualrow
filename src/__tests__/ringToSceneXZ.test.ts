import { describe, it, expect } from 'vitest';

import { ringToSceneXZ } from '../lib/utils/routeWorldCurve';
import { SCENE_SCALE } from '../lib/utils/worldScale';
import type { Coordinate } from '../lib/types/index';

/**
 * #493 Phase 3b: lat/lng → scene XZ for a lake polygon ring, against the
 * same local origin as the route curve so a polygon drawn through this
 * sits over the strip.
 */

describe('ringToSceneXZ', () => {
  it('places the origin coordinate at (0, 0)', () => {
    const origin: Coordinate = { lat: 51.5, lng: -0.1 };
    const [p] = ringToSceneXZ(
      [origin, { lat: 51.51, lng: -0.1 }, { lat: 51.5, lng: -0.09 }],
      origin,
    );
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('places a point ~111m north of origin at a NEGATIVE Z (−Z = north)', () => {
    const origin: Coordinate = { lat: 51.5, lng: -0.1 };
    const north: Coordinate = { lat: 51.501, lng: -0.1 };
    const [, p] = ringToSceneXZ([origin, north, { lat: 51.5, lng: -0.099 }], origin);
    // 0.001° latitude ≈ 111.3 m. Scaled by SCENE_SCALE.
    const expected = -111.3 * SCENE_SCALE;
    expect(p.z).toBeCloseTo(expected, 0);
    expect(p.x).toBeCloseTo(0, 0);
  });

  it('returns [] for a ring shorter than 3 vertices', () => {
    expect(ringToSceneXZ([{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }], { lat: 0, lng: 0 })).toEqual([]);
  });
});
