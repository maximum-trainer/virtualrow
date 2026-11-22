/**
 * Three-free port of `src/components/rower3d/courseFurniture.ts`.
 *
 * Course furniture (#336) is what marks the course itself: a lane buoy on
 * each side at the start and the finish, a distance post every 500 m
 * (capped at `MAX_DISTANCE_POSTS` so a long course spaces them out), and
 * the finish tower on the finish line. The React side turns each entry
 * into a draw via `sceneryStructures.computeStructurePlacements`; we do
 * the equivalent in `placeFurniture` below.
 *
 * Pure TS: `src/components/rower3d/courseFurniture.ts` already imports
 * nothing from three, so this file keeps the exact types & values from
 * the original.
 */

import type { RouteCurve } from '../renderer/math/curve';
import { vec3 } from '../renderer/math/vec3';
import { BUOY_LANE_HALF_WIDTH_METRES, keepClearHalfWidth } from './laneClearance';
import {
  BUILT_IN_FOOTPRINT_LOOKUP,
  footprintRadiusFor,
  type FootprintLookup,
} from './sceneryFootprints';

/** The exact model-id set course furniture draws from. */
export type SceneryModelId =
  | 'a01-buoy-lane-sphere'
  | 'a03-pontoon-floating-dock'
  | 'a06-finish-tower'
  | 'a07-distance-marker-post'
  | 'a09-gazebo-hexagonal'
  | 'a12-regatta-flagpole'
  | 'b01-boathouse-new-england'
  | 'b03-clubhouse-modern'
  // #685 wire-up — every tier-c bridge model the synthetic generator
  // may pick for an OSM crossing (`BRIDGE_MODEL_FOR_KIND` in
  // `syntheticPlacements.ts`). Hand-authored routes use `c01` today;
  // the rest surface when a real `rail` / `bascule` / … crossing is
  // found along the river.
  | 'c01-bridge-arch-masonry'
  | 'c02-bridge-road-concrete'
  | 'c03-bridge-truss-steel'
  | 'c04-bridge-rail-girder'
  | 'c05-bridge-bascule'
  | 'c06-bridge-foot-suspension'
  | 'c07-bridge-dutch-lift'
  | 'c08-bridge-cantilever';

export type FurnitureKind = 'buoy' | 'furniture' | 'span';

export interface Furniture {
  id: SceneryModelId;
  progress: number;
  /** `span` furniture (bridges) sits at the centreline, so the side is not meaningful; author it as 'left' and the engine still centres it. */
  side: 'left' | 'right';
  kind: FurnitureKind;
}

export const DISTANCE_POST_INTERVAL_METERS = 500;
export const MAX_DISTANCE_POSTS = 30;
/** #685 D2b lane-buoy cadence: 250 m on both sides. Live after #689. */
export const LANE_BUOY_INTERVAL_METERS = 250;
/** Hard cap on the two-sided buoy count so an absurdly long route
 *  (1 000+ km) can't blow the engine's `COURSE_FURNITURE_MAX_INSTANCES`
 *  pool budget. 1024 ÷ 2 sides = 512 slots, minus the start/finish pair
 *  leaves room for 510 regular slots — leave a safety margin at 500. */
export const MAX_LANE_BUOY_SLOTS = 500;

const BUOY: SceneryModelId = 'a01-buoy-lane-sphere';
const POST: SceneryModelId = 'a07-distance-marker-post';
const TOWER: SceneryModelId = 'a06-finish-tower';
const FLAG: SceneryModelId = 'a12-regatta-flagpole';

/**
 * #690 — hand-authored per-route furniture additions. Keyed by the
 * route's engine id (e.g. the Willowbrook demo uses `'1'` per
 * `WILLOWBROOK_ROUTE_ID`). Kept in-file rather than a JSON schema so
 * adding a route is one TS edit; the existing tier-r route-placements
 * JSON stays reserved for #449's llm-cad output.
 *
 * Progress values are the fraction along the route; side is the bank
 * the prop stands on (bridges use 'left' and the engine centres them).
 * Keep the list to the scale a chase-camera actually reads — one
 * boathouse near the start, one bridge mid-route, a pontoon or two, a
 * gazebo as a landmark, a clubhouse near the finish — rather than
 * trying to cover every hundred metres.
 */
