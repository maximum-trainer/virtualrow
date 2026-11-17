import { describe, expect, it } from 'vitest';
import type { Furniture } from '../courseFurniture';
import type { RoutePlacement, RoutePlacementsRegistry } from '../routePlacements';
import {
  composePlacementsForRoute,
  fetchRoutePlacementsRegistry,
  type ComposedPlacement,
} from '../placementsForRoute';

const emptyRegistry: RoutePlacementsRegistry = { $schemaVersion: 2, placements: {} };

const tierR = (
  routeId: string,
  entries: Partial<RoutePlacement>[],
): RoutePlacementsRegistry => ({
  $schemaVersion: 2,
  placements: {
    [routeId]: entries.map((e) => ({
      modelId: 'r-stub-model',
      assetPath: '/assets/scenery/tier-r/r-stub.glb',
      distanceAlongRouteMeters: 0,
      bankSide: 'left' as const,
      lateralOffsetMeters: 0,
      orientationDegrees: 0,
      scale: 1,
      ...e,
    })),
  },
});

const hand = (overrides: Partial<Furniture>[]): Furniture[] =>
  overrides.map((o) => ({
    id: 'a01-buoy-lane-sphere' as const,
    progress: 0.5,
    side: 'left' as const,
    kind: 'buoy' as const,
    ...o,
  }));

describe('#692 composePlacementsForRoute — precedence', () => {
  it('prefers tier-r when it has entries for the route', () => {
    const out = composePlacementsForRoute({
      routeId: 'willowbrook',
      routeMeters: 6_000,
      tierR: tierR('willowbrook', [{ distanceAlongRouteMeters: 3_000 }]),
      handAuthored: hand([{ progress: 0.7 }]),
      synthetic: [{ modelId: 'syn', progress: 0.9, bankSide: 'right', scale: 1, source: 'synthetic' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('tier-r');
    expect(out[0].progress).toBeCloseTo(0.5, 2);
  });

  it('falls through to hand-authored when tier-r is empty for the route', () => {
    // tier-r has entries for *another* route but not this one.
    const out = composePlacementsForRoute({
      routeId: 'willowbrook',
      routeMeters: 6_000,
      tierR: tierR('other-route', [{ distanceAlongRouteMeters: 100 }]),
      handAuthored: hand([{ progress: 0.7 }, { progress: 0.9, side: 'right' }]),
      synthetic: [{ modelId: 'syn', progress: 0.5, bankSide: 'left', scale: 1, source: 'synthetic' }],
    });
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.source === 'hand-authored')).toBe(true);
  });

  it('falls through to synthetic when both tier-r and hand-authored are empty', () => {
    const synthetic: ComposedPlacement[] = [
      { modelId: 'syn1', progress: 0.3, bankSide: 'left', scale: 1, source: 'synthetic' },
      { modelId: 'syn2', progress: 0.6, bankSide: 'right', scale: 1.2, source: 'synthetic' },
    ];
    const out = composePlacementsForRoute({
      routeId: 'willowbrook',
      routeMeters: 6_000,
      tierR: emptyRegistry,
      handAuthored: [],
      synthetic,
    });
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.source === 'synthetic')).toBe(true);
  });

  it('returns an empty list when every source is empty', () => {
    expect(
      composePlacementsForRoute({ routeId: 'x', routeMeters: 1_000 }),
    ).toEqual([]);
  });

  it('respects a tier-r populated route id with no handAuthored or synthetic supplied', () => {
    const out = composePlacementsForRoute({
      routeId: 'r1',
      routeMeters: 2_000,
      tierR: tierR('r1', [{ distanceAlongRouteMeters: 500, orientationDegrees: 90, scale: 2 }]),
    });
    expect(out).toHaveLength(1);
    expect(out[0].progress).toBeCloseTo(0.25, 5);
    expect(out[0].scale).toBe(2);
    expect(out[0].rotationY).toBeCloseTo(Math.PI / 2, 5);
  });

  it('carries castsShadow through tier-r → composed', () => {
    const out = composePlacementsForRoute({
      routeId: 'r1',
      routeMeters: 1_000,
      tierR: tierR('r1', [
        { distanceAlongRouteMeters: 100, castsShadow: false },
        { distanceAlongRouteMeters: 200 }, // undefined falls through
      ]),
    });
    expect(out[0].castsShadow).toBe(false);
    expect(out[1].castsShadow).toBeUndefined();
  });

  it('passes the authored bank side straight through for hand-authored items', () => {
    const out = composePlacementsForRoute({
      routeId: 'r',
      routeMeters: 1_000,
      handAuthored: [
        { id: 'a01-buoy-lane-sphere', progress: 0.5, side: 'right', kind: 'buoy' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].bankSide).toBe('right');
    expect(out[0].modelId).toBe('a01-buoy-lane-sphere');
  });
});

describe('#692 fetchRoutePlacementsRegistry', () => {
  it('resolves to an empty registry on a 404', async () => {
    const res = { ok: false, status: 404, json: async () => ({}) } as Response;
    const fakeFetch = (async () => res) as unknown as typeof fetch;
    const out = await fetchRoutePlacementsRegistry('/base', { fetch: fakeFetch });
    expect(out.placements).toEqual({});
  });

  it('resolves to an empty registry on a parse failure', async () => {
    const res = {
      ok: true,
      status: 200,
      json: async () => ({ not: 'a registry' }),
    } as unknown as Response;
    const fakeFetch = (async () => res) as unknown as typeof fetch;
    const out = await fetchRoutePlacementsRegistry('/base', { fetch: fakeFetch });
    expect(out.placements).toEqual({});
  });

  it('resolves to an empty registry when the fetch itself throws', async () => {
    const fakeFetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const out = await fetchRoutePlacementsRegistry('/base', { fetch: fakeFetch });
    expect(out.placements).toEqual({});
  });

  it('parses a valid v2 payload', async () => {
    const body = {
      $schemaVersion: 2,
      placements: {
        willow: [
          {
            modelId: 'r-foo',
            assetPath: '/assets/scenery/tier-r/r-foo.glb',
            distanceAlongRouteMeters: 42,
            bankSide: 'right',
            lateralOffsetMeters: 1.5,
            orientationDegrees: 10,
            scale: 1,
            castsShadow: false,
          },
        ],
      },
    };
    const res = { ok: true, status: 200, json: async () => body } as unknown as Response;
    const fakeFetch = (async () => res) as unknown as typeof fetch;
    const out = await fetchRoutePlacementsRegistry('/base', { fetch: fakeFetch });
    expect(out.placements.willow).toHaveLength(1);
    expect(out.placements.willow[0].castsShadow).toBe(false);
  });
});
