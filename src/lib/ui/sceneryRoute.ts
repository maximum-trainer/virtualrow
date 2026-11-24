/**
 * Shell route → engine `SceneryRoute` adapter (#570 AC2, extended for #549).
 *
 * The `/row` screen hands the WebGPU engine a route through the `rideCanvas`
 * seam. The engine treats the route as `unknown` and only acts on it when it
 * is a `SceneryRoute` — an object with a `pools` array — reading `curvePoints`
 * (world-space points for the boat/ghost curve) and `totalDistanceMeters` (the
 * real route length it maps row distance onto). A plain `WaterRoute` has
 * neither, so without this adapter the engine falls back to a canned straight
 * line and the boat never follows the selected route.
 *
 * Beyond that minimum, this adapter forwards:
 *   - `isClosedLoop`: so a lap route wraps instead of showing a seam where
 *     the finish meets the start. Detection mirrors
 *     `src/components/rower3d/curve.ts`'s `isClosedLoop` (≥4 coords and the
 *     endpoints within 5 m).
 *   - `waterEdgesForProgress`: per-progress shore widths taken from the
 *     route's OSM enrichment via `getWaterEdgesSceneUnitsForProgress`, so
 *     the water strip bends and widens with the measured river rather than
 *     sitting as a symmetric ±20 m ribbon. Falls back to the enrichment's
 *     `waterWidthMeters` or the engine's default half-width when no
 *     enrichment is passed.
 *
 * Framework-free and intentionally not coupled to the engine's own types: the
 * seam passes the route as `unknown`, so the return shape mirrors the engine's
 * `SceneryRoute` structurally without importing from `src/lib/renderer`.
 *
 * `pools` is empty here: this slice wires the route curve the boat runs on, not
 * the scenery instancing (the engine mounts an empty scenery pass for an empty
 * `pools`, which is what it already does on the fallback route).
 */
import { beyondEveryLegShore, centrelineIndex, clearOfEveryLeg, sampledCentreline } from '../scenery/everyLegClearance';
import { BUILT_IN_FOOTPRINT_LOOKUP, footprintRadiusFor } from '../scenery/sceneryFootprints';
import type { WaterRoute } from '../types/index';
import {
  getWaterEdgesSceneUnitsForProgress,
  type RouteEnrichmentData,
  type WaterBodyType,
} from '../services/routeEnrichmentService';
import {
  COASTAL_LAND_SIDE,
  COASTAL_SEA_HALF_WIDTH_METERS,
  COASTAL_TAG,
  resolveWaterType,
  waterWidthForType,
} from '../scenery/waterType';
import { DEFAULT_WATER_WIDTH_METERS } from '../scenery/waterHalfWidth';
import { distanceBetweenLatLng, latLngToMeters } from '../utils/geoUtils';
import type { OsmBuilding } from '../services/routeEnrichmentService';
import { SCENE_SCALE } from '../utils/worldScale';
import { routeCurvePoints, ringToSceneXZ } from '../utils/routeWorldCurve';
import { RouteCurve } from '../renderer/math/curve';
import { vec3 } from '../renderer/math/vec3';
import type { PoolInput } from '../renderer/plan/instancePools';
import {
  batchFoliagePools,
  FOLIAGE_SHAPES,
  layoutFoliage,
} from '../scenery/foliagePlan';
import { layoutReeds, layoutRocks, ROCK_SPECIES } from '../scenery/reedRockPlan';
import { layoutLandscape, layoutToBuildingSpecs } from '../scenery/landscapeLayout';
import {
  getRouteSceneryTrack,
  trackWaterForProfile,
} from '../../components/rower3d/sceneryTrack';
import { SCENERY_PROFILES } from '../../components/rower3d/sceneryConfig';
import { getSegmentSceneryProfile } from '../../components/rower3d/segmentScenery';
import type { BuildingSpec } from '../renderer/plan/buildings';
import {
  budgetFor,
  stationSpacingFor,
  computePlacements,
  distinctProfiles,
  keepsKitTrees,
  type PerformanceMode,
  type Placement,
} from '../scenery/sceneryPlacement';
import {
  computeStructurePlacements,
  routeStructures,
} from '../scenery/sceneryStructures';
import {
  resolveSceneryModels,
  type ResolvedScenery,
  type SceneryModelId,
} from '../../components/rower3d/sceneryAssets';
import { resolveRegion } from '../../components/rower3d/sceneryRegion';
import type { SceneryProfile } from '../services/routeEnrichmentService';
import { buildTerrainProfile } from '../services/routeEnrichmentService';
import {
  waterDetectionSummaryOf,
  type WaterDetectionSummary,
} from '../renderer/engine/waterDetectionSummary';