const ROUTE_EXTRAS: Record<string, readonly Furniture[]> = {
  // Willowbrook demo (simulated 6.671 km).
  '1': [
    { id: 'b01-boathouse-new-england', progress: 0.02, side: 'left', kind: 'furniture' },
    { id: 'a03-pontoon-floating-dock', progress: 0.03, side: 'right', kind: 'furniture' },
    { id: 'c01-bridge-arch-masonry', progress: 0.15, side: 'left', kind: 'span' },
    { id: 'a03-pontoon-floating-dock', progress: 0.32, side: 'right', kind: 'furniture' },
    { id: 'a09-gazebo-hexagonal', progress: 0.55, side: 'left', kind: 'furniture' },
    { id: 'c01-bridge-arch-masonry', progress: 0.72, side: 'left', kind: 'span' },
    { id: 'b03-clubhouse-modern', progress: 0.93, side: 'left', kind: 'furniture' },
  ],
};

/** Hand-authored per-route additions for the given engine route id. */
export const routeExtras = (routeId: string | null | undefined): readonly Furniture[] =>
  routeId && routeId in ROUTE_EXTRAS ? ROUTE_EXTRAS[routeId] : [];

const buoyLine = (progress: number): Furniture[] => [
  { id: BUOY, progress, side: 'left', kind: 'buoy' },
  { id: BUOY, progress, side: 'right', kind: 'buoy' },
];

const flagLine = (progress: number): Furniture[] => [
  { id: FLAG, progress, side: 'left', kind: 'furniture' },
  { id: FLAG, progress, side: 'right', kind: 'furniture' },
];

export const courseFurniture = (
  routeMeters: number,
  // `routeId` was consumed here pre-#685-wire-up to fold `ROUTE_EXTRAS`
  // into the output. The engine now composes per-route placements
  // through `composePlacementsForRoute` and feeds them to
  // `placeFurniture` as `extras`. The parameter is kept for backward
  // compatibility with legacy callers that pass an id (eg
  // `sceneryStructures.computeStructurePlacements`), and intentionally
  // unused here — prefixed `_` so the lint stays happy.
  _routeId?: string | null,
): Furniture[] => {
  if (!Number.isFinite(routeMeters) || routeMeters <= 0) return [];

  const slots = Math.floor(routeMeters / DISTANCE_POST_INTERVAL_METERS);
  const interval = DISTANCE_POST_INTERVAL_METERS * Math.max(1, Math.ceil(slots / MAX_DISTANCE_POSTS));
  const posts = Math.floor(routeMeters / interval);

  // Lane buoys every LANE_BUOY_INTERVAL_METERS on both sides, inclusive of
  // the start and finish lines. On an absurdly long route the cadence
  // widens so the two-sided slot count stays within MAX_LANE_BUOY_SLOTS
  // (the engine's COURSE_FURNITURE_MAX_INSTANCES pool budget allows 1024
  // instances per model; 500 slots × 2 sides keeps a safety margin).
  //
  // #689 unblocked on #688 — the sceneryMeshPass now flags
  // `a01-buoy-lane-sphere` as shadow-neutral, so the extra buoy
  // instances no longer inflate the shadow-depth pass's triangle count.
  const rawBuoySlots = Math.floor(routeMeters / LANE_BUOY_INTERVAL_METERS);
  // `rawBuoySlots + 1` because the slots run `[0, 1, ..., N]` inclusive
  // at both start and finish. The stride widens the step size enough to
  // bring the slot count under the cap.
  const buoyStride = Math.max(1, Math.ceil((rawBuoySlots + 1) / MAX_LANE_BUOY_SLOTS));
  const buoyInterval = LANE_BUOY_INTERVAL_METERS * buoyStride;
  const buoySlots = Math.floor(routeMeters / buoyInterval);
  const buoyEntries: Furniture[] = [];
  buoyEntries.push(...buoyLine(0));
  for (let i = 1; i < buoySlots; i += 1) {
    buoyEntries.push(...buoyLine((i * buoyInterval) / routeMeters));
  }
  buoyEntries.push(...buoyLine(1));

  return [
    ...flagLine(0),
    ...buoyEntries,
    ...Array.from({ length: posts }, (_, i) => ({
      id: POST,
      progress: ((i + 1) * interval) / routeMeters,
      side: 'left' as const,
      kind: 'furniture' as const,
    })),
    ...flagLine(1),
    { id: TOWER, progress: 1, side: 'right', kind: 'furniture' as const },
    // #685 wire-up — hand-authored per-route additions used to land
    // here via `routeExtras(routeId)`. The engine now composes them
    // through `composePlacementsForRoute` (tier-r llm-cad > hand-
    // authored > synthetic) and feeds the result into `placeFurniture`
    // as `extras`, so this function stays purely generic. Legacy
    // callers that pass a routeId still get the same generic output —
    // the parameter is kept for backward compatibility (eg the React-
    // side `sceneryStructures.computeStructurePlacements`).
  ];
};

