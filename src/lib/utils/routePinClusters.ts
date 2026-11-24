import Supercluster from 'supercluster';
import type { WaterRoute } from '../types/index';
import { routeCentroid } from './routeCentroid';

interface SuperclusterPoint {
  type: 'Feature';
  properties: { pointId: string };
  geometry: { type: 'Point'; coordinates: [number, number] };
}

interface SuperclusterClusterProps {
  cluster: true;
  cluster_id: number;
  point_count: number;
}

export interface RoutePinEntry {
  kind: 'pin';
  route: WaterRoute;
  lat: number;
  lng: number;
}

/**
 * A rownative preview pin (#822 phase 1): a course from the bundled
 * `rownative-index.json` snapshot that the user hasn't imported yet.
 * Rendered next to {@link RoutePinEntry}s so the world map surfaces
 * every catalogue course in one layer.
 */
export interface RownativePreviewPinEntry {
  kind: 'pin-rownative';
  preview: RownativePreviewInput;
  lat: number;
  lng: number;
}

export interface RouteClusterEntry {
  kind: 'cluster';
  id: number;
  routeIds: string[];
  rownativePreviewIds: string[];
  lat: number;
  lng: number;
  count: number;
}

export type ClusteredEntry = RoutePinEntry | RownativePreviewPinEntry | RouteClusterEntry;

/**
 * The subset of a bundled rownative course the clustering layer needs —
 * accepted as a bare `{ id, lat, lng }` so the util has no dependency
 * on the rownativeService module.
 */
export interface RownativePreviewInput {
  id: string;
  name?: string;
  country?: string;
  distanceMeters?: number;
  status?: string;
  lat: number;
  lng: number;
}

const ROWNATIVE_PREFIX = 'rn:';
const ROUTE_PREFIX = 'r:';

/**
 * #505 Phase 2 (D4-b): group route pins into clusters at wide zooms, letting
 * co-located pins zoom-on-click apart. Supercluster indexes the pin set once
 * per route change; getClusters is a cheap per-zoom query.
 *
 * Wraps the whole globe in the query bbox so routes near the antimeridian do
 * not drop off the right edge; a MapLibre-driven caller can replace the bbox
 * with the current viewport.
 */
export function clusterRoutePins(
  routes: readonly WaterRoute[],
  zoom: number,
  bbox: [number, number, number, number] = [-180, -85, 180, 85],
  previews: readonly RownativePreviewInput[] = [],
): ClusteredEntry[] {
  const points: SuperclusterPoint[] = [];
  for (const r of routes) {
    const centroid = routeCentroid(r.coordinates);
    if (!centroid) continue;
    points.push({
      type: 'Feature',
      properties: { pointId: `${ROUTE_PREFIX}${r.id}` },
      geometry: { type: 'Point', coordinates: [centroid.lng, centroid.lat] },
    });
  }
  const routeIdSet = new Set(routes.map((r) => r.id));
  for (const preview of previews) {
    // A rownative course already imported shows up as a WaterRoute,
    // so its preview pin would double-plot the same water: skip it.
    if (routeIdSet.has(preview.id)) continue;
    if (!Number.isFinite(preview.lat) || !Number.isFinite(preview.lng)) continue;
    points.push({
      type: 'Feature',
      properties: { pointId: `${ROWNATIVE_PREFIX}${preview.id}` },
      geometry: { type: 'Point', coordinates: [preview.lng, preview.lat] },
    });
  }

  const index = new Supercluster({
    radius: 40,
    maxZoom: 16,
    minPoints: 2,
  });
  index.load(points);

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const clusters = index.getClusters(bbox, clamp(Math.round(zoom), 0, 16));

  const routeById = new Map(routes.map((r) => [r.id, r]));
  const previewById = new Map(previews.map((p) => [p.id, p]));
  const out: ClusteredEntry[] = [];
  for (const feature of clusters) {
    const [lng, lat] = feature.geometry.coordinates as [number, number];
    const props = feature.properties as Partial<SuperclusterClusterProps> & { pointId?: string };
    if (props.cluster === true && typeof props.cluster_id === 'number') {
      const leaves = index.getLeaves(props.cluster_id, Infinity, 0) as unknown as Array<{
        properties: { pointId: string };
      }>;
      const routeIds: string[] = [];
      const rownativePreviewIds: string[] = [];
      for (const leaf of leaves) {
        const id = leaf.properties.pointId;
        if (typeof id !== 'string') continue;
        if (id.startsWith(ROUTE_PREFIX)) routeIds.push(id.slice(ROUTE_PREFIX.length));
        else if (id.startsWith(ROWNATIVE_PREFIX)) rownativePreviewIds.push(id.slice(ROWNATIVE_PREFIX.length));
      }
      out.push({
        kind: 'cluster',
        id: props.cluster_id,
        routeIds,
        rownativePreviewIds,
        lat,
        lng,
        count: props.point_count ?? routeIds.length + rownativePreviewIds.length,
      });
    } else if (typeof props.pointId === 'string') {
      const id = props.pointId;
      if (id.startsWith(ROUTE_PREFIX)) {
        const r = routeById.get(id.slice(ROUTE_PREFIX.length));
        if (r) out.push({ kind: 'pin', route: r, lat, lng });
      } else if (id.startsWith(ROWNATIVE_PREFIX)) {
        const preview = previewById.get(id.slice(ROWNATIVE_PREFIX.length));
        if (preview) out.push({ kind: 'pin-rownative', preview, lat, lng });
      }
    }
  }
  return out;
}
