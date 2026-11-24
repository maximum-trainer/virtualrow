/**
 * How a route's geometry provenance is presented (issue #194 R-10, R-11).
 *
 * The chip is driven by provenance, not by how many points a route happens to
 * have: a 35-gate course is still nothing but gates, and a 9-point attached
 * track is still a real path. A route built from a genuine track gets no chip
 * at all — there is nothing to warn about.
 */

import type { GeometrySource, WaterRoute } from '../types/index';
import { DISTANCE_DISCREPANCY_THRESHOLD } from '../services/routeService';

export interface GeometryProvenanceBadge {
  /** Text shown in the chip. */
  label: string;
  /** Longer explanation, shown as the chip's tooltip. */
  title: string;
  /** Modifier appended to the chip's class name. */
  modifier: string;
}

const BADGES: Record<GeometrySource, GeometryProvenanceBadge | null> = {
  track: null,
  // #747: the course file's own traced path is a real path, like a track.
  path: null,
  'polygon-path': {
    label: 'traced',
    title: 'This course follows a path traced by whoever submitted it, checked against every gate.',
    modifier: 'traced',
  },
  'osm-derived': {
    label: 'path from map data',
    title: 'This course follows the waterway centreline from OpenStreetMap, checked against every gate.',
    modifier: 'osm',
  },
  'gate-chain': {
    label: 'gates only — straight lines',
    title:
      'This course is defined by its gates only, so the path between them is a straight line. '
      + 'Attach a track of the course to row its real shape.',
    modifier: 'outline',
  },
};

/** The chip for a geometry source, or `null` when none should be shown. */
export function geometryProvenanceBadge(source: GeometrySource | undefined): GeometryProvenanceBadge | null {
  return source ? BADGES[source] ?? null : null;
}

/**
 * The "rownative lists X km" note, when their figure differs enough from the
 * length we actually row to be worth showing. Returns `null` otherwise.
 */
export function externalDistanceNote(route: Pick<WaterRoute, 'distance' | 'externalDistanceMeters'>): string | null {
  const external = route.externalDistanceMeters;
  if (!external || !Number.isFinite(external) || external <= 0) return null;

  const difference = Math.abs(route.distance * 1000 - external) / external;
  if (difference <= DISTANCE_DISCREPANCY_THRESHOLD) return null;

  return `rownative lists ${(external / 1000).toFixed(2)} km`;
}

/** Route distance for display, in kilometres to two decimal places. */
export function formatRouteDistanceKm(distanceKm: number): string {
  return `${distanceKm.toFixed(2)} km`;
}

/**
 * rownative's snapshot distance is the straight start-to-finish gate line, so a
 * return course reads as ~0 m. Below 100 m it says nothing true: show no distance.
 */
export function formatSnapshotDistance(distanceMeters: number | undefined): string | null {
  return distanceMeters !== undefined && distanceMeters >= 100
    ? formatRouteDistanceKm(distanceMeters / 1000)
    : null;
}

/**
 * #747: before the `path` source existed, a rownative course whose file
 * carried a `path` was stored as `track`. A rownative route marked `track`
 * with no track attached to its course id is read as `path`.
 */
export function normalizeGeometrySource(
  route: Pick<WaterRoute, 'source' | 'geometrySource' | 'externalId'>,
  hasAttachedTrack: (courseId: string) => boolean,
): GeometrySource | undefined {
  if (
    route.geometrySource === 'track'
    && route.source === 'rownative'
    && route.externalId
    && !hasAttachedTrack(route.externalId)
  ) {
    return 'path';
  }
  return route.geometrySource;
}

/**
 * #747 FR3: the note shown on the route card when the course's own line was
 * refused (a course `path`, or a track the rower attached), naming the gate it
 * missed and by how far. Null when nothing was refused.
 */
export function geometryWarningNote(route: Pick<WaterRoute, 'geometryWarnings'>): string | null {
  return route.geometryWarnings?.find((warning) => warning.trim().length > 0) ?? null;
}