/**
 * #755 FR2 — the stand-in the layouts read the water's width from when no
 * map data has arrived: only the type and its width, no segments, so every
 * other layout input behaves exactly as with no enrichment at all.
 */
const OPEN_WATER_TYPES: ReadonlySet<WaterBodyType> = new Set(['lake', 'reservoir', 'open_water']);

const waterOnlyEnrichment = (routeId: string, waterType: WaterBodyType): RouteEnrichmentData => ({
  routeId,
  elevations: [],
  segmentProfiles: [],
  waterBodyType: waterType,
  waterWidthMeters: waterWidthForType(waterType),
  waterColor: '',
  waveIntensity: 0,
  fetchedAt: 0,
  source: 'fallback',
});

/** Mirrors `LOOP_CLOSURE_TOLERANCE_METERS` in the React curve builder. */
export const LOOP_CLOSURE_TOLERANCE_METERS = 5;

export interface WaterEdges {
  left: number;
  right: number;
}

/** Chunk size (metres of route) used when batching foliage into per-chunk pools. */
export const FOLIAGE_CHUNK_METRES = 150;

/** One GLB-asset instance in world space, ready for `sceneryMeshPass.setInstances`. */
export interface SceneryInstance {
  position: [number, number, number];
  rotationY: number;
  scale: number;
}

/** All GLB instances for one `SceneryModelId`, so the engine knows what to load. */
export interface SceneryGlbGroup {
  id: SceneryModelId;
  instances: SceneryInstance[];
}

/** The engine-facing route shape (structural match for `SceneryRoute`). */
export interface EngineRoute {
  /** Foliage instance pools, one per (species, chunk). */
  pools: PoolInput[];
  /** Procedural facade buildings along the banks (`landscapeLayout` → `BuildingSpec[]`). */
  buildings?: BuildingSpec[];
  /** GLB scenery (bank-edge, scatter, buildings, trees, landform, backdrop,
   * course furniture, bridges, landmarks) — one group per model id. */
  sceneryGlbs?: SceneryGlbGroup[];
  /** World-space boat/ghost curve; omitted when the route has too few points. */
  curvePoints?: [number, number, number][];
  /** Real route length in metres, matching the shell's finish detection. */
  totalDistanceMeters?: number;
  /** True when the GPS polyline closes back on itself (≥4 coords, ≤5 m apart). */
  isClosedLoop?: boolean;
  /**
   * Per-progress shore widths in scene units. Called at engine attach time
   * (not per frame), so it's safe to keep the closure alive for the life of
   * the row screen. Omitted when the route has no enrichment — the engine
   * then applies its symmetric fallback.
   */
  waterEdgesForProgress?: (progress: number) => WaterEdges;
  /** #755 FR4 — a coastal course: land on this side only, sea on the other. */
  landSide?: 'left' | 'right';
  /** #741 — the route's water detection, published as `__ROWER3D_WATER_DETECTION`. */
  waterDetectionSummary?: WaterDetectionSummary;
  /**
   * Dominant biome profile along the route — the first profile the enrichment
   * mentions, or 'fallback' when there is none. The bank pass uses it to pick
   * the baked density tile for its grass modulation (#496). One profile per
   * route for now; the per-segment React approach is a follow-up.
   */
  dominantProfile?: SceneryProfile;
  /** #725 FR5 — each bank's scenery profile along the route, for the bank's ground cover. */
  profileForProgress?: (progress: number, side: 'left' | 'right') => SceneryProfile;
  /**
   * Lake / open-water polygons projected into scene XZ (#493 Phase 3b). Each
   * polygon's outer ring and any islands are already in metres relative to
   * the route's local origin, so the renderer only has to tessellate +
   * disc-clip. Omitted when the route has no polygon water (a river) or when
   * the polygon-water flag is off.
   */
  lakePolygons?: Array<{ outer: { x: number; z: number }[]; holes: { x: number; z: number }[][] }>;
  /**
   * #685 wire-up — OSM bridge crossings along the route, consumed by the
   * synthetic placement generator (#691). Already computed by the
   * enrichment service via `findCrossings`; omitted when the route has
   * no enrichment, or no bridges above the water.
   */
  crossings?: readonly { readonly progress: number; readonly kind: string }[];
}