/**
 * A placed furniture item in world space, ready for the engine's instanced-
 * mesh registry (lands with the engine-side pass). Position comes from the
 * route curve at `progress`, offset laterally by the side's buoy-lane width
 * (buoys) or the shore-plus-margin width (bank furniture).
 */
export interface FurniturePlacement {
  id: SceneryModelId;
  /** World-space [x, y, z]. */
  position: [number, number, number];
  /** Radians about Y: furniture faces the water (perp inward), buoys face the tangent. */
  rotationY: number;
  progress: number;
  side: 'left' | 'right';
  kind: FurnitureKind;
}

/** Lane half-width for buoys: a comfortable rowing lane either side of the centreline. */
export { BUOY_LANE_HALF_WIDTH_METRES };
/** How far from the waterline course furniture stands on the bank. The
 *  furniture also respects its own footprint radius (#723 FR3) and the
 *  racing-line keep-clear corridor (#723 FR1); this is the extra margin
 *  on top of that. */
export const FURNITURE_BANK_OFFSET_METRES = 2;

export interface PlaceFurnitureInput {
  curve: RouteCurve;
  routeMeters: number;
  /** Per-side waterline half-width (scene units). Default: a symmetric 20 m channel. */
  shoreHalfWidth?: (progress: number, side: 'left' | 'right') => number;
  /** #690 — engine route id. Kept for symmetry with other scene seams; the
   *  per-route placements are now supplied through `extras` instead of
   *  looked up by id inside the function (#685 wire-up). */
  routeId?: string | null;
  /**
   * #685 wire-up — per-route placements composed by the engine from the
   * three sources (`composePlacementsForRoute`): tier-r llm-cad,
   * hand-authored `ROUTE_EXTRAS`, synthetic bridges. Each entry is
   * positioned exactly like the generic items — on the lane for buoys,
   * at the river centre for spans, on the shore for everything else.
   */
  extras?: readonly Furniture[];
  /** #723 FR3 — per-model XZ footprint radius lookup. When null, a per-tier
   *  fallback keeps the keep-clear maths safe. */
  footprintLookup?: FootprintLookup | null;
}

export const placeFurniture = ({
  curve,
  routeMeters,
  shoreHalfWidth,
  routeId,
  extras,
  footprintLookup = BUILT_IN_FOOTPRINT_LOOKUP,
}: PlaceFurnitureInput): FurniturePlacement[] => {
  const defaults = (_t: number, _side: 'left' | 'right'): number => 10;
  const shore = shoreHalfWidth ?? defaults;
  const corridor = keepClearHalfWidth();
  const items: Furniture[] = [
    ...courseFurniture(routeMeters, routeId),
    ...(extras ?? []),
  ];
  const out: FurniturePlacement[] = [];
  const sample = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
  for (const f of items) {
    curve.sample(f.progress, sample);
    const perpX = -sample.tangent[2];
    const perpZ = sample.tangent[0];
    const perpLen = Math.hypot(perpX, perpZ) || 1;
    const px = perpX / perpLen;
    const pz = perpZ / perpLen;
    const sideSign = f.side === 'left' ? -1 : 1;
    const halfWidth = shore(f.progress, f.side);
    const radius = footprintRadiusFor(f.id, footprintLookup);
    // Span furniture (bridges) sits at the river centre, oriented
    // perpendicular to the tangent so the arch crosses the water.
    // Buoys live on the lane. Everything else — including hand-authored
    // boathouses and clubhouses whose own footprint radius is wider than
    // the default FURNITURE_BANK_OFFSET — stands fully past the waterline
    // and clear of the racing corridor (#723 FR1/FR3).
    const laneOffset = f.kind === 'buoy'
      ? BUOY_LANE_HALF_WIDTH_METRES
      : f.kind === 'span'
        ? 0
        : Math.max(
            halfWidth + FURNITURE_BANK_OFFSET_METRES + radius,
            corridor + radius,
          );
    const tangentAngle = Math.atan2(sample.tangent[0], sample.tangent[2]);
    const rotationY = f.kind === 'buoy'
      ? tangentAngle
      : f.kind === 'span'
        ? tangentAngle + Math.PI / 2
        : tangentAngle + sideSign * (Math.PI / 2);
    out.push({
      id: f.id,
      position: [
        sample.position[0] + px * sideSign * laneOffset,
        0,
        sample.position[2] + pz * sideSign * laneOffset,
      ],
      rotationY,
      progress: f.progress,
      side: f.side,
      kind: f.kind,
    });
  }
  return out;
};
