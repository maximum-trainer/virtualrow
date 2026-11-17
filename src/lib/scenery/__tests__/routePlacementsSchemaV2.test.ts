// #692 FR6 — parseRoutePlacements accepts both v1 and v2 payloads;
// v2 adds an optional per-placement `castsShadow` boolean.

import { describe, expect, it } from 'vitest';
import {
  parseRoutePlacements,
  ROUTE_PLACEMENTS_SCHEMA_VERSION,
  ROUTE_PLACEMENTS_SCHEMA_VERSIONS,
} from '../routePlacements';

const validEntry = (overrides: Record<string, unknown> = {}) => ({
  modelId: 'r-foo',
  assetPath: '/assets/scenery/tier-r/r-foo.glb',
  distanceAlongRouteMeters: 10,
  bankSide: 'left',
  lateralOffsetMeters: 0,
  orientationDegrees: 0,
  scale: 1,
  ...overrides,
});

describe('#692 routePlacements schema v2 (castsShadow)', () => {
  it('exports v2 as the newest schema version', () => {
    expect(ROUTE_PLACEMENTS_SCHEMA_VERSION).toBe(2);
    expect(ROUTE_PLACEMENTS_SCHEMA_VERSIONS).toContain(1);
    expect(ROUTE_PLACEMENTS_SCHEMA_VERSIONS).toContain(2);
  });

  it('accepts a legacy v1 payload unchanged', () => {
    const out = parseRoutePlacements({
      $schemaVersion: 1,
      placements: { r1: [validEntry()] },
    });
    expect(out.$schemaVersion).toBe(1);
    expect(out.placements.r1).toHaveLength(1);
    expect(out.placements.r1[0].castsShadow).toBeUndefined();
  });

  it('accepts a v2 payload and carries castsShadow through', () => {
    const out = parseRoutePlacements({
      $schemaVersion: 2,
      placements: {
        r1: [
          validEntry({ castsShadow: false }),
          validEntry({ castsShadow: true }),
          validEntry(), // undefined → omitted
        ],
      },
    });
    expect(out.$schemaVersion).toBe(2);
    expect(out.placements.r1[0].castsShadow).toBe(false);
    expect(out.placements.r1[1].castsShadow).toBe(true);
    expect(out.placements.r1[2].castsShadow).toBeUndefined();
  });

  it('rejects an unsupported schema version', () => {
    expect(() =>
      parseRoutePlacements({ $schemaVersion: 3, placements: {} }),
    ).toThrow(/unsupported .*3/);
  });

  it('rejects a non-boolean castsShadow', () => {
    expect(() =>
      parseRoutePlacements({
        $schemaVersion: 2,
        placements: { r1: [validEntry({ castsShadow: 'no' })] },
      }),
    ).toThrow(/castsShadow .*boolean/);
  });
});