/** Default OSM building height when the tags carry neither `height` nor levels. */
const DEFAULT_OSM_BUILDING_HEIGHT_M = 6;
/** Minimum footprint area in m² to be worth drawing as a prism. */
const MIN_OSM_BUILDING_FOOTPRINT_M2 = 4;

const osmBuildingToSpec = (
  osm: OsmBuilding,
  origin: { lat: number; lng: number },
): BuildingSpec | null => {
  if (!osm.footprint || osm.footprint.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of osm.footprint) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const { x, y } = latLngToMeters(p.lat, p.lng, origin.lat, origin.lng);
    // Scene +Z = south, so project y (north) onto −Z.
    const sceneZ = -y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (sceneZ < minZ) minZ = sceneZ;
    if (sceneZ > maxZ) maxZ = sceneZ;
  }
  if (!Number.isFinite(minX)) return null;
  const halfWidth = (maxX - minX) / 2;
  const halfDepth = (maxZ - minZ) / 2;
  if (halfWidth * halfDepth * 4 < MIN_OSM_BUILDING_FOOTPRINT_M2) return null;
  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    halfWidth,
    halfDepth,
    height: osm.heightMeters ?? DEFAULT_OSM_BUILDING_HEIGHT_M,
    profile: osm.kind === 'commercial' || osm.kind === 'retail'
      ? 'commercial'
      : osm.kind === 'house' || osm.kind === 'residential' || osm.kind === 'apartments'
        ? 'residential'
        : 'fallback',
  };
};

const detectClosedLoop = (route: WaterRoute): boolean => {
  const coords = route.coordinates ?? [];
  if (coords.length < 4) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return (
    distanceBetweenLatLng(first.lat, first.lng, last.lat, last.lng) <= LOOP_CLOSURE_TOLERANCE_METERS
  );
};

/**
 * Build the engine route from the selected {@link WaterRoute}, or `null` when
 * nothing is selected (the caller then mounts the engine with no route).
 *
 * `totalDistanceMeters` is `distance × 1000` to match `RideSessionStore`'s own
 * finish detection (`route.distance * 1000`), so the engine's progress
 * (`distanceMeters / totalDistanceMeters`) and the finish line agree. It is
 * omitted for a zero-length route so the engine falls back to the curve's own
 * chord length rather than snapping progress to a 1 m course.
 */
/**
 * Default tier used when no caller passes one through. Matches React's
 * `resolvePerformanceMode()` fallback for a browser-less or probe-free
 * invocation: real users get `'medium'`, which is what unit tests exercise.
 * The `/row` page always passes a real tier so this only applies to tests
 * and other callers that don't care about scenery density.
 */
export const DEFAULT_SCENERY_TIER: PerformanceMode = 'medium';

