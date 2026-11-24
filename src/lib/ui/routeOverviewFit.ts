/**
 * Where the Routes-screen overview map opens (#738).
 *
 * With a single route in the list its pin's bounds collapsed to a point, so
 * MapLibre zoomed to the tile source's max (19) and the panel showed one flat
 * water tile and a pin. A lone route now fits to its own course, and every fit
 * is capped at `OVERVIEW_MAX_ZOOM`.
 */

import type { Coordinate } from '../types/index';

export const OVERVIEW_MAX_ZOOM = 15;
/** Half-size, in degrees, of the box opened around the default route. */
const DEFAULT_ROUTE_SPAN_DEG = 0.2;

export interface OverviewPin {
  route: { id: string; coordinates: readonly Coordinate[] };
  centroid: Coordinate;
}

export interface OverviewFit {
  /** `[[west, south], [east, north]]`, as MapLibre's `fitBounds` takes it. */
  bounds: [[number, number], [number, number]];
  padding: number;
  maxZoom: number;
}

const boundsOf = (points: Iterable<Coordinate>): OverviewFit['bounds'] | null => {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
};

export const overviewFit = (
  pins: readonly OverviewPin[],
  defaultRouteId: string | null,
  extraPoints: readonly Coordinate[] = [],
): OverviewFit | null => {
  const defaultPin = pins.find((p) => p.route.id === defaultRouteId);
  if (defaultPin) {
    const { lat, lng } = defaultPin.centroid;
    return {
      bounds: [
        [lng - DEFAULT_ROUTE_SPAN_DEG, lat - DEFAULT_ROUTE_SPAN_DEG],
        [lng + DEFAULT_ROUTE_SPAN_DEG, lat + DEFAULT_ROUTE_SPAN_DEG],
      ],
      padding: 32,
      maxZoom: OVERVIEW_MAX_ZOOM,
    };
  }
  const bounds =
    pins.length === 1 && extraPoints.length === 0
      ? boundsOf(pins[0].route.coordinates)
      : boundsOf([...pins.map((p) => p.centroid), ...extraPoints]);
  return bounds ? { bounds, padding: 48, maxZoom: OVERVIEW_MAX_ZOOM } : null;
};
