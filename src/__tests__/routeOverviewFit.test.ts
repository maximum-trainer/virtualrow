import { describe, expect, it } from 'vitest';
import { OVERVIEW_MAX_ZOOM, overviewFit, type OverviewPin } from '../lib/ui/routeOverviewFit';

const pin = (id: string, coords: { lat: number; lng: number }[]): OverviewPin => ({
  route: { id, coordinates: coords },
  centroid: {
    lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
    lng: coords.reduce((s, c) => s + c.lng, 0) / coords.length,
  },
});

const willow = pin('willow', [
  { lat: 51.0, lng: -1.02 },
  { lat: 51.01, lng: -1.0 },
  { lat: 51.02, lng: -0.98 },
]);
const thames = pin('thames', [
  { lat: 51.5, lng: -0.3 },
  { lat: 51.48, lng: -0.22 },
]);

describe('overviewFit (#738)', () => {
  it('fits a lone route to its own course, not to a point', () => {
    const fit = overviewFit([willow], null);
    expect(fit).toEqual({
      bounds: [
        [-1.02, 51.0],
        [-0.98, 51.02],
      ],
      padding: 48,
      maxZoom: OVERVIEW_MAX_ZOOM,
    });
  });

  it('caps the zoom at 15 so a short course still shows its surroundings', () => {
    expect(OVERVIEW_MAX_ZOOM).toBe(15);
    const tiny = pin('tiny', [{ lat: 51, lng: -1 }]);
    expect(overviewFit([tiny], null)?.maxZoom).toBe(15);
  });

  it('fits several routes to their centroids', () => {
    const fit = overviewFit([willow, thames], null)!;
    expect(fit.bounds[0][0]).toBeCloseTo(-1.0);
    expect(fit.bounds[1][1]).toBeCloseTo(51.49);
    expect(fit.maxZoom).toBe(OVERVIEW_MAX_ZOOM);
  });

  it('opens around the default route when there is one', () => {
    const fit = overviewFit([willow, thames], 'thames')!;
    expect(fit.bounds[0][0]).toBeCloseTo(-0.46);
    expect(fit.bounds[1][0]).toBeCloseTo(-0.06);
    expect(fit.padding).toBe(32);
    expect(fit.maxZoom).toBe(OVERVIEW_MAX_ZOOM);
  });

  it('returns null with no pins', () => {
    expect(overviewFit([], null)).toBeNull();
  });

  it('#822: widens a lone route to take in the rownative preview pins', () => {
    const sydney = { lat: -33.8, lng: 151.2 };
    const fit = overviewFit([willow], null, [sydney])!;
    expect(fit.bounds[0][0]).toBeCloseTo(-1.0);
    expect(fit.bounds[0][1]).toBeCloseTo(-33.8);
    expect(fit.bounds[1][0]).toBeCloseTo(151.2);
    expect(fit.bounds[1][1]).toBeCloseTo(51.01);
  });

  it('#822: fits preview pins alone when the user has no routes', () => {
    const fit = overviewFit([], null, [
      { lat: 10, lng: 20 },
      { lat: -5, lng: -30 },
    ])!;
    expect(fit.bounds).toEqual([
      [-30, -5],
      [20, 10],
    ]);
  });

  it('#822: the default route still wins over preview pins', () => {
    const fit = overviewFit([willow, thames], 'thames', [{ lat: -33.8, lng: 151.2 }])!;
    expect(fit.bounds[0][0]).toBeCloseTo(-0.46);
    expect(fit.padding).toBe(32);
  });
});