export const toEngineRoute = (
  route: WaterRoute | null | undefined,
  enrichment?: RouteEnrichmentData | null,
  tier: PerformanceMode = DEFAULT_SCENERY_TIER,
): EngineRoute | null => {
  if (!route) return null;

  const curvePoints = routeCurvePoints(route.coordinates ?? []);
  const totalDistanceMeters = route.distance > 0 ? route.distance * 1000 : undefined;
  const isClosedLoop = detectClosedLoop(route);

  // #755 FR1/FR2 — the water type comes from the enrichment when it knows,
  // else the route's tag, else its name, with no network. A curated demo
  // track (Willowbrook) authors its own water per biome and keeps its
  // layout; every other route without map data is laid out against the
  // width its type implies.
  const routeTrack = getRouteSceneryTrack(route.id);
  const resolvedWater = routeTrack
    ? { waterType: trackWaterForProfile(routeTrack, distinctProfiles(enrichment ?? null, routeTrack)[0] ?? 'fallback'), typeSource: 'tag' as const }
    : resolveWaterType(route, enrichment);
  const layoutEnrichment: RouteEnrichmentData | null =
    enrichment ??
    (routeTrack || resolvedWater.waterType === 'unknown' ? null : waterOnlyEnrichment(route.id, resolvedWater.waterType));
  // FR3 — open water with no map data: the shore of every leg, not only the
  // one a placement was laid out from, keeps the bank back.
  const openShoreHalfWidth =
    !enrichment && layoutEnrichment && OPEN_WATER_TYPES.has(resolvedWater.waterType)
      ? layoutEnrichment.waterWidthMeters / 2
      : null;

  // The water-edges fn is built even without enrichment so the engine can
  // use a width that reflects a `waterWidthMeters` carried on a fallback
  // enrichment (what the React scene does via defaultWaterWidthMeters).
  const fallbackWidthMeters =
    layoutEnrichment?.waterWidthMeters ?? DEFAULT_WATER_WIDTH_METERS / SCENE_SCALE;
  // FR4 — a coastal course with no map data: land on one side, the sea out
  // to the horizon on the other.
  const landSide: 'left' | 'right' | undefined =
    !enrichment && !routeTrack && route.tags?.includes(COASTAL_TAG) ? COASTAL_LAND_SIDE : undefined;
  const seaSide = landSide === 'left' ? 'right' : landSide === 'right' ? 'left' : null;
  const waterEdgesForProgress = (progress: number): WaterEdges => {
    const edges = getWaterEdgesSceneUnitsForProgress(
      layoutEnrichment?.segmentProfiles,
      fallbackWidthMeters,
      progress,
    );
    return seaSide ? { ...edges, [seaSide]: COASTAL_SEA_HALF_WIDTH_METERS * SCENE_SCALE } : edges;
  };

  // Populate the foliage pools and facade buildings from the same
  // deterministic layouts the React scene uses. Three-free:
  // `src/lib/scenery/*` samples the curve through `RouteCurve` and shares
  // `getSegmentSceneryProfile`, `SCENERY_PROFILES`, `SceneryTrack` with the
  // React side.
  const pools: PoolInput[] = [];
  let buildings: BuildingSpec[] = [];
  let sceneryGlbsResult: SceneryGlbGroup[] = [];
  if (curvePoints.length >= 2) {
    const curve = new RouteCurve(
      curvePoints.map(([x, y, z]) => vec3(x, y, z)),
      isClosedLoop,
    );
    const track = routeTrack;
    const trees = layoutFoliage({
      curve,
      enrichment: layoutEnrichment,
      track,
      speciesTypes: FOLIAGE_SHAPES,
    });
    // #591-fu: reeds + rocks go through the same pool-batching path as the
    // tree layouts (same `FoliageTree` shape, species indices 3/4). The
    // solid-flora stage switches geometry on `speciesIndex` and the sprite
    // pass collapses the billboard to zero for 3/4, so no new pool kind is
    // needed.
    const reeds = layoutReeds({ curve, enrichment: layoutEnrichment, track });
    const rocks = layoutRocks({ curve, enrichment: layoutEnrichment, track });
    // #725 — the centreline as drawn (the spline), sampled every ~5 m. The
    // control points cut inside the spline at a stake turn, and with
    // stations every few tens of metres a landform lands in that gap.
    const everyLeg = centrelineIndex(sampledCentreline(curve));
    // FR4 — on a coastal course nothing stands on the sea side.
    const sideSample = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
    const onLandSide = (progress: number, x: number, z: number): boolean => {
      if (!seaSide) return true;
      curve.sample(Math.max(0, Math.min(1, progress)), sideSample);
      // perp = tangent × up = (−tz, 0, tx); negative is the left bank.
      const s = (x - sideSample.position[0]) * -sideSample.tangent[2] + (z - sideSample.position[2]) * sideSample.tangent[0];
      return (s < 0 ? 'left' : 'right') === landSide;
    };
    const onShore = <T,>(items: readonly T[], at: (item: T) => readonly [number, number], radius?: (item: T) => number): T[] =>
      openShoreHalfWidth === null ? [...items] : beyondEveryLegShore(items, everyLeg, openShoreHalfWidth, at, radius);
    const groundProps = onShore(
      [...trees, ...reeds, ...rocks].filter((t) => onLandSide(t.progress, t.position[0], t.position[2])),
      (t) => [t.position[0], t.position[2]],
    );
    const speciesCount = Math.max(FOLIAGE_SHAPES.length, ROCK_SPECIES + 1);
    const routeLength = (totalDistanceMeters ?? curve.approximateLength(32)) || 1;
    pools.push(...batchFoliagePools(groundProps, speciesCount, routeLength, FOLIAGE_CHUNK_METRES));

    const laidOut = layoutLandscape({ curve, enrichment: layoutEnrichment, track });
    const landscape = seaSide
      ? { leftElements: seaSide === 'left' ? [] : laidOut.leftElements, rightElements: seaSide === 'right' ? [] : laidOut.rightElements }
      : laidOut;
    buildings = onShore(layoutToBuildingSpecs(landscape, SCENERY_PROFILES), (b) => [b.x, b.z], (b) => Math.hypot(b.halfWidth, b.halfDepth));
    // Real OSM buildings on top of the procedural facades (#549 slice 4).
    // Convert each footprint to an axis-aligned prism anchored at the
    // first route coordinate so lat/lng → scene metres uses one origin.
    const origin = route.coordinates?.[0];
    if (origin && layoutEnrichment?.buildings?.length) {
      for (const osm of layoutEnrichment.buildings) {
        const spec = osmBuildingToSpec(osm, origin);
        if (spec) buildings.push(spec);
      }
    }

    // GLB scenery (bank-edge, scatter, buildings, trees, landform, backdrop,
    // bridges, landmarks, finish-area furniture). The `/row` adapter is where
    // the layout runs so the engine stays about rendering; this is pure maths
    // on the curve + enrichment + track, matching the React scene's pipeline.
    // Prior to #591-fu the mode was hard-wired to 'medium', which suppressed
    // GLB kit trees entirely (`keepsKitTrees` is true only on high/extra-high)
    // and pinned the per-step placement loop at a 0.7 budget. React resolves
    // the real device tier via `resolvePerformanceMode()` and hands it to the
    // scene, so a given rig gets the matching density on both engines. The
    // `/row` page now plumbs that same tier here; `DEFAULT_SCENERY_TIER` keeps
    // tests and other no-arg callers deterministic at `'medium'`.
    const mode: PerformanceMode = tier;
    const budget = budgetFor(mode);
    const profiles: SceneryProfile[] = distinctProfiles(layoutEnrichment, track);
    const region = resolveRegion(route.coordinates ?? null);
    const resolvedByProfile = new Map<SceneryProfile, ResolvedScenery>();
    for (const profile of profiles) {
      const waterType = track ? trackWaterForProfile(track, profile) : resolvedWater.waterType;
      const treeSpecies = SCENERY_PROFILES[profile]?.trees.species ?? [];
      resolvedByProfile.set(profile, resolveSceneryModels(profile, waterType, treeSpecies, region));
    }
    const kitTrees = keepsKitTrees(mode);
    const left = seaSide === 'left' ? [] : computePlacements({ curve, enrichment: layoutEnrichment, resolvedByProfile, budget, side: 'left', track, kitTrees, stationSpacingMetres: stationSpacingFor(mode) });
    const right = seaSide === 'right' ? [] : computePlacements({ curve, enrichment: layoutEnrichment, resolvedByProfile, budget, side: 'right', track, kitTrees, stationSpacingMetres: stationSpacingFor(mode) });
    const requests = routeStructures({
      side: 'left',
      hasCurve: true,
      coordinates: route.coordinates ?? null,
      crossings: layoutEnrichment?.crossings ?? null,
      routeMeters: totalDistanceMeters,
    });
    const terrain = buildTerrainProfile(layoutEnrichment?.elevations);
    // On a coastal course a bank structure on the sea side has no bank to stand on.
    // A boathouse or finish tower moves to the land; buoys and bridges stay put.
    const sidedRequests = landSide
      ? requests.map((r) => (r.kind === 'furniture' || r.kind === 'landmark' ? { ...r, side: landSide } : r))
      : requests;
    const structures: Placement[] = computeStructurePlacements(curve, sidedRequests, terrain, layoutEnrichment).filter(
      (p) => p.footing === 'water' || onLandSide(p.progress, p.position[0], p.position[2]),
    );
    const grouped = new Map<SceneryModelId, SceneryInstance[]>();
    // #760 — a bank placement on one leg must not stand in another leg's lane.
    const bank = onShore(
      [...clearOfEveryLeg(left, everyLeg), ...clearOfEveryLeg(right, everyLeg)],
      (p) => [p.position[0], p.position[2]],
      (p) => footprintRadiusFor(p.id, BUILT_IN_FOOTPRINT_LOOKUP),
    );
    for (const p of [...bank, ...structures]) {
      const list = grouped.get(p.id) ?? [];
      list.push({ position: p.position, rotationY: p.rotationY, scale: p.scale });
      grouped.set(p.id, list);
    }
    sceneryGlbsResult = [...grouped.entries()].map(([id, instances]) => ({ id, instances }));
  }

  // Pick the dominant biome profile the bank pass's grass-density chunk
  // (#496) will key its density tile off. A route may cover several profiles;
  // one tile per route is good enough for the current single-mesh bank, and
  // matches the single `fallback` the pass used before this change.
  const routeProfiles = distinctProfiles(enrichment ?? null, routeTrack);
  const dominantProfile: SceneryProfile = routeProfiles[0] ?? 'fallback';

  // #493 Phase 3b — project the enrichment's lake polygons into scene XZ
  // against the route's local origin (its first coordinate), same frame
  // the water strip uses. The engine disc-clips + tessellates per-attach;
  // simplification already ran in enrichment via `lakePolygonsForTier`.
  let lakePolygons: Array<{ outer: { x: number; z: number }[]; holes: { x: number; z: number }[][] }> = [];
  const originCoord = route.coordinates && route.coordinates.length > 0 ? route.coordinates[0] : null;
  if (enrichment?.lakes?.polygons && originCoord) {
    lakePolygons = enrichment.lakes.polygons
      .map((lake) => ({
        outer: ringToSceneXZ(lake.outer, originCoord),
        holes: (lake.inner ?? []).map((hole) => ringToSceneXZ(hole, originCoord)).filter((h) => h.length >= 3),
      }))
      .filter((p) => p.outer.length >= 3);
  }

  const crossings = enrichment?.crossings;
  return {
    pools,
    ...(buildings.length > 0 ? { buildings } : {}),
    ...(sceneryGlbsResult.length > 0 ? { sceneryGlbs: sceneryGlbsResult } : {}),
    ...(curvePoints.length >= 2 ? { curvePoints } : {}),
    ...(totalDistanceMeters !== undefined ? { totalDistanceMeters } : {}),
    ...(isClosedLoop ? { isClosedLoop } : {}),
    ...(lakePolygons.length > 0 ? { lakePolygons } : {}),
    ...(crossings && crossings.length > 0 ? { crossings } : {}),
    // #741 — what the engine publishes as __ROWER3D_WATER_DETECTION.
    // #755 FR6 — with the water type and where it came from.
    waterDetectionSummary: { ...waterDetectionSummaryOf(enrichment), ...resolvedWater },
    waterEdgesForProgress,
    ...(landSide ? { landSide } : {}),
    dominantProfile,
    profileForProgress: (progress: number, side: 'left' | 'right'): SceneryProfile =>
      getSegmentSceneryProfile(layoutEnrichment, progress, routeTrack, side),
  };
};

