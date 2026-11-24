import type { WaterRoute } from '../types/index';
import { routeCentroid } from './routeCentroid';

/** `[west, south, east, north]`, as MapLibre's bounds read. West > east crosses the antimeridian. */
export type ViewBbox = [number, number, number, number];

/** The overview map's live view; `userMoved` is false for the opening fit. */
export interface MapView {
  bbox: ViewBbox;
  userMoved: boolean;
}

interface PreviewLike {
  id: string;
  name?: string;
  lat: number;
  lng: number;
}

const inBbox = (lat: number, lng: number, [w, s, e, n]: ViewBbox): boolean => {
  if (lat < s || lat > n) return false;
  return w <= e ? lng >= w && lng <= e : lng >= w || lng <= e;
};

/** The user's routes and the rownative previews whose centroids fall inside the map view. */
export function routesInView<P extends PreviewLike>(
  routes: readonly WaterRoute[],
  previews: readonly P[],
  bbox: ViewBbox,
): { routes: WaterRoute[]; previews: P[] } {
  const routeIds = new Set(routes.map((r) => r.id));
  const visibleRoutes = routes.filter((r) => {
    const c = routeCentroid(r.coordinates);
    return c !== null && inBbox(c.lat, c.lng, bbox);
  });
  const visiblePreviews = previews
    .filter((p) => !routeIds.has(p.id) && inBbox(p.lat, p.lng, bbox))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  return { routes: visibleRoutes, previews: visiblePreviews };
}