/**
 * #729 FR3 — `toEngineRoute`, cached per (route, enrichment, tier).
 *
 * Laying a course out (foliage, reeds, rocks, landscape, kit placement) is
 * pure but not free, and the row page re-derives it whenever the selected
 * route object is replaced, even with the same course in it. A route is the
 * same when its id, length and coordinate list are; an enrichment is the
 * same object (the enrichment cache hands out one per route and version).
 * The last few layouts are kept, so switching tier and back is free too.
 */
const ENGINE_ROUTE_CACHE_SIZE = 4;
interface EngineRouteCacheEntry {
  routeId: string;
  distance: number;
  coordinates: WaterRoute['coordinates'];
  enrichment: RouteEnrichmentData | null;
  tier: PerformanceMode;
  result: EngineRoute | null;
}
const engineRouteCache: EngineRouteCacheEntry[] = [];

export const toEngineRouteCached = (
  route: WaterRoute | null | undefined,
  enrichment?: RouteEnrichmentData | null,
  tier: PerformanceMode = DEFAULT_SCENERY_TIER,
): EngineRoute | null => {
  if (!route) return null;
  const enr = enrichment ?? null;
  const hit = engineRouteCache.find(
    (e) =>
      e.routeId === route.id &&
      e.distance === route.distance &&
      e.coordinates === route.coordinates &&
      e.enrichment === enr &&
      e.tier === tier,
  );
  if (hit) return hit.result;
  const result = toEngineRoute(route, enr, tier);
  engineRouteCache.unshift({
    routeId: route.id,
    distance: route.distance,
    coordinates: route.coordinates,
    enrichment: enr,
    tier,
    result,
  });
  engineRouteCache.length = Math.min(engineRouteCache.length, ENGINE_ROUTE_CACHE_SIZE);
  return result;
};
