/**
 * Per-device scene state for the WebGPU engine. Extracted from `attach.ts`
 * so #584 FR1's device-lost reattach loop can rebuild it on a fresh device
 * without rewriting `attach`'s orchestration.
 *
 * The split: `attach` owns the canvas, telemetry, outer render loop, and
 * device session lifecycle; `createRideScene` owns everything that lives
 * on a given `GPUDevice` — textures, buffers, pipelines, pools, passes,
 * the frame graph, and the per-frame encoder. On a loss, `attach` disposes
 * the current scene and calls `createRideScene` again with the new device
 * (D1-a of #584).
 *
 * The return value is intentionally small — a `frameOnce` the outer loop
 * calls, a `dispose` that releases every GPU resource the scene owns, and
 * a few shim refs the test harness reads.
 */

/// <reference types="@webgpu/types" />

import { CAMERA_FAR_M, CAMERA_NEAR_M } from './cameraRange';
import {
  mat4,
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4FromRotationY,
  type Mat4,
} from '../math/mat4';
import { vec3 } from '../math/vec3';
import { bendSignFromTangents, createCameraRig, stepCameraRig } from './camera';
import {
  NO_INSETS,
  clearRect,
  effectiveFovY,
  projectedBounds,
  projectionWithInsets,
  type ViewportInsets,
} from '../math/projectionWithInsets';
import { createBankPass } from '../passes/bank';
import { createBoatPass } from '../passes/boat';
import { createBuildingsPass } from '../passes/buildings';
import { createCloudsPass } from '../passes/clouds';
import { boatTintFromAthlete } from './boatPaint';
import { createRainOverlayPass } from '../passes/rainOverlay';
import { createWakeParticlesPass } from '../passes/wakeParticles';
import { createWakeState, updateWake } from './wakeParticles';
import { createOarSplashPass } from '../passes/oarSplashParticles';
import { createOarSplashState, updateOarSplash } from './oarSplashParticles';
import { createSkyPass } from '../passes/sky';
import { createWaterPass } from '../passes/water';
import { createWaterPolygonPass } from '../passes/waterPolygon';
import { simplifyPolygons } from '../plan/polygonSimplify';
import { bridgeParallelLegs, islandLand } from '../plan/parallelLegs';
import { createWaterDebugPass } from '../passes/waterDebug';
import { isPolygonWaterEnabled } from './polygonWater';
import {
  clearPolygonWaterTelemetry,
  publishPolygonWaterTelemetry,
  summarisePolygonWater,
} from './polygonWaterTelemetry';
import {
  isWaterDebugEnabled,
  publishWaterDetectionSummary,
  EMPTY_WATER_DETECTION_SUMMARY,
  type WaterDetectionSummary,
} from './waterDetectionSummary';
import { createSceneryMeshPass } from '../passes/sceneryMesh';
import { revealAlpha } from '../passes/sceneryReveal';
import {
  placeFurniture,
  routeExtras,
  type Furniture,
  type FurniturePlacement,
  type SceneryModelId,
} from '../../scenery/courseFurniture';
import {
  composePlacementsForRoute,
  fetchRoutePlacementsRegistry,
} from '../../scenery/placementsForRoute';
import { synthesisePlacementsForRoute } from '../../scenery/syntheticPlacements';
import type { BridgeKind } from '../../utils/bridgeCrossings';
import type { RoutePlacementsRegistry } from '../../scenery/routePlacements';
import { createInstancePool, type InstancePool, type PoolInput } from '../plan/instancePools';
import { applyMaxBuildingsPerSegment, createBuildingPool, type BuildingPool, type BuildingSpec } from '../plan/buildings';
import { ROUTE_SEGMENT_LENGTH_METERS } from '../../services/routeEnrichmentService';
import {
  BOAT_BONE_COUNT,
  BOAT_BONE_ARMS,
  BOAT_BONE_HEAD,
  BOAT_BONE_HULL,
  BOAT_BONE_TORSO,
} from '../plan/boatMesh';
import { loadBoatMesh } from '../plan/boatMeshLoader';
import { crewStrokePose, oarSweep } from '../plan/crewStroke';
import { isFleetTintable, scullBoatTrs, scullPrimitiveTransform } from '../plan/scullInstances';
import {
  classifyCrewSlot,
  DEFAULT_CREW_PALETTE,
  flatPrimitiveColors,
  tintPrimitiveColors,
  isCrewNodeVisible,
  type CrewPalette,
  type CrewSlot,
} from '../plan/crewPalette';
import { dominantGrassProfile } from '../plan/grassDensityPlan';
import { publishBoatSource, publishFallback } from './health';
import { computeCascades, createComputedCascades } from './cascadedShadows';
import { createPlacement, placeBoat, placeGhost, strokeAmplitude } from './characterPlacement';
import { createStrokeClock, resetStrokeClock, stepStrokeClock } from './strokeClock';
import { createDistanceSmoother } from './distanceSmoother';
import { SIM_DT_CLAMP_MS, createFramePacing, recordFrameDt, summariseFramePacing } from './framePacing';
import type { RideFrame } from './rideFrame';
import { RouteCurve } from '../math/curve';
import { GHOST_LANE_OFFSET_M, gapMeters, ghostStroke } from '../../../components/rower3d/ghost';
import { GHOST_SCULL_STYLE, ghostMarker, type GhostMarker } from '../plan/ghostStyle';
import type { SceneryInstance } from '../passes/sceneryMesh';
import {
  advanceFleetInPlace,
  createFleet,
  mutableFleet,
  type MutableFleetState,
  fleetFadeFor,
  fleetHullTintFor,
  fleetMemberOnCourse,
  fleetStrokeOffset,
  fleetPaletteIndexForColor,
  fleetWaterHalfWidth,
} from './fleet';
import { DEFAULT_WATER_HALF_WIDTH_M, buildWaterStrip } from '../plan/waterStrip';
import { GLB_WATER_MARGIN_METRES, lakeWater, poolsOffWater, routeWaterFootprint, surfaceAt, withLakes } from '../plan/waterFootprint';
import { FLEET_INSTANCE_CAPACITY } from '../passes/boat';
import { assetUrl } from '../../utils/assetUrl';
import { createSceneryPass } from './sceneryPass';
import { recordClearance } from './clearance';
import { createPixelProbe } from './pixelProbe';
import { assembleRenderStats, emptyPanelStats, writePanelStats } from './frameRenderStats';
import { clearRenderStats, recordRenderStats } from '../renderStats';

/** #737 FR3 — passes whose draws `renderStats.groups` already counts one by one. */
const GROUPED_PASSES = new Set(['scenery', 'sceneryMesh', 'buildings']);
import {
  createGlbDecoderPool,
  type GlbDecoderPool,
  type GlbDecoderPoolOptions,
} from '../../scenery/glbDecoderPool';
import GlbDecodeWorker from '../../scenery/glbDecodeWorker?worker';

/**
 * Build the default scenery decoder options: a Worker factory in the browser,
 * none in SSR / jsdom tests (the pool falls back to the inline decoder).
 */
const defaultSceneryDecoderOptions = (): GlbDecoderPoolOptions => {
  if (typeof Worker === 'undefined') return {};
  return {
    workerFactory: () => new GlbDecodeWorker({ name: 'scenery-decode' }),
  };
};
import {
  createRegistrationQueue,
  planSceneryStream,
  sceneryModelsToLoad,
  streamLookaheadMeters,
  streamNeedsRecheck,
  type StreamLook,
  type CurveDistanceSample,
} from './sceneryStreamPlan';
import { FOLIAGE_SHAPES, FOLIAGE_VARIANT_COUNT } from '../../scenery/foliageTexture';
import { createFoliageAtlasPainter } from '../../scenery/foliageAtlasPaint';
import FoliageAtlasWorker from '../../scenery/foliageAtlasWorker?worker';
import { uploadFoliageAtlas } from './foliageAtlasUpload';
import { mergeSceneryInstances } from '../../scenery/mergeSceneryInstances';
import { spanCeilingAt, type SpanCeilingSource } from '../../scenery/bridgeSpan';
import { BRIDGE_SPANS } from '../../scenery/bridgeSpans.generated';
import { emptySceneryClearance, measureSceneryClearance } from './sceneryClearance';
import { backingSizeFor, backingSizeForObserved, observeCanvasSize, type ObservedCanvasSize } from './surface';
import { loadFloraAtlas } from './textureLoader';
import { mipLevelCountFor, textureBytes } from './textures';
import { createFrameGraph, type FrameGraph, type FrameUniforms, type Pass } from './frameGraph';
import { createGpuFrameTimer } from './gpuFrameTimer';
import { createShadowAtlas } from './shadowAtlas';
import { shadowConfigFor } from './shadowConfig';
import { shaderGrassStrengthFor } from './shaderGrass';
import type { PerformanceMode } from '../../scenery/sceneryPlacement';
import type { SceneryProfile } from '../../services/routeEnrichmentService';
import { createShadowStage, type ShadowTelemetry } from './shadowStage';
import { measureAttachAsync } from './attachMeasure';
import { chromaticAberrationEnabled, tierCapsFor } from './tierCaps';
import { publishSpeedMps, type TelemetryHandles } from './telemetry';
import { createPostFx, type PostFxCaps } from './postFx';
import {
  conditionsToFrameLighting,
  isLightingConditions,
  type FrameLighting,
  type LightingConditions,
} from '../plan/conditionsLighting';
import {
  createFrameUniformBuffer,
  createShadowUniformBuffer,
  createSproutUniformBuffer,
  fogDistanceScaleFor,
  FRAME_UNIFORMS_FLOATS,
  packFrameUniforms,
  createLightingUniformBuffer,
  packFrameLighting,
  packShadowUniforms,
  packSproutUniforms,
  sproutWindowFor,
  type ShadowUniformsCpu,
} from './uniforms';


/**
 * A scenery route shape the engine understands: the UI-side `route` is
 * `unknown` at the seam (per the agreement with the UI thread). When a route
 * is a `SceneryRoute`, the engine builds pools from `pools`; anything else
 * mounts an empty scenery pass.
 */
export interface SceneryRoute {
  pools: PoolInput[];
  /**
   * Extruded OSM building footprints to draw as prisms (#566 FR1). Absent
   * on a route with no mapped buildings — the engine then skips the
   * `BuildingsPass` and leaves the sky + clouds + scenery as the only
   * horizon. The engine does not call back into enrichment itself; the
   * UI shell is expected to extrude footprints before passing the route
   * (D1-b).
   */
  buildings?: BuildingSpec[];
  /**
   * Points of the route curve in world space (#570 D6). Absent on the
   * smoke pages — the engine falls back to a short straight-line curve so
   * the boat still has a route to run on.
   */
  curvePoints?: readonly [number, number, number][];
  /** Metres represented by the full curve (defaults to the chord length). */
  totalDistanceMeters?: number;
  /**
   * Loop routes wrap at the ends rather than mirroring virtual endpoints;
   * omitted or false means an open route. Mirrors `createRouteCurve`'s
   * closed-loop detection in the React scene (`src/components/rower3d/curve.ts`).
   */
  isClosedLoop?: boolean;
  /**
   * GLB scenery (bank-edge, scatter, buildings, trees, landform, backdrop,
   * course furniture, bridges, landmarks) — one group per model id, with
   * per-instance world-space transforms. The adapter computes the layout;
   * attach loads each referenced GLB and feeds instances into the registry.
   */
  sceneryGlbs?: Array<{
    id: string;
    instances: Array<{ position: [number, number, number]; rotationY: number; scale: number }>;
  }>;
  /**
   * Lake/open-water polygons in scene XZ (#493 Phase 3b). Omitted on
   * river routes and on routes where the polygon-water flag is off.
   * Each polygon's outer ring and islands are already projected via
   * `ringToSceneXZ` against the route's local origin; the engine
   * tessellates and disc-clips at attach time.
   */
  lakePolygons?: Array<{ outer: { x: number; z: number }[]; holes: { x: number; z: number }[][] }>;
  /**
   * #685 wire-up — OSM bridge crossings along the route (progress + kind).
   * Already computed by the enrichment service; the synthetic placement
   * generator (#691) turns each into a tier-c bridge at the river centre.
   */
  crossings?: readonly { readonly progress: number; readonly kind: string }[];
  /**
   * On-land route samples in scene XZ (#493 Phase 3d / FR22). Drawn by
   * the diagnostics overlay as plus-sign markers when the water-debug
   * flag is on. Omitted when the route is fully on water or when the
   * flag is off.
   */
  onLandSamples?: Array<{ x: number; z: number }>;
  /** Detection summary for the debug HUD (#493 Phase 3d / AC23). */
  waterDetectionSummary?: WaterDetectionSummary;
  /**
   * Per-progress shore widths (scene units) so the water strip bends with
   * the OSM-measured river. Called once per vertex column at build time, not
   * per frame. Omitted → symmetric `WATER_CHANNEL_HALF_WIDTH`.
   */
  waterEdgesForProgress?: (progress: number) => { left: number; right: number };
  /**
   * Dominant biome profile along the route — the bank pass's grass-density
   * tile (#496 Phase 2) is baked from this. One profile per route for now;
   * per-segment banks are a follow-up.
   */
  dominantProfile?: string;
}

export const isSceneryRoute = (route: unknown): route is SceneryRoute =>
  !!route && typeof route === 'object' && Array.isArray((route as SceneryRoute).pools);

export interface RideSceneOpts {
  tier?: string;
  /**
   * #591-fu P2c: a separate "view distance" tier that caps LOD / fog /
   * sprout window / scenery stream look-ahead independently of the main
   * quality tier. Omitted falls back to `tier` so a single-tier caller
   * keeps the pre-split behaviour.
   */
  distanceTier?: string;
  route?: unknown;
  /** #690 — engine route id. See RideAttachOpts.routeId for the story. */
  routeId?: string;
  getFrame?: () => RideFrame;
  crew?: 'male' | 'female';
  /** #571 — stable athlete identifier. When supplied, drives the shell
   *  paint tint via `boatPaint.boatTintFromAthlete`. Omitted / empty =
   *  the pre-#571 off-white default. */
  athleteId?: string;
  /**
   * #578 FR2 / FR5 — initial per-athlete clothing/hair/hat palette.
   * Omitted = `DEFAULT_CREW_PALETTE` (the baked look). Updates mid-ride
   * come through `RideSceneHandle.setAppearance`.
   */
  appearance?: CrewPalette;
  /**
   * #730 VP-12 — the rower's resolved conditions (Dawn / Midday / Golden
   * hour / Overcast / Dusk). Omitted or unknown = the engine default, which
   * is today's Midday frame. Live changes come through `setConditions`.
   */
  conditions?: LightingConditions;
  /**
   * #733 VP-15 — CSS px the HUD covers along each canvas edge. The camera
   * frames the boat in the clear part. Omitted = none (today's framing).
   * Live changes come through `setViewportInsets`.
   */
  viewportInsets?: ViewportInsets;
  /**
   * #728 VP-10 FR2 — where to draw the race ghost's marker, called when it
   * moves (to the whole CSS px) and with null when it should hide: the
   * ghost is within 30 m, off screen, or gone.
   */
  onGhostMarker?: (marker: GhostMarker | null) => void;
  /**
   * #726 VP-08 FR1 — called once per load phase as it settles, so the
   * host's loading bar shows real progress. `frame` comes last: the first
   * frame is drawn only after the scenery near the start is in.
   */
  onLoadPhase?: (phase: EngineLoadPhase, status: 'done' | 'failed') => void;
  /**
   * #623 Phase 1 — the attach test harness (`attach({testMode: true})`)
   * sets this so the SSR/test boat fallback keeps working: a mocked
   * canvas cannot fetch `shell.bin`, so without this flag the user-
   * facing path (D4-a) would throw `renderer-unavailable` and every
   * test would need to stub the fetch. Default false; production
   * attach never sets it.
   */
  testMode?: boolean;
  /**
   * Override the Worker-backed scenery decoder (`glbDecoderPool`). Omitted,
   * the scene builds a pool that off-loads fetch + GLB decode + primitive
   * merge from the main thread, falling back to an inline decoder in SSR
   * and jsdom tests. Tests and benchmarks can inject a stub to decode
   * synchronously on the current thread.
   */
  glbDecoderPool?: GlbDecoderPoolOptions;
}

export interface RideSceneHandle {
  readonly device: GPUDevice;
  /** Draw one frame. The outer rAF loop (or the test harness) calls this. */
  frameOnce(): void;
  /**
   * Update the per-athlete rower palette and re-tint the scull primitives
   * on the next frame (#578 FR5). No reattach; no extra draw calls — the
   * seam is a `queue.writeBuffer` per recoloured primitive. A primitive
   * whose GLB node name does not match a slot (hull, oar) is left alone.
   */
  setAppearance(palette: CrewPalette): void;
  /**
   * #730 VP-12 — relight the running scene for new conditions. Writes the
   * lighting uniforms, the sun direction (which the shadow cascades follow)
   * and the fog; the next frame shows it. No device or scene rebuild. An
   * unknown value is ignored.
   */
  setConditions(conditions: unknown): void;
  /** #733 VP-15 — the HUD's covered area changed; reframe on the next frame. */
  setViewportInsets(insets: unknown): void;
  /**
   * #737 VP-19 FR6 — the page is visible again after being hidden. The next
   * frame restarts the simulation clocks (stroke, wake, fleet, distance
   * smoothing) from where the row is now instead of fast-forwarding them
   * over the hidden time.
   */
  resume(): void;
  /**
   * Release every GPU resource this scene owns, including the device
   * session that owns the `GPUDevice`. Safe to call more than once.
   */
  dispose(): void;
}

/**
 * #733 VP-15 — points on the player boat, in scull space (bow +Z, metres):
 * bow and stern, both blade tips at the catch and the finish, and the
 * rower's head. `__ROWER3D_BOAT.screenBounds` is the box around them.
 */
const BOAT_FOOTPRINT: readonly (readonly [number, number, number])[] = [
  [0, 0, 4.1],
  [0, 0, -4.1],
  [2.9, 0, 1.4],
  [-2.9, 0, 1.4],
  [2.9, 0, -1.4],
  [-2.9, 0, -1.4],
  [0, 1.15, 0],
];

const sanitiseInsets = (v: unknown): ViewportInsets => {
  if (!v || typeof v !== 'object') return NO_INSETS;
  const o = v as Record<string, unknown>;
  const n = (k: string): number => {
    const x = o[k];
    return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
  };
  return { top: n('top'), right: n('right'), bottom: n('bottom'), left: n('left') };
};

/** Internal clock used by the test harness. */
const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Build the per-device scene on `device` and configure `canvas` to render
 * it. The scene writes its frame stats into `telemetry` as it draws; the
 * outer `attach` reads those from `__ROWER3D_*` globals the same handles
 * were published under.
 *
 * `canvas` is reused across device swaps (D1-a of #584); the engine
 * reconfigures its `GPUCanvasContext` for the new device each time.
 */
/** #726 FR1 — what the engine waits on before the ride is drawn. */
export type EngineLoadPhase = 'scene' | 'boat' | 'crew' | 'atlas' | 'scenery-near' | 'frame';

/**
 * #726 FR1 — how long the start waits for the scenery near it. A model that
 * is still loading after this streams in later with the FR3 fade, so a slow
 * network costs a fade, not a stuck loading bar.
 */
/**
 * #736 — set a fleet instance's tint in its own tuple. Fleet instances only
 * ever hold tuples made here, so the one they have is safe to rewrite.
 */
const writeTint = (
  current: readonly [number, number, number, number] | undefined,
  r: number,
  g: number,
  b: number,
): [number, number, number, number] => {
  const t = (current ?? [0, 0, 0, 1]) as [number, number, number, number];
  t[0] = r;
  t[1] = g;
  t[2] = b;
  t[3] = 1;
  return t;
};

const emptyRideFrame = (): RideFrame => ({
  paceSPer500: 0,
  distanceMeters: 0,
  cadence: 0,
  isPlaying: false,
  holdBoat: false,
  finished: false,
  intensityFactor: 0,
  elapsedSeconds: 0,
  ghost: null,
});

/** #736 — copy every RideFrame field into `dst`, so a scratch frame can stand in for a spread. */
const copyRideFrame = (dst: RideFrame, src: RideFrame): RideFrame => {
  dst.paceSPer500 = src.paceSPer500;
  dst.distanceMeters = src.distanceMeters;
  dst.cadence = src.cadence;
  dst.isPlaying = src.isPlaying;
  dst.holdBoat = src.holdBoat;
  dst.finished = src.finished;
  dst.intensityFactor = src.intensityFactor;
  dst.elapsedSeconds = src.elapsedSeconds;
  dst.ghost = src.ghost;
  dst.view = src.view;
  dst.loop = src.loop;
  return dst;
};

export const START_SCENERY_TIMEOUT_MS = 20_000;

export const createRideScene = async (
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  telemetry: TelemetryHandles,
  opts: RideSceneOpts,
  session: { dispose(): void },
): Promise<RideSceneHandle | null> => {
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  if (!context) {
    telemetry.contextState.kind = 'unavailable';
    telemetry.contextState.reason = 'webgpu-unsupported';
    telemetry.contextState.backend = 'none';
    session.dispose();
    return null;
  }

  const outputFormat: GPUTextureFormat =
    (navigator as unknown as { gpu?: GPU }).gpu?.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
  // #807 — in test mode the presented frame can be copied out, so specs read
  // pixels from the GPU rather than through a 2-D canvas copy.
  context.configure({
    device,
    format: outputFormat,
    alphaMode: 'opaque',
    ...(opts.testMode ? { usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC } : {}),
  });
  const pixelProbe = opts.testMode ? createPixelProbe(device) : null;
  // #573 P8 — the lit passes render into an HDR offscreen target; PostFxPass
  // composites to the real swap-chain. The `format` prop every lit pass takes
  // is this HDR format; `outputFormat` is only used by the composite + DOF
  // target configs inside PostFxPass.
  const format: GPUTextureFormat = 'rgba16float';

  // #731 VP-13 — `width`/`height` are the canvas's CSS size (camera framing,
  // HUD insets, screen-space telemetry); `pixelWidth`/`pixelHeight` are its
  // backing store, CSS size x the tier-capped device pixel ratio, which the
  // render targets and the frame graph use.
  const surfaceCaps = tierCapsFor(opts.tier);
  let observedSize: ObservedCanvasSize | null = null;
  const stopObserving = observeCanvasSize(canvas, (size) => {
    observedSize = size;
  });
  const devicePixelRatioNow = (): number => {
    const r = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : 1;
  };
  let width = Math.max(1, Math.floor(canvas.clientWidth || canvas.width || 320));
  let height = Math.max(1, Math.floor(canvas.clientHeight || canvas.height || 240));
  const initialBacking = backingSizeFor(width, height, devicePixelRatioNow(), surfaceCaps);
  let pixelWidth = initialBacking.width;
  let pixelHeight = initialBacking.height;
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;

  // Scene HDR colour target (#573 FR1 / D1-a).
  let sceneTexture = device.createTexture({
    label: 'scene-hdr',
    size: { width: pixelWidth, height: pixelHeight },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  // Depth is `depth32float` from P8 so SSAO + DOF can sample it (#573 FR9).
  let depthTexture = device.createTexture({
    label: 'depth',
    size: { width: pixelWidth, height: pixelHeight },
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  const frameUniforms = createFrameUniformBuffer(device);
  const lightingUniforms = createLightingUniformBuffer(device);
  const uniformScratch = new Float32Array(FRAME_UNIFORMS_FLOATS);

  // #559 P4: shadow atlas + per-tier cascade config. Default tier is medium
  // (3 cascades @ 1024). `setTier` is a later-phase ask (#559 FR8); for P2
  // we size on attach from opts.tier.
  const shadowCfg = shadowConfigFor(opts.tier);
  const atlas = createShadowAtlas(device, shadowCfg.atlasSize, shadowCfg.cascades);
  telemetry.shadows.atlasSize = atlas.tileSize;
  telemetry.shadows.cascades = atlas.cascades;
  telemetry.shadows.atlasBytes = atlas.bytes;

  const shadowUniformsBuf = createShadowUniformBuffer(device);
  const shadowScratch = new Float32Array(80);
  const shadowCpu: ShadowUniformsCpu = {
    cascadeViewProj: [mat4(), mat4(), mat4(), mat4()],
    cascadeSplits: new Float32Array(4),
    cascadeRadius: new Float32Array(4),
    cascadeBlendStartRatio: 0.1,
    cascadeCount: atlas.cascades,
    tileSize: atlas.tileSize,
    atlasWidth: atlas.width,
  };
  const shadowCmpSampler = device.createSampler({
    label: 'shadow-cmp',
    compare: 'less-equal',
    magFilter: 'linear',
    minFilter: 'linear',
  });

  // Sprout fade uniform (#562 FR6 / D6-b). The window metres are per-tier
  // and read from the DISTANCE tier when the caller split the two axes
  // (#591-fu P2c); falls back to the main tier otherwise.
  const sproutUniforms = createSproutUniformBuffer(device);
  const sproutScratch = new Float32Array(4);
  const sprout = sproutWindowFor(opts.distanceTier ?? opts.tier);
  packSproutUniforms(sprout.near, sprout.far, sproutScratch);
  device.queue.writeBuffer(sproutUniforms, 0, sproutScratch as BufferSource);

  // Build the water/bank curve + edges fn FIRST so every geometry pass
  // that follows the river (water strip, bank strips lit + depth, boat
  // placement, course furniture, camera) can share one spline.
  const fallbackCurveSource: Array<[number, number, number]> = [[0, 0, 0], [0, 0, -200]];
  const waterCurveSource = isSceneryRoute(opts.route) && opts.route.curvePoints && opts.route.curvePoints.length >= 2
    ? opts.route.curvePoints
    : fallbackCurveSource;
  const waterCurve = new RouteCurve(
    waterCurveSource.map(([x, y, z]) => vec3(x, y, z)),
    isSceneryRoute(opts.route) ? !!opts.route.isClosedLoop : false,
  );
  const waterEdgesForProgress = isSceneryRoute(opts.route) ? opts.route.waterEdgesForProgress : undefined;
  // #742 VP-22 FR2 — the water and bank strips close the gap between legs
  // that run beside each other. Fleet lanes and course furniture keep the
  // measured shores (`waterEdgesForProgress`).
  const parallelLegs = bridgeParallelLegs(waterCurve, waterEdgesForProgress, {
    isLand: islandLand(isSceneryRoute(opts.route) ? opts.route.lakePolygons : undefined),
  });
  const stripEdgesForProgress = parallelLegs.edgesForProgress;
  const tierCaps = tierCapsFor(opts.tier);
  const polygonLakesRaw =
    isSceneryRoute(opts.route) && opts.route.lakePolygons ? opts.route.lakePolygons : [];
  // #493 Phase 5 / FR9 / AC7 — decimate each outer ring to the tier's
  // vertex budget before the pass tessellates. Deterministic + area-
  // preserving (polygonSimplify.ts); a ring already under the cap is
  // returned by reference, so a small lake pays nothing.
  const polygonLakes = simplifyPolygons(polygonLakesRaw, tierCaps.polygonWaterMaxVertices);
  const useLakePolygonWater = isPolygonWaterEnabled() && polygonLakes.length > 0;
  // #742 FR3 — the whole route's water: scenery and bank furniture
  // standing on any part of it are taken out.
  // A smoke page with no route lays its scenery out around the fallback
  // ribbon: nothing is taken out there.
  const hasRouteCurve = waterCurveSource !== fallbackCurveSource;
  const routeWater = routeWaterFootprint(buildWaterStrip(waterCurve, { edgesForProgress: stripEdgesForProgress }));
  const rejectOnWater = hasRouteCurve ? routeWater : { contains: () => false };
  // #742 FR5 — where the lake polygons are drawn, the banks laid along the
  // racing line give way to them: the lake's own shore is the bank.
  const bankFootprint = useLakePolygonWater ? withLakes(routeWater, polygonLakes) : routeWater;
  const surfaceLakes = lakeWater(isSceneryRoute(opts.route) ? opts.route.lakePolygons ?? [] : []);
  let rejectedOnWater = 0;

  // D7-a of #555: wire the scenery pass unconditionally.
  const offWater = poolsOffWater(isSceneryRoute(opts.route) ? opts.route.pools : [], rejectOnWater);
  rejectedOnWater += offWater.rejected;
  const sceneryPoolInputs: PoolInput[] = offWater.pools;
  // Scenery pool telemetry starts fresh on each scene build so a reattach
  // doesn't double-count pools from the dead device.
  telemetry.scenery.pools = [];
  telemetry.scenery.registered = 0;
  telemetry.scenery.failed = 0;
  telemetry.scenery.failedIds = [];
  telemetry.scenery.frame = 0;
  telemetry.scenery.reveals = [];
  telemetry.scenery.nearStartIds = [];
  telemetry.scenery.registeredAtFirstFrame = null;
  const scenePools: InstancePool[] = sceneryPoolInputs.map((input) => createInstancePool(device, input));

  // #566 P6 — buildings pool. Per D5-b we skip the pool entirely when the
  // route carries no `buildings`, which is what happens for a fallback
  // enrichment. Tier gates then decide whether to build the pass + cast
  // shadows (D8).
  const rawBuildingSpecs: BuildingSpec[] =
    tierCaps.drawBuildings && isSceneryRoute(opts.route) && opts.route.buildings
      ? opts.route.buildings
      : [];
  // #712 FR6 — cap building count per route segment so a dense `small-city`
  // profile can't blow FR10 gpuMs on a lower tier. The cap is a soft budget,
  // not a geographic rule: LOD distance work (#497) still clips far-field
  // count on top. `maxBuildingsPerSegment <= 0` yields an empty list, matching
  // the basic tier's `drawBuildings: false` primary gate.
  const buildingSpecs = applyMaxBuildingsPerSegment(
    rawBuildingSpecs,
    tierCaps.maxBuildingsPerSegment,
    ROUTE_SEGMENT_LENGTH_METERS,
  );
  const buildingsPool: BuildingPool | null = buildingSpecs.length > 0
    ? createBuildingPool(device, buildingSpecs)
    : null;
  const buildingsCastingPool = tierCaps.castBuildingShadows ? buildingsPool : null;
  telemetry.buildings.routes = buildingsPool ? 1 : 0;
  telemetry.buildings.pool = buildingsPool?.instanceCount ?? 0;
  telemetry.buildings.footprintM2 = buildingsPool?.footprintM2 ?? 0;
  telemetry.buildings.resident = !!buildingsPool;
  telemetry.buildings.cast = !!buildingsCastingPool;
  // Per-species leaf atlas (#549 slice 3; #686 D1c grew it to
  // `species × variantCount` layers). Each layer is a 256×256 RGBA
  // billboard. Layout: layer `s * FOLIAGE_VARIANT_COUNT + v` carries
  // species `s`, variant `v`. The fragment shader picks the variant
  // from the per-instance seed so two neighbouring broadleaves read as
  // "the same species, different tree" instead of the same card.
  const foliageAtlasSize = 256;
  const foliageAtlasLayers = FOLIAGE_SHAPES.length * FOLIAGE_VARIANT_COUNT;
  // #719 VP-01 FR3 — full mip chain so the sprite sampler's linear
  // mipmapFilter doesn't fall back to the top level at distance and
  // alias against the painted leaf-texture grain.
  const foliageAtlasMips = mipLevelCountFor(foliageAtlasSize, foliageAtlasSize);
  const foliageAtlasTex = device.createTexture({
    label: 'foliage-atlas',
    size: { width: foliageAtlasSize, height: foliageAtlasSize, depthOrArrayLayers: foliageAtlasLayers },
    format: 'rgba8unorm-srgb',
    mipLevelCount: foliageAtlasMips,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // #729 FR2 — painted in a worker (inline under SSR / jsdom) while the
  // boat and the crew load, then uploaded in one write per mip level.
  // Awaited before the passes are built, below. Timed as `vr:attach:atlas`.
  const foliagePainter = createFoliageAtlasPainter(
    typeof Worker === 'undefined' ? {} : { workerFactory: () => new FoliageAtlasWorker({ name: 'foliage-atlas' }) },
  );
  // A queue without writeTexture (the attach-test mock) gets no upload, so
  // there is nothing to paint either.
  const foliageAtlasReady =
    typeof device.queue.writeTexture === 'function'
      ? measureAttachAsync('atlas', async () => {
          const atlas = await foliagePainter.paint(foliageAtlasSize);
          uploadFoliageAtlas(device.queue, foliageAtlasTex, atlas);
        }).finally(() => foliagePainter.dispose())
      : Promise.resolve();
  const foliageAtlasView = foliageAtlasTex.createView({ dimension: '2d-array' });
  const foliageSampler = device.createSampler({
    label: 'foliage',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // #623 Phase 1 — the solid-flora stage (procedural low-poly tree pool)
  // is retired. Near-camera trees now draw from the tier-E GLB kit via
  // `sceneryMeshPass`, enabled on every tier that renders trees (basic
  // and low included). `sproutUniforms` still drives the sprite fade in
  // the scenery sprite pass; no replacement for the solid near-pool
  // fade-out is wired — distance culling removes the GLBs beyond
  // `sceneryMeshPass`'s view distance.
  for (const pool of scenePools) {
    telemetry.scenery.pools.push({
      kind: pool.kind,
      speciesIndex: pool.speciesIndex,
      chunkIndex: pool.chunkIndex,
      instanceCount: pool.instanceCount,
      drawn: -1,
    });
  }

  // #570 P7 D1-b + #623 Phase 1 D4-a — prefer the baked `shell.bin`
  // buffer from `scripts/build-boat-mesh.mjs`. The procedural generator
  // in `boatMesh.ts` is retained ONLY for SSR + unit tests; a
  // user-facing load failure publishes `renderer-unavailable` and
  // throws instead of silently drawing the procedural hull. Telemetry
  // carries which path won on `__ROWER3D_BOAT.meshSource` and the
  // webgpu-health global reports `boatSource` for the DebugPanel.
  const boatMeshHandle = await loadBoatMesh({
    url: assetUrl('/assets/boat/shell.bin'),
    allowProceduralFallback: opts.testMode === true,
  });
  if (!boatMeshHandle.mesh) {
    telemetry.boat.meshSource = 'failed';
    publishBoatSource('failed');
    publishFallback('renderer-unavailable');
    throw new Error(
      'boat mesh load failed (shell.bin unreachable or malformed); surfacing renderer-unavailable',
    );
  }
  const boatMesh = boatMeshHandle.mesh;
  telemetry.boat.meshSource = boatMeshHandle.source;
  publishBoatSource(boatMeshHandle.source === 'baked' ? 'baked' : 'failed');
  opts.onLoadPhase?.('boat', 'done');
  const charactersMesh = tierCaps.castCharacterShadows ? boatMesh : null;

  // Scenery-mesh pass. Loads the course-furniture GLBs and keeps a registry
  // keyed by `SceneryModelId`; `placeFurniture` (called below once the route
  // curve is known) feeds the per-instance mat4 buffers each attach. The
  // same pass also hosts the per-frame boat GLB — scull.glb has 19 primitives
  // with distinct materials (hull vs rower vs oars), each registered as its
  // own mesh id so the per-primitive base colours survive.
  // #803 — every pass builds its pipelines with create*PipelineAsync so
  // Chrome compiles them off the GPU process's main thread, in parallel,
  // and the ride only reports ready once they are all compiled. The
  // passes are therefore created together and awaited as one batch.
  await foliageAtlasReady;
  const [sceneryPass, boatPass, sceneryMeshPass] = await measureAttachAsync('pipelines', () => Promise.all([
    createSceneryPass({
      device,
      format,
      frameUniforms,
      sproutUniforms,
      pools: scenePools,
      telemetry: telemetry.scenery,
      foliageAtlasView,
      foliageSampler,
    }),
    createBoatPass({ device, format, frameUniforms, mesh: boatMesh }),
    // #734 FR4 — kit scenery and the scull receive shadows wherever the
    // kit casts them (medium and up); basic/low draw as before.
    createSceneryMeshPass({ device, format, frameUniforms, receiveShadows: tierCaps.castSceneryShadows }),
  ]));
  const BOAT_SCULL_PREFIX = 'boat-scull';
  /**
   * #728 FR1 / #713 D1a — instances of each scull primitive: the player,
   * the ghost, then up to one per fleet member.
   */
  const SCULL_INSTANCES = 2 + (tierCaps.fleetCount > 0 ? FLEET_INSTANCE_CAPACITY : 0);
  /** #713 D2a — the other crew's scull, drawn only for fleet members. */
  const BOAT_SCULL_ALT_PREFIX = 'boat-scull-alt';
  const boatScullMeshIds: string[] = [];
  interface BoatScullPrimitive {
    id: string;
    nodeWorld: Mat4;
    group?: string;
    pivotWorld?: Mat4;
    /**
     * The appearance slot this primitive paints into (#578 FR2),
     * resolved from `prim.groupName` via `classifyCrewSlot`. `undefined`
     * for primitives outside the picker (hull, oar) — those keep their
     * authored colours regardless of palette.
     */
    slot?: CrewSlot;
    /** GLB node name; decides hairstyle / hat sibling visibility (#672). */
    nodeName?: string;
    /**
     * Snapshot of the authored per-vertex RGBA (or a flat buffer when
     * the GLB only shipped a scalar `baseColor`), kept so the alpha
     * channel survives a re-tint and so a reset-to-default is one
     * writeBuffer away.
     */
    authoredColors?: Float32Array;
    /** #736 FR4 — drawn for the player's palette; recomputed when it changes. */
    visible: boolean;
    /** #736 FR4 — drawn for the fleet, which always wears the default palette. */
    fleetVisible: boolean;
    /** #736 — this frame's instances, and the records they are built from, kept across frames. */
    instances: SceneryInstance[];
    player: Mat4;
    ghost: ScullInstance;
    fleet: ScullInstance[];
  }
  /** #736 — a styled scull instance rewritten in place each frame. */
  interface ScullInstance {
    model: Mat4;
    tint: [number, number, number, number] | readonly [number, number, number, number] | undefined;
    alpha: number;
    rim: number;
    flat: number;
    haze: number;
  }
  const scullInstance = (): ScullInstance => ({ model: mat4(), tint: undefined, alpha: 1, rim: 0, flat: 0, haze: 1 });
  const boatScullPrimitives: BoatScullPrimitive[] = [];
  const boatScullAltPrimitives: BoatScullPrimitive[] = [];
  let currentAppearance: CrewPalette = opts.appearance ?? DEFAULT_CREW_PALETTE;
  const COURSE_FURNITURE_MODELS: SceneryModelId[] = [
    'a01-buoy-lane-sphere',
    'a06-finish-tower',
    'a07-distance-marker-post',
    // #685 slice 1 — start / finish line flagpoles. The GLB already ships
    // in `public/assets/scenery/tier-a/a12-regatta-flagpole.glb`; one
    // registration here lets `placeFurniture` emit instances that the
    // sceneryMeshPass picks up through the same path as the buoys.
    'a12-regatta-flagpole',
    // #690 — hand-authored per-route additions (Willowbrook etc.).
    'a03-pontoon-floating-dock',
    'a09-gazebo-hexagonal',
    'b01-boathouse-new-england',
    'b03-clubhouse-modern',
    'c01-bridge-arch-masonry',
    // #685 wire-up — every tier-c bridge model the synthetic generator
    // may emit for an OSM crossing. Routes with no crossings produce
    // zero instances; a route with a `rail` crossing emits an instance
    // of c04, and so on. Registering all of them up front lets the
    // streaming controller load them lazily as they come into range.
    'c02-bridge-road-concrete',
    'c03-bridge-truss-steel',
    'c04-bridge-rail-girder',
    'c05-bridge-bascule',
    'c06-bridge-foot-suspension',
    'c07-bridge-dutch-lift',
    'c08-bridge-cantilever',
  ];
  const sceneryGlbList = isSceneryRoute(opts.route) ? opts.route.sceneryGlbs ?? [] : [];
  const COURSE_FURNITURE_MAX_INSTANCES = 1024;
  const tierFolderFor = (id: string): string => {
    const prefix = id[0]?.toLowerCase() ?? 'a';
    const tier = 'abcdefgl'.includes(prefix) ? prefix : 'a';
    return `tier-${tier}`;
  };
  // The fetch + GLB decode + primitive merge all run off-thread in a Worker
  // pool so the main thread only pays for the final GPU buffer upload. On a
  // tier-E tree the decode step was taking long enough to drop a frame each
  // time new chunks streamed in; moving it to a worker removes that hitch.
  // In SSR and jsdom tests the pool falls back to an inline decode, so the
  // renderer behaves exactly as before where `Worker` is not available.
  const decoderPool: GlbDecoderPool = createGlbDecoderPool(
    opts.glbDecoderPool ?? defaultSceneryDecoderOptions(),
  );

  /**
   * Load one crew's scull GLB and register each primitive as a mesh id
   * under `prefix`. `paint` applies the player's palette to the crew
   * slots; the fleet's other-crew scull keeps its authored colours.
   */
  const loadScull = async (
    crewName: 'male' | 'female',
    prefix: string,
    out: BoatScullPrimitive[],
    paint: boolean,
  ): Promise<void> => {
  try {
    const crewGlb = crewName === 'female' ? 'scull-female.glb' : 'scull-male.glb';
    // #729 FR4 — fetched and decoded in the decoder pool's worker, like the
    // scenery kit, so the main thread only registers the buffers.
    {
      const model = await decoderPool.decodeModel(assetUrl(`/assets/boat/${crewGlb}`), {
        preserveNodeTransforms: true,
      });
      // #736 — every primitive of this scull shares one instance buffer, so
      // a frame uploads the whole boat (player, ghost, fleet) in one write.
      sceneryMeshPass.reserveInstanceGroup(prefix, model.primitives.length, SCULL_INSTANCES);
      for (let i = 0; i < model.primitives.length; i += 1) {
        const prim = model.primitives[i];
        const id = `${prefix}:${i}`;
        // Each primitive is one GLB material = one picker slot (or none).
        // Prefer the leaf node name (e.g. `Torso_Spine_part`) and fall back
        // to the articulated group (`LeftOar`) when the loader only kept
        // the latter.
        const slotKey = prim.nodeName ?? prim.groupName;
        const slot = slotKey ? classifyCrewSlot(slotKey) : undefined;
        // GLB primitives today ship one scalar baseColor per primitive; the
        // engine fans that out to one flat per-vertex buffer below so a
        // palette change can rewrite the same bytes. Cached so a reset to
        // default is one writeBuffer with no second GLB fetch.
        const vertexCount = prim.positions.length / 3;
        const authoredColors = new Float32Array(vertexCount * 4);
        {
          const [r, g, b, a] = prim.baseColor;
          for (let v = 0; v < vertexCount; v += 1) {
            authoredColors[v * 4] = r;
            authoredColors[v * 4 + 1] = g;
            authoredColors[v * 4 + 2] = b;
            authoredColors[v * 4 + 3] = a;
          }
        }
        // Apply the initial appearance up-front so attach(..., { appearance })
        // skips a first-frame flash of the baked colour.
        const initialColors = slot && paint
          ? tintPrimitiveColors(authoredColors, slot, currentAppearance)
          : authoredColors;
        sceneryMeshPass.register({
          id,
          positions: prim.positions,
          normals: prim.normals,
          indices: prim.indices,
          baseColor: prim.baseColor,
          colors: initialColors,
          // #728 FR1 / #713: the player, the race ghost, the fleet.
          maxInstances: SCULL_INSTANCES,
          instanceGroup: { name: prefix, index: i },
        });
        if (paint) boatScullMeshIds.push(id);
        const nodeWorld = mat4();
        if (prim.nodeWorldMatrix) {
          for (let k = 0; k < 16; k += 1) nodeWorld[k] = prim.nodeWorldMatrix[k];
        } else {
          mat4Identity(nodeWorld);
        }
        let pivotWorld: Mat4 | undefined;
        if (prim.pivotWorldMatrix) {
          pivotWorld = mat4();
          for (let k = 0; k < 16; k += 1) pivotWorld[k] = prim.pivotWorldMatrix[k];
        }
        out.push({
          id,
          nodeWorld,
          group: prim.groupName,
          pivotWorld,
          slot,
          nodeName: slotKey,
          authoredColors,
          visible: isCrewNodeVisible(slotKey, currentAppearance),
          fleetVisible: isCrewNodeVisible(slotKey, DEFAULT_CREW_PALETTE),
          instances: [],
          player: mat4(),
          ghost: scullInstance(),
          fleet: [],
        });
      }
    }
  } catch { /* scull GLB load failed — the old baked boat remains as fallback */ }
  };
  const playerCrew: 'male' | 'female' = opts.crew === 'female' ? 'female' : 'male';
  await measureAttachAsync('crew', () => loadScull(playerCrew, BOAT_SCULL_PREFIX, boatScullPrimitives, true));
  // #713 D2a — the fleet rows both crews; the player's is already loaded.
  if (tierCaps.fleetCount > 0 && boatScullPrimitives.length > 0) {
    await loadScull(playerCrew === 'male' ? 'female' : 'male', BOAT_SCULL_ALT_PREFIX, boatScullAltPrimitives, false);
  }
  opts.onLoadPhase?.('crew', boatScullPrimitives.length > 0 ? 'done' : 'failed');

  // Scenery GLBs load lazily as the route progresses (see sceneryStreamPlan):
  // this fetches + registers one model on demand, returning whether it
  // registered. The streaming controller built after placement drives it from
  // the boat's distance, so distant scenery isn't fetched until the boat nears
  // it — no up-front burst that blocks the first frame or trips a host 503.
  //
  // #688 — the sceneryMeshPass's shadow-depth loop iterates every
  // registered mesh with instances; small props (buoys, flagpoles,
  // distance markers, bank railings) drop tiny, invisible-at-tier shadows
  // whose depth raster outweighs the visual benefit. Flag them here so
  // the pass skips them in `forEachActiveShadowCaster` while still
  // drawing them in the lit colour pass.
  const SHADOW_NEUTRAL_MODEL_IDS = new Set<string>([
    'a01-buoy-lane-sphere',
    'a02-buoy-turn-cylinder',
    'a07-distance-marker-post',
    'a11-bank-railing',
    'a12-regatta-flagpole',
  ]);
  type DecodedScenery = Awaited<ReturnType<typeof decoderPool.decode>>;
  /**
   * Fetch and decode one scenery GLB off-thread. Registration (the GPU
   * buffers) happens later, one model per frame (#726 FR5).
   */
  const loadSceneryModel = async (id: string): Promise<DecodedScenery> => {
    const url = assetUrl(`/assets/scenery/${tierFolderFor(id)}/${id}.glb`);
    const applyVegetationGain = tierFolderFor(id) === 'tier-e';
    // Decode + merge off-thread. Tier-E vegetation is lifted inside the
    // worker via `VEGETATION_ALBEDO_GAIN` so the main thread never touches
    // the raw colour buffer; buildings (tier-D) pass through unchanged.
    return decoderPool.decode(id, url, applyVegetationGain);
  };
  const registerSceneryModel = (id: string, decoded: DecodedScenery, revealAt?: number): void => {
    sceneryMeshPass.register({
      id,
      positions: decoded.positions,
      normals: decoded.normals,
      indices: decoded.indices,
      colors: decoded.colors,
      baseColor: decoded.baseColor,
      maxInstances: COURSE_FURNITURE_MAX_INSTANCES,
      castsShadow: !SHADOW_NEUTRAL_MODEL_IDS.has(id),
      ...(revealAt !== undefined ? { revealAt } : {}),
    });
  };


  const shadowTelemetry: ShadowTelemetry = telemetry.shadows as ShadowTelemetry;
  const shadowStagePending = createShadowStage({
    device,
    atlas,
    scenePools,
    buildingsPool: buildingsCastingPool,
    charactersMesh,
    boatPass,
    telemetry: shadowTelemetry,
    bankCurve: waterCurve,
    bankEdgesForProgress: stripEdgesForProgress,
    bankFootprint,
    // #591-fu P1c: tier-gated flora + GLB-scenery shadow casters. Each
    // input stays null below medium so the depth stage adds nothing on
    // basic/low; at medium+ the stage picks up every solid-flora pool
    // and every registered GLB mesh (populated asynchronously as scenery
    // GLBs load) and renders their depth into the cascade atlas.
    // #623 Phase 1 — the procedural solid-flora pool is retired, so
    // the kit-tree GLB path (gated by `castSceneryShadows`) is the only
    // scenery depth caster.
    sceneryMeshPass: tierCaps.castSceneryShadows ? sceneryMeshPass : null,
    // #577 D10a scaled — fleet shadow casts land on medium / high /
    // extra-high. On basic the fleet is already absent (fleetCount=0);
    // on low it renders but the depth path stays off.
    castFleetShadows: tierCaps.castFleetShadows,
  });

  const shadowResources = {
    uniforms: shadowUniformsBuf,
    atlasView: atlas.view,
    cmpSampler: shadowCmpSampler,
  };
  sceneryMeshPass.setShadow(shadowResources);
  // Biome-density grass modulation (#496 Phase 2). Default to the route's
  // dominant profile when the adapter supplied one; strength scales with
  // the actual device tier, respecting the `__VIRTUALROW_SHADER_GRASS`
  // kill switch the React scene also honours — see `shaderGrass.ts`.
  // #496 FR3 / AC5: biome mapping lives in `plan/grassDensityPlan.ts`.
  // The adapter passes a `dominantProfile` picked by the same mapping, so
  // the renderer defers to it; the plan module is the source of truth,
  // and when the adapter omits it we fall through to the plan's default.
  const explicitProfile = isSceneryRoute(opts.route)
    ? (opts.route.dominantProfile as SceneryProfile | undefined)
    : undefined;
  const bankGrassProfile: SceneryProfile = explicitProfile ?? dominantGrassProfile(null);
  const bankGrassStrength = shaderGrassStrengthFor((opts.tier ?? 'medium') as PerformanceMode);
  const bankPassPending = createBankPass({
    device,
    format,
    frameUniforms,
    lightingUniforms,
    shadow: shadowResources,
    curve: waterCurve,
    edgesForProgress: stripEdgesForProgress,
    footprint: bankFootprint,
    grass: { profile: bankGrassProfile, strength: bankGrassStrength },
  });
  // #493 Phase 3b — if the enrichment carried lake polygons AND the kill
  // switch isn't disabled, draw polygon water in place of the strip. The
  // strip stays wired so a route whose enrichment lacks polygons (rivers,
  // offline fallbacks) renders exactly as before.
  const polygonWaterPassPending = useLakePolygonWater
    ? createWaterPolygonPass({
        device,
        format,
        frameUniforms,
        lightingUniforms,
        shadow: shadowResources,
        polygons: polygonLakes,
      })
    : Promise.resolve(null);
  // #493 AC6 follow-up — publish the polygon-water render telemetry so a
  // Playwright smoke can tell the polygon path from the ribbon fallback
  // without reaching into the engine. `fallback` is true when the kill
  // switch disabled polygon water OR there were no polygons to draw AT
  // ALL — in both cases the ribbon pass is wired below.
  publishPolygonWaterTelemetry(
    summarisePolygonWater(polygonLakes, tierCaps.polygonWaterMaxVertices, !useLakePolygonWater),
  );
  // #493 Phase 3d — debug overlay of the detected shoreline / islands /
  // on-land samples, toggled from `DebugPanel.svelte` via the global
  // `__VIRTUALROW_WATER_DEBUG` flag. The pass is only built when the
  // flag is on AND there is something to draw.
  const onLandSamples = isSceneryRoute(opts.route) && opts.route.onLandSamples
    ? opts.route.onLandSamples
    : [];
  const waterDebugPassPending = isWaterDebugEnabled() && (polygonLakes.length > 0 || onLandSamples.length > 0)
    ? createWaterDebugPass({
        device,
        format,
        frameUniforms,
        input: {
          shorelines: polygonLakes.map((p) => p.outer),
          islands: polygonLakes.flatMap((p) => p.holes),
          onLandSamples,
        },
      })
    : Promise.resolve(null);
  // Publish the summary so the DebugPanel can render it (AC23). We use
  // the enrichment-fed summary when the adapter provided one; otherwise
  // publish zeros so the overlay still has a shape to read.
  publishWaterDetectionSummary(
    isSceneryRoute(opts.route) && opts.route.waterDetectionSummary
      ? opts.route.waterDetectionSummary
      : EMPTY_WATER_DETECTION_SUMMARY,
  );
  // Polygon tessellation can be empty (all rings clipped away or
  // malformed); fall back to the strip rather than drop water entirely.
  const waterPassPending = polygonWaterPassPending.then(
    (polygonWater) =>
      polygonWater ??
      createWaterPass({
        device,
        format,
        frameUniforms,
        lightingUniforms,
        shadow: shadowResources,
        curve: waterCurve,
        edgesForProgress: stripEdgesForProgress,
      }),
  );
  const buildingsPassPending = createBuildingsPass({
    device,
    format,
    frameUniforms,
    shadow: shadowResources,
    pool: buildingsPool,
    telemetry: telemetry.buildings,
  });
  const cloudsPassPending = tierCaps.drawClouds
    ? createCloudsPass({ device, format, frameUniforms, lightingUniforms })
    : Promise.resolve(null);
  // #574 rain overlay: on only when the tier allows it AND the dev has
  // flipped `window.__VIRTUALROW_RAIN=true` (so a mobile ride isn't
  // soaked by default). Follow-up: wire to real weather data.
  const rainEnabled =
    tierCaps.drawRainOverlay &&
    !!(globalThis as unknown as { window?: { __VIRTUALROW_RAIN?: boolean } }).window
      ?.__VIRTUALROW_RAIN;
  const rainPassPending = rainEnabled
    ? createRainOverlayPass({ device, format, frameUniforms })
    : Promise.resolve(null);
  // #571 — hull wake foam. Shared state lives here; the ride loop below
  // calls `updateWake` each frame, and the pass uploads the pool to its
  // storage buffer before drawing.
  const wakeState = createWakeState();
  const wakePassPending = tierCaps.drawWakeParticles
    ? createWakeParticlesPass({ device, format, frameUniforms, wakeState })
    : Promise.resolve(null);
  // #571 oar-blade splash: shared CPU state + a billboard pass. The
  // update loop below detects the catch (phase 0) and finish (phase 0.5)
  // crossings and bursts particles at both blade tips.
  const oarSplashState = createOarSplashState();
  const oarSplashPassPending = tierCaps.drawOarSplash
    ? createOarSplashPass({ device, format, frameUniforms, state: oarSplashState })
    : Promise.resolve(null);

  const postCaps: PostFxCaps = {
    bloom: tierCaps.drawBloom,
    tone: true,
    vignette: tierCaps.drawVignette,
    lut: tierCaps.drawLut,
    ssao: tierCaps.drawSsao,
    dof:
      tierCaps.drawDof &&
      !!(globalThis as unknown as { window?: { __VIRTUALROW_POSTFX_DOF?: boolean } }).window
        ?.__VIRTUALROW_POSTFX_DOF,
    autoExposure: tierCaps.drawAutoExposure,
    chromaticAberration: chromaticAberrationEnabled(tierCaps),
  };
  const [
    shadowStage,
    skyPass,
    bankPass,
    waterDebugPass,
    waterPass,
    buildingsPass,
    cloudsPass,
    rainPass,
    wakePass,
    oarSplashPass,
    postFx,
  ] = await measureAttachAsync('pipelines', () => Promise.all([
    shadowStagePending,
    createSkyPass({ device, format, frameUniforms, lightingUniforms }),
    bankPassPending,
    waterDebugPassPending,
    waterPassPending,
    buildingsPassPending,
    cloudsPassPending,
    rainPassPending,
    wakePassPending,
    oarSplashPassPending,
    createPostFx({ device, sceneFormat: format, outputFormat, caps: postCaps }),
  ]));
  postFx.setInputs({
    sceneView: sceneTexture.createView(),
    sceneTexture,
    depthView: depthTexture.createView(),
    width: pixelWidth,
    height: pixelHeight,
  });
  telemetry.surface.cssWidth = width;
  telemetry.surface.cssHeight = height;
  telemetry.surface.devicePixelRatio = devicePixelRatioNow();
  telemetry.surface.scale = initialBacking.scale;
  telemetry.surface.width = pixelWidth;
  telemetry.surface.height = pixelHeight;
  telemetry.surface.antialias = surfaceCaps.antialias;

  const passes: Pass[] = [
    shadowStage,
    skyPass,
    ...(cloudsPass ? [cloudsPass] : []),
    bankPass,
    buildingsPass,
    sceneryPass,
    waterPass,
    ...(waterDebugPass ? [waterDebugPass] : []),
    boatPass,
    sceneryMeshPass,
    ...(rainPass ? [rainPass] : []),
    ...(wakePass ? [wakePass] : []),
    ...(oarSplashPass ? [oarSplashPass] : []),
    postFx.pass,
  ];
  // #584 AC3: GPU frame-time timer. null on adapters without `timestamp-query`
  // (CI's SwiftShader among them), where gpuMs stays 0 and the frame is
  // unchanged.
  const gpuTimer = createGpuFrameTimer(device);
  const graph: FrameGraph = createFrameGraph(passes, gpuTimer);

  const frame: FrameUniforms = {
    view: mat4Identity(mat4()),
    proj: mat4(),
    viewProj: mat4(),
    camPos: vec3(0, 2.6, 7),
    sunDir: vec3(0.3, 0.8, 0.5),
    fog: new Float32Array([0.001, 0.0005, 0, 0]),
    time: 0,
    // #567 "Animated cloud flow": prevailing wind in UV / second. Slightly
    // livelier than the pre-#567 hard-coded (0.012, 0.004) so the sky reads
    // as a moving overcast rather than a static backdrop. Direction has a
    // small bias so the two components aren't equal — looks like real wind
    // rather than a diagonal sweep.
    wind: new Float32Array([0.018, 0.006]),
  };
  // #596 follow-up: the view-distance axis also shapes the fog curtain, so a
  // wider distance tier reveals the longer sprout window instead of ending in
  // fog, and a narrower one pulls the curtain in. Scales both density terms by
  // one factor; medium/undefined leaves the baseline untouched.
  const fogScale = fogDistanceScaleFor(opts.distanceTier ?? opts.tier);
  const baseFogNear = frame.fog[0];
  const baseFogFar = frame.fog[1];
  frame.fog[0] = baseFogNear * fogScale;
  frame.fog[1] = baseFogFar * fogScale;

  // #730 VP-12 — the rower's conditions. One function writes everything a
  // condition touches, at attach and on every live switch: the sun (which
  // the shadow cascades read from `frame.sunDir` each frame, FR3), the fog
  // density, the lighting block the sky / clouds / water / bank read, the
  // post-fx exposure, and the `__ROWER3D_CONDITIONS` telemetry (FR5).
  const lightingScratch = new Float32Array(32);
  const applyLighting = (l: FrameLighting): void => {
    frame.sunDir[0] = l.sunDir[0];
    frame.sunDir[1] = l.sunDir[1];
    frame.sunDir[2] = l.sunDir[2];
    frame.fog[0] = baseFogNear * fogScale * l.fogDensityScale;
    frame.fog[1] = baseFogFar * fogScale * l.fogDensityScale;
    packFrameLighting(l, lightingScratch);
    device.queue.writeBuffer(lightingUniforms, 0, lightingScratch as BufferSource);
    postFx.setExposureBias(l.exposureBias);
    const t = telemetry.conditions;
    t.name = l.name;
    t.sunElevationDeg = l.sunElevationDeg;
    t.sunAzimuthDeg = l.sunAzimuthDeg;
    t.sunDir = [...l.sunDir];
    t.sunDisc = l.sunDisc;
    t.cloudCover = l.cloudCover;
    t.shadowStrength = l.shadowStrength;
    t.exposureBias = l.exposureBias;
    t.fogDensityScale = l.fogDensityScale;
    t.skyZenith = [...l.skyZenith];
    t.skyHorizon = [...l.skyHorizonCool];
  };
  applyLighting(conditionsToFrameLighting(opts.conditions));

  const routeCurve = waterCurve;
  const curveLength = routeCurve.approximateLength(32);
  const totalDistanceMeters =
    isSceneryRoute(opts.route) && typeof opts.route.totalDistanceMeters === 'number'
      ? Math.max(1, opts.route.totalDistanceMeters)
      : Math.max(1, curveLength);
  telemetry.route.hasCurve = true;
  telemetry.route.totalDistance = totalDistanceMeters;
  telemetry.route.curveLength = curveLength;
  telemetry.route.selfParallel = parallelLegs.selfParallel;

  // #685 wire-up — compose per-route extras from the three sources
  // (`composePlacementsForRoute`): tier-r llm-cad (fetched from the
  // served registry, empty today until #449 populates it), hand-
  // authored `ROUTE_EXTRAS` (via `routeExtras`), synthetic bridges
  // from the route's OSM crossings. The winning source feeds
  // `placeFurniture` as its `extras` list; the function stays purely
  // generic otherwise. The fetch resolves to an empty registry on a
  // 404 / parse failure / network error so the engine still boots.
  const placementsRegistry: RoutePlacementsRegistry = await fetchRoutePlacementsRegistry(
    assetUrl('').replace(/\/$/, ''),
  );
  const routeCrossings = isSceneryRoute(opts.route) && opts.route.crossings
    ? (opts.route.crossings as readonly { progress: number; kind: BridgeKind }[])
    : [];
  const syntheticExtras = synthesisePlacementsForRoute({
    routeId: opts.routeId,
    crossings: routeCrossings,
  });
  const handAuthoredExtras = routeExtras(opts.routeId);
  const composed = composePlacementsForRoute({
    routeId: opts.routeId,
    routeMeters: totalDistanceMeters,
    tierR: placementsRegistry,
    handAuthored: handAuthoredExtras,
    synthetic: syntheticExtras,
  });
  // Normalise composed items back into the `Furniture` shape
  // `placeFurniture` accepts. Hand-authored items already carry a
  // `kind`; the tier-r / synthetic paths map the centreline flag onto
  // the `'span'` kind and anything else onto `'furniture'`.
  const composedFurniture: Furniture[] = composed.map((p) => {
    // Resolve back to the hand-authored kind if the source was hand-
    // authored (so bridges stay `'span'` on the Willowbrook author plot).
    const handMatch = handAuthoredExtras.find(
      (h) => h.id === p.modelId && Math.abs(h.progress - p.progress) < 1e-6,
    );
    const kind = handMatch?.kind ?? (p.bankSide === 'centre' ? 'span' : 'furniture');
    const side: 'left' | 'right' = p.bankSide === 'right' ? 'right' : 'left';
    return { id: p.modelId as SceneryModelId, progress: p.progress, side, kind };
  });

  const furniture: FurniturePlacement[] = placeFurniture({
    curve: routeCurve,
    routeMeters: totalDistanceMeters,
    shoreHalfWidth: (progress, side) => {
      if (!waterEdgesForProgress) return 10;
      const edges = waterEdgesForProgress(progress);
      return side === 'left' ? edges.left : edges.right;
    },
    routeId: opts.routeId,
    extras: composedFurniture,
  });
  const byModel = new Map<SceneryModelId, Mat4[]>();
  for (const model of COURSE_FURNITURE_MODELS) byModel.set(model, []);
  const ASSET_SCALE = 0.001;
  for (const place of furniture) {
    // #742 FR3 — bank furniture on another leg's water is not placed.
    // Spans and buoys belong on the water.
    if (place.kind === 'furniture' && rejectOnWater.contains(place.position[0], place.position[2])) {
      rejectedOnWater += 1;
      continue;
    }
    const trs = mat4();
    const rot = mat4();
    const t = mat4();
    mat4FromRotationY(rot, place.rotationY);
    // #724 — spans carry the scale that fits them to the river.
    const k = ASSET_SCALE * (place.scale ?? 1);
    rot[0] *= k; rot[1] *= k; rot[2] *= k;
    rot[4] *= k; rot[5] *= k; rot[6] *= k;
    rot[8] *= k; rot[9] *= k; rot[10] *= k;
    mat4Identity(t);
    t[12] = place.position[0];
    t[13] = place.position[1];
    t[14] = place.position[2];
    mat4Multiply(trs, t, rot);
    byModel.get(place.id)?.push(trs);
  }
  // Combine course-furniture + GLB-scenery instance transforms into one map,
  // keyed by model id. #723 FR5: when a model id appears in BOTH the
  // course-furniture output (byModel) and the route's generated groups
  // (sceneryGlbList), their instances are CONCATENATED rather than
  // overwritten — before, `.set` here silently wiped the finish tower,
  // boathouse and distance posts whenever a route group for the same id
  // came in through `composePlacementsForRoute`.
  const courseFurnitureInstanceMats = new Map<string, Mat4[]>();
  for (const model of COURSE_FURNITURE_MODELS) {
    courseFurnitureInstanceMats.set(model, byModel.get(model) ?? []);
  }
  const routeGlbInstanceMats = new Map<string, Mat4[]>();
  for (const group of sceneryGlbList) {
    const mats: Mat4[] = [];
    // #742 FR3 — bridges and buoys belong on the water; any other model
    // well inside some part of the route's water is not placed.
    const onWaterByDesign = group.id in BRIDGE_SPANS || group.id.includes('buoy');
    for (const inst of group.instances) {
      if (!onWaterByDesign && rejectOnWater.contains(inst.position[0], inst.position[2], GLB_WATER_MARGIN_METRES)) {
        rejectedOnWater += 1;
        continue;
      }
      const trs = mat4();
      const rot = mat4();
      const t = mat4();
      mat4FromRotationY(rot, inst.rotationY);
      rot[0] *= inst.scale; rot[1] *= inst.scale; rot[2] *= inst.scale;
      rot[4] *= inst.scale; rot[5] *= inst.scale; rot[6] *= inst.scale;
      rot[8] *= inst.scale; rot[9] *= inst.scale; rot[10] *= inst.scale;
      mat4Identity(t);
      t[12] = inst.position[0];
      t[13] = inst.position[1];
      t[14] = inst.position[2];
      mat4Multiply(trs, t, rot);
      mats.push(trs);
    }
    routeGlbInstanceMats.set(group.id, mats);
  }
  // #724 VP-06 FR4 — every bridge span in the scene, so the camera can
  // stay under its deck: the hand-authored/composed spans with their fitted
  // headroom, and the route's own bridge GLBs (OSM crossings, landmarks),
  // whose headroom is read from the opening over the camera.
  const bridgeSpans: SpanCeilingSource[] = [
    ...furniture
      .filter((place) => place.kind === 'span')
      .map((place) => ({
        id: place.id,
        position: place.position,
        rotationY: place.rotationY,
        scale: place.scale ?? 1,
        ceiling: place.ceiling,
      })),
    ...sceneryGlbList
      .filter((group) => group.id in BRIDGE_SPANS)
      .flatMap((group) => group.instances.map((inst) => ({
        id: group.id,
        position: inst.position,
        rotationY: inst.rotationY,
        scale: inst.scale / ASSET_SCALE,
      }))),
  ];
  telemetry.route.rejectedOnWater = rejectedOnWater;
  telemetry.route.spans = bridgeSpans.map((span) => ({
    id: span.id,
    x: span.position[0],
    z: span.position[2],
    rotationY: span.rotationY,
    scale: span.scale,
    ceiling: span.ceiling ?? null,
  }));
  const ceilingAt = (x: number, z: number): number => spanCeilingAt(bridgeSpans, x, z);
  const sceneryInstanceMats = mergeSceneryInstances([
    courseFurnitureInstanceMats,
    routeGlbInstanceMats,
  ]);

  // Progressive loading plan: sample the route for along-route distances, work
  // out where each model first appears, and load models as the boat comes
  // within the look-ahead window (driven from the frame loop below).
  const SCENERY_STREAM_SAMPLES = 128;
  const SCENERY_MAX_PER_TICK = 3;
  const streamSamples: CurveDistanceSample[] = [];
  for (let i = 0; i <= SCENERY_STREAM_SAMPLES; i += 1) {
    const p = i / SCENERY_STREAM_SAMPLES;
    const cp = routeCurve.sample(p);
    streamSamples.push({
      position: [cp.position[0], cp.position[1], cp.position[2]],
      distanceMeters: p * totalDistanceMeters,
    });
  }
  const sceneryPlan = planSceneryStream(
    [...sceneryInstanceMats].map(([id, mats]) => ({
      id,
      instancePositions: mats.map((m) => [m[12], m[13], m[14]] as [number, number, number]),
    })),
    streamSamples,
  );
  const sceneryLoaded = new Set<string>();
  // #761 — scenery clearance from the centreline, re-measured whenever a
  // model is registered (instances are static once drawn). Test mode only.
  const sceneryClearance = emptySceneryClearance();
  let sceneryClearanceMeasuredAt = -1;
  const sceneryFailed = (id: string): boolean => telemetry.scenery.failedIds.includes(id);
  const sceneryLoading = new Set<string>();
  const sceneryRegistrations = createRegistrationQueue<{ id: string; decoded: DecodedScenery }>();
  // #726 FR2 — the window follows the boat's speed (the previous frame's).
  let streamSpeedMps = 0;
  // #736 FR2 — the planner asks both sets directly, no merged copy a frame.
  const sceneryKnown = { has: (id: string) => sceneryLoaded.has(id) || sceneryLoading.has(id) };
  let lastStream: StreamLook | null = null;
  const streamScenery = (boatDistanceMeters: number, loop: boolean): void => {
    const lookahead = streamLookaheadMeters(streamSpeedMps);
    // #736 FR2 — nothing in flight and the boat barely moved: same answer.
    if (!streamNeedsRecheck(lastStream, boatDistanceMeters, lookahead, loop, sceneryLoading.size > 0)) return;
    if (lastStream) {
      lastStream.meters = boatDistanceMeters;
      lastStream.horizon = boatDistanceMeters + lookahead;
      lastStream.loop = loop;
    } else {
      lastStream = { meters: boatDistanceMeters, horizon: boatDistanceMeters + lookahead, loop };
    }
    const pending = sceneryModelsToLoad(
      sceneryPlan,
      sceneryKnown,
      boatDistanceMeters,
      lookahead,
      SCENERY_MAX_PER_TICK,
      // #647 FR6 — looping walks the stream plan torus-style so the first
      // tiles of the route are already loaded when the boat crosses the seam.
      loop ? { loopRouteMeters: totalDistanceMeters } : undefined,
    );
    for (const id of pending) {
      sceneryLoading.add(id);
      void loadSceneryModel(id)
        .then((decoded) => {
          sceneryRegistrations.push({ id, decoded });
        })
        .catch(() => {
          // #726 FR6 — a fetch or decode failure leaves the model out and is
          // reported, rather than swallowed.
          sceneryLoading.delete(id);
          sceneryLoaded.add(id);
          if (!telemetry.scenery.failedIds.includes(id)) telemetry.scenery.failedIds.push(id);
          telemetry.scenery.failed = telemetry.scenery.failedIds.length;
        });
    }
  };
  /** #726 FR5 — register at most one decoded model this frame. */
  const registerNextScenery = (): void => {
    sceneryRegistrations.drainOne(({ id, decoded }) => {
      // #726 FR3 — fade it in from this frame rather than pop it in.
      registerSceneryModel(id, decoded, frame.time);
      telemetry.scenery.reveals.push({
        id,
        registeredAtFrame: telemetry.scenery.frame,
        registeredAt: frame.time,
        revealAlpha: 0,
      });
      sceneryMeshPass.setInstances(id, sceneryInstanceMats.get(id) ?? []);
      sceneryLoading.delete(id);
      sceneryLoaded.add(id);
      telemetry.scenery.registered = sceneryLoaded.size - telemetry.scenery.failed;
    });
  };

  // #735 VP-17 — the camera follows the rig target through damping and a
  // filtered, rate-limited FOV; see `stepCameraRig`.
  const cameraRig = createCameraRig();
  let lastCameraTime = -1;
  let cameraBendSign = 0;
  const bendAhead = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  const boatPlacement = createPlacement();
  const ghostPlacement = createPlacement();
  const boatBones = [mat4(), mat4(), mat4(), mat4()];
  const ghostBones = [mat4(), mat4(), mat4(), mat4()];
  for (let i = 0; i < BOAT_BONE_COUNT; i++) {
    mat4Identity(boatBones[i]);
    mat4Identity(ghostBones[i]);
  }
  // #577 slice 2 — placeholder-fleet state + per-member reusable
  // placement + identity bones. Fleet members draw through the same
  // `boatPass` as the player and race ghost; the state module owns
  // their deterministic positions and respawn-into-window behaviour.
  // The actual state object is built in the frame loop once
  // `totalDistanceMeters` is known.
  const fleetState: { current: MutableFleetState | null } = { current: null };
  const fleetPlacements = Array.from({ length: FLEET_INSTANCE_CAPACITY }, () => createPlacement());
  const fleetBones = Array.from({ length: BOAT_BONE_COUNT }, () => mat4());
  for (let i = 0; i < BOAT_BONE_COUNT; i += 1) mat4Identity(fleetBones[i]);
  let lastFleetTime = -1;
  // #728 FR3: the lanes are fitted to the river once per scene.
  const fleetWater = fleetWaterHalfWidth(waterEdgesForProgress, DEFAULT_WATER_HALF_WIDTH_M);
  // #728 FR4: a per-slot tint so the fade can scale the palette's alpha.
  const fleetTints = Array.from({ length: FLEET_INSTANCE_CAPACITY }, () => new Float32Array(4));
  // #571 shell paint: when the shell plumbs an athlete id through,
  // the hull tint comes from `boatPaint.boatTintFromAthlete`. Falls
  // back to today's off-white when the id is empty / undefined.
  const BOAT_TINT = boatTintFromAthlete(opts.athleteId);
  const GHOST_TINT = new Float32Array([0.35, 0.85, 1.0, 0.5]);
  // #728 FR1 — per-primitive instance matrices, kept across frames.
  const scullGhostTrs = mat4();
  const fleetScullTrs = Array.from({ length: FLEET_INSTANCE_CAPACITY }, () => mat4());
  /**
   * #713 D3a — a fleet member's style per primitive. The hull takes the
   * member's palette colour, sun-shaded. On the player's own scull the
   * crew's vertex colours carry the player's palette, so a member rowing
   * it wears the authored kit instead (D5 per-member kit is phase 2).
   */
  const fleetPrimitiveTint = (
    prim: BoatScullPrimitive,
    hull: Float32Array,
    sharesPlayerColors: boolean,
    current: ScullInstance['tint'],
  ): ScullInstance['tint'] => {
    if (isFleetTintable(prim.nodeName ?? prim.group)) return writeTint(current, hull[0], hull[1], hull[2]);
    if (sharesPlayerColors && prim.slot && prim.authoredColors) {
      const c = prim.authoredColors;
      return writeTint(current, c[0], c[1], c[2]);
    }
    return undefined;
  };
  // #577 D9a — placeholder fleet uses a desaturated solid hull tint so
  // they read as a pack of other boats rather than semi-transparent
  // race ghosts. Slight variation per member via a seed-driven hue
  // lands with D6b in a follow-up.
  // #577 D6b — the per-member hull tint comes from `fleetHullTintFor`
  // (keyed off the member's seed). Nothing shared at render time, so
  // this variable is retired; left as a note of the old flat pack look.

  const start = now();
  let disposed = false;
  let viewportInsets: ViewportInsets = sanitiseInsets(opts.viewportInsets);

  // #731 FR2 — read once a frame: the ResizeObserver's last report where
  // there is one, the element's client size otherwise. Targets are rebuilt
  // only when the backing size changes, so at most once a frame.
  const resize = (): void => {
    const dpr = devicePixelRatioNow();
    const cssW = Math.max(1, Math.floor(observedSize?.cssWidth || canvas.clientWidth || width));
    const cssH = Math.max(1, Math.floor(observedSize?.cssHeight || canvas.clientHeight || height));
    const backing = observedSize
      ? backingSizeForObserved({ ...observedSize, cssWidth: cssW, cssHeight: cssH }, dpr, surfaceCaps)
      : backingSizeFor(cssW, cssH, dpr, surfaceCaps);
    width = cssW;
    height = cssH;
    telemetry.surface.cssWidth = cssW;
    telemetry.surface.cssHeight = cssH;
    telemetry.surface.devicePixelRatio = dpr;
    telemetry.surface.scale = backing.scale;
    const w = backing.width;
    const h = backing.height;
    if (w === pixelWidth && h === pixelHeight) return;
    pixelWidth = w;
    pixelHeight = h;
    telemetry.surface.width = w;
    telemetry.surface.height = h;
    canvas.width = w;
    canvas.height = h;
    depthTexture.destroy();
    depthTexture = device.createTexture({
      label: 'depth',
      size: { width: w, height: h },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    sceneTexture.destroy();
    sceneTexture = device.createTexture({
      label: 'scene-hdr',
      size: { width: w, height: h },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    postFx.setInputs({
      sceneView: sceneTexture.createView(),
      sceneTexture,
      depthView: depthTexture.createView(),
      width: w,
      height: h,
    });
  };

  let lastDistanceMeters = 0;
  let lastSpeedTime = -1;
  // Smooths the boat's distance between the ~2 Hz PM5 samples that drive it so
  // the hull glides instead of holding then jumping at each sample boundary
  // (see distanceSmoother.ts). The ghost is already continuous via
  // `ghostDistanceAt(elapsedSeconds)`; this gives the player boat the same.
  // (#620 replaced the earlier inline smoothedDistance/lastDistSample easing.)
  const distanceSmoother = createDistanceSmoother();
  let lastWakeTime = 0; // #571 — seconds since start, matches `frame.time` units
  let lastOarSplashTime = 0; // #571 — seconds since start, for the oar-splash sim
  // #720 VP-02 — one phase integrator per attach; a cadence wobble only
  // changes the rate, never jumps the pose.
  const strokeClock = createStrokeClock();
  let lastStrokeTime = -1;
  let strokeWasPlaying = false;
  // #728 FR1 — the ghost rows on its own clock, at its own cadence.
  const ghostStrokeClock = createStrokeClock();
  let ghostMarkerKey = '';
  // #728 FR2 spec seam (test mode): draw the frame without the ghost, so a
  // spec can diff the two and read the ghost's silhouette against the very
  // water behind it.
  let ghostHidden = false;
  // …and draw the ghost flat magenta, so a spec can tell its own pixels
  // from its reflection and shadow on the water, which a with/without
  // diff also catches.
  let ghostMask = false;
  const GHOST_MASK_STYLE = { tint: [1, 0, 1, 1] as const, alpha: 1, rim: 0, flat: 1, haze: 0 };
  // #734 AC2 — the same flat magenta on the player's scull, so a spec can
  // read the hull's own pixels (in shadow under a bridge, and in the sun).
  let playerMask = false;
  // …and hold the ride still (the same time and ride frame each draw), so
  // those three frames sample the same pixels of a boat that has not moved.
  let holdFrame = false;
  let heldFrame: { time: number; ride: RideFrame | null; smoothed?: RideFrame | null } | null = null;
  const rowedFrameScratch = emptyRideFrame();
  /** #736 — the frame a fleet member is placed from, rewritten per member. */
  const fleetFrameScratch = emptyRideFrame();
  /** #736 — scull poses handed to `scullPrimitiveTransform`, rewritten per boat. */
  const restPose = crewStrokePose(opts.crew === 'female' ? 'female' : 'male', 0);
  const scullPoseScratch = {
    player: { boatTrs: mat4(), sweep: 0, stroke: restPose },
    ghost: { boatTrs: mat4(), sweep: 0, stroke: restPose },
    fleet: { boatTrs: mat4(), sweep: 0, stroke: restPose },
  };
  /** #736 — per-frame matrices and vectors, reused rather than allocated each frame. */
  const frameScratch = {
    boatTrs: mat4(),
    scullRot: mat4(),
    scullTrans: mat4(),
    camBoat: vec3(),
    camTangent: vec3(),
    camSample: { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 },
    up: vec3(0, 1, 0),
    camForward: vec3(),
    lightDirection: vec3(),
    cascades: createComputedCascades(),
  };
  const seekFrameScratch = emptyRideFrame();
  // #724 — test mode: pin the boat at a distance along the route (null rows).
  let seekMeters: number | null = null;
  // #737 VP-19 FR1/FR3 — the real interval between drawn frames, and the
  // pacing window over it. FR6: `resume()` after a hidden tab sets
  // `resumePending`, so the next frame restarts the simulation clocks
  // instead of fast-forwarding them over the time the page was hidden.
  let lastDrawMs = -1;
  let resumePending = false;
  const pacing = createFramePacing();
  const panelStats = emptyPanelStats();

  const drawFrame = (): void => {
    if (disposed) return;
    const drawStartMs = now();
    const realDtMs = lastDrawMs < 0 ? 0 : drawStartMs - lastDrawMs;
    lastDrawMs = drawStartMs;
    const resuming = resumePending;
    resumePending = false;
    if (resuming) {
      lastSpeedTime = -1;
      lastStrokeTime = -1;
      lastFleetTime = -1;
    }
    // #584 FR3 — cpuMs is the CPU-side encode time. Measured end-to-end so
    // the frame-graph internal work (pass encodes + submit) plus the engine's
    // uniform packs are inside the window. Follow-up: when `timestamp-query`
    // is live, publish gpuMs from the resolved query buffer; today the device
    // asks for the feature (device.ts) but no pass writes a timestamp yet.
    const cpuStart = now();
    resize();
    if (holdFrame && heldFrame) {
      frame.time = heldFrame.time;
    } else {
      frame.time = (now() - start) / 1000;
    }
    const rideFrame: RideFrame | null =
      holdFrame && heldFrame ? heldFrame.ride : opts.getFrame ? opts.getFrame() : null;
    if (resuming) {
      lastWakeTime = frame.time;
      lastOarSplashTime = frame.time;
      if (rideFrame) distanceSmoother.reset(rideFrame.distanceMeters ?? 0, now());
    }
    if (holdFrame && !heldFrame) heldFrame = { time: frame.time, ride: rideFrame };
    if (!holdFrame) heldFrame = null;

    // #736 — both derived frames are written into scratch, not spread anew.
    let rowedFrame: RideFrame | null = null;
    if (heldFrame?.smoothed !== undefined) {
      rowedFrame = heldFrame.smoothed;
    } else if (rideFrame) {
      rowedFrame = copyRideFrame(rowedFrameScratch, rideFrame);
      rowedFrame.distanceMeters = distanceSmoother.update(
        rideFrame.distanceMeters,
        rideFrame.isPlaying && !rideFrame.holdBoat && !rideFrame.finished,
        now(),
      );
    }
    // #724 — a spec can pin the boat to a distance to traverse a bridge.
    let smoothedFrame: RideFrame | null = rowedFrame;
    if (seekMeters !== null && rowedFrame) {
      smoothedFrame = copyRideFrame(seekFrameScratch, rowedFrame);
      smoothedFrame.distanceMeters = seekMeters;
      smoothedFrame.holdBoat = false;
      smoothedFrame.finished = false;
    }
    // A held frame keeps its own copy: the scratch is rewritten next frame.
    if (heldFrame && heldFrame.smoothed === undefined) {
      heldFrame.smoothed = smoothedFrame && copyRideFrame(emptyRideFrame(), smoothedFrame);
    }

    placeBoat(boatPlacement, routeCurve, smoothedFrame, totalDistanceMeters, curveLength, 0);
    // #571 wake foam: run the CPU particle sim before the pass encodes.
    // `isMoving` gates on both `isPlaying` AND the holdBoat/finished state
    // so no spawns happen during countdown or post-finish review.
    const wakeMoving = !!rideFrame?.isPlaying && !rideFrame.holdBoat && !rideFrame.finished;
    const wakeDt = Math.max(0, frame.time - lastWakeTime);
    updateWake(
      wakeState,
      boatPlacement.world[0],
      boatPlacement.world[2],
      boatPlacement.heading,
      wakeMoving,
      wakeDt,
    );
    lastWakeTime = frame.time;
    // Stream scenery that has come within the look-ahead window as the boat
    // advances; already-loaded / in-flight models are skipped.
    // Pass the boat's position along the current lap (already wrapped by
    // `placeBoat` when the frame is looping) together with the loop flag so
    // the stream planner wraps its lookahead window around the seam.
    telemetry.scenery.frame += 1;
    for (const r of telemetry.scenery.reveals) {
      if (r.revealAlpha < 1) r.revealAlpha = revealAlpha(frame.time, r.registeredAt, 0);
    }
    registerNextScenery();
    if (opts.testMode && sceneryLoaded.size !== sceneryClearanceMeasuredAt) {
      sceneryClearanceMeasuredAt = sceneryLoaded.size;
      measureSceneryClearance(sceneryClearance, waterCurveSource, sceneryLoaded, sceneryInstanceMats, sceneryFailed);
    }
    streamScenery(boatPlacement.progress * totalDistanceMeters, !!rideFrame?.loop);
    const ghostInfo = placeGhost(
      ghostPlacement,
      routeCurve,
      rideFrame?.ghost ?? null,
      rideFrame?.elapsedSeconds ?? frame.time,
      totalDistanceMeters,
      curveLength,
      -GHOST_LANE_OFFSET_M,
    );

    // #720 VP-02 — integrate the stroke phase from (cadence, dt) rather
    // than recomputing elapsed × spm / 60 each frame. A cadence wobble
    // then alters the rate and doesn't jump the pose.
    const isPlayingNow = rideFrame?.isPlaying ?? false;
    const strokeDt = lastStrokeTime < 0 ? 0 : frame.time - lastStrokeTime;
    lastStrokeTime = frame.time;
    // Reset the clock when a new session starts (a transition from
    // stopped to playing). Stopping mid-row freezes the phase instead.
    if (isPlayingNow && !strokeWasPlaying && (rideFrame?.elapsedSeconds ?? 0) < 0.25) {
      resetStrokeClock(strokeClock);
    }
    strokeWasPlaying = isPlayingNow;
    const phase = stepStrokeClock(strokeClock, {
      cadence: rideFrame?.cadence ?? 0,
      dtSeconds: strokeDt,
      isPlaying: isPlayingNow,
    });
    const ghostSource = rideFrame?.ghost ?? null;
    const ghostElapsed = rideFrame?.elapsedSeconds ?? frame.time;
    const ghostRow = ghostSource ? ghostStroke(ghostSource, ghostElapsed) : { rowing: false, cadence: 0 };
    if (isPlayingNow && ghostElapsed < 0.25) resetStrokeClock(ghostStrokeClock);
    const ghostRowing = isPlayingNow && ghostRow.rowing && !!ghostInfo;
    const ghostPhase = stepStrokeClock(ghostStrokeClock, {
      cadence: ghostRow.cadence,
      dtSeconds: strokeDt,
      isPlaying: ghostRowing,
    });
    // #571 oar-blade splash: fire a burst at catch (phase 0 crossing) and
    // finish (phase 0.5 crossing). `isMoving` matches the wake-pass gate.
    const oarSplashMoving = !!rideFrame?.isPlaying && !rideFrame.holdBoat && !rideFrame.finished;
    const oarSplashDt = Math.max(0, frame.time - lastOarSplashTime);
    updateOarSplash(
      oarSplashState,
      boatPlacement.world[0],
      boatPlacement.world[2],
      boatPlacement.heading,
      phase,
      oarSplashMoving,
      oarSplashDt,
    );
    lastOarSplashTime = frame.time;
    const amp = strokeAmplitude(rideFrame);
    const torsoLean = Math.sin(phase * Math.PI * 2) * 0.35 * amp;
    const armPull = Math.sin(phase * Math.PI * 2 + 0.5) * 0.6 * amp;
    const headNod = Math.sin(phase * Math.PI * 2) * 0.1 * amp;
    mat4Identity(boatBones[BOAT_BONE_HULL]);
    mat4FromRotationY(boatBones[BOAT_BONE_TORSO], torsoLean);
    mat4FromRotationY(boatBones[BOAT_BONE_ARMS], armPull);
    mat4FromRotationY(boatBones[BOAT_BONE_HEAD], headNod);
    for (let i = 0; i < BOAT_BONE_COUNT; i++) mat4Identity(ghostBones[i]);

    if (!tierCaps.drawCrew) {
      mat4Identity(boatBones[BOAT_BONE_TORSO]);
      mat4Identity(boatBones[BOAT_BONE_ARMS]);
      mat4Identity(boatBones[BOAT_BONE_HEAD]);
    }
    const scullLoaded = boatScullMeshIds.length > 0;
    boatPass.boatVisible.value = !scullLoaded;
    // #728 FR1: with the scull GLB loaded the ghost is drawn from it; the
    // simplified mesh stays the fallback, as it is for the player.
    boatPass.ghostVisible.value = ghostInfo !== null && !scullLoaded && !ghostHidden;

    if (scullLoaded) {
      const { boatTrs, scullRot, scullTrans } = frameScratch;
      mat4FromRotationY(scullRot, boatPlacement.heading);
      mat4Identity(scullTrans);
      scullTrans[12] = boatPlacement.world[0];
      scullTrans[13] = boatPlacement.world[1];
      scullTrans[14] = boatPlacement.world[2];
      mat4Multiply(boatTrs, scullTrans, scullRot);

      // #720 VP-02 — same phase feeds the oar sweep, the splash burst
      // and the legacy bones (FR2). Before this, the sweep used
      // `elapsed` while splashes used `frame.time`, so blades entered
      // the water out of step with the splash.
      const phaseSweep = phase;
      const ampSweep = strokeAmplitude(rideFrame);
      // #672: the oar swings between the crew's catch (phase 0) and finish
      // (phase 0.5), and the rower's seat, legs, body and arms follow it.
      const crew = opts.crew === 'female' ? 'female' : 'male';
      const sweep = oarSweep(crew, phaseSweep, ampSweep);
      const stroke = crewStrokePose(crew, sweep);

      // #728 FR1 — the ghost: the same primitives at its own placement,
      // with its own sweep and pose, in its own style.
      let ghostTrs: Mat4 | null = null;
      let ghostSweep = 0;
      let ghostPose = stroke;
      if (ghostInfo && !ghostHidden) {
        ghostTrs = scullBoatTrs(scullGhostTrs, ghostPlacement.world, ghostPlacement.heading);
        ghostSweep = oarSweep(crew, ghostPhase, ghostRowing ? 1 : 0);
        ghostPose = crewStrokePose(crew, ghostSweep);
      }

      const playerPose = scullPoseScratch.player;
      playerPose.boatTrs = boatTrs;
      playerPose.sweep = sweep;
      playerPose.stroke = stroke;
      const ghostPoseArgs = scullPoseScratch.ghost;
      if (ghostTrs) {
        ghostPoseArgs.boatTrs = ghostTrs;
        ghostPoseArgs.sweep = ghostSweep;
        ghostPoseArgs.stroke = ghostPose;
      }
      const ghostStyle = ghostMask ? GHOST_MASK_STYLE : GHOST_SCULL_STYLE;
      for (const prim of boatScullPrimitives) {
        const instances = prim.instances;
        instances.length = 0;
        if (prim.visible) {
          const playerModel = scullPrimitiveTransform(prim.player, prim, playerPose);
          instances.push(playerMask ? { model: playerModel, ...GHOST_MASK_STYLE } : playerModel);
          if (ghostTrs) {
            const ghost = prim.ghost;
            scullPrimitiveTransform(ghost.model, prim, ghostPoseArgs);
            ghost.tint = ghostStyle.tint;
            ghost.alpha = ghostStyle.alpha;
            ghost.rim = ghostStyle.rim;
            ghost.flat = ghostStyle.flat;
            ghost.haze = ghostStyle.haze;
            instances.push(ghost);
          }
        }
      }
      for (const prim of boatScullAltPrimitives) prim.instances.length = 0;
    }
    boatPass.boat.write(device, {
      model: boatPlacement.modelMatrix,
      bones: boatBones,
      tintRGBA: BOAT_TINT,
      ghost: false,
      visible: true,
    });
    if (ghostInfo) {
      boatPass.ghost.write(device, {
        model: ghostPlacement.modelMatrix,
        bones: ghostBones,
        tintRGBA: GHOST_TINT,
        ghost: true,
        visible: true,
      });
    }

    // #577 slice 2 — advance the fleet, position each member on the
    // route curve, write per-instance uniforms. The visible count is
    // `tierCaps.fleetCount`, clamped to the pass's capacity.
    if (!fleetState.current || fleetState.current.routeMeters !== totalDistanceMeters) {
      fleetState.current = mutableFleet(createFleet({
        count: tierCaps.fleetCount,
        routeMeters: totalDistanceMeters,
        routeId: opts.routeId,
        playerStartMeters: boatPlacement.distanceMeters,
        waterHalfWidth: fleetWater,
      }));
      lastFleetTime = frame.time;
    }
    const fleetDt = lastFleetTime >= 0 ? Math.max(0, frame.time - lastFleetTime) : 0;
    // #736 FR5 — advanced in place: no new members a frame.
    advanceFleetInPlace(fleetState.current, boatPlacement.distanceMeters, fleetDt);
    lastFleetTime = frame.time;
    const fleetMembers = fleetState.current.members;
    // #577 D6b — compute the "avoid this palette entry" index once per
    // frame from the player's current unisuit top, so no fleet member
    // wears the same top colour as the player.
    const fleetExcludeIndex = fleetPaletteIndexForColor(currentAppearance.top);
    // #728 FR4 — members in the window's hidden bands are not drawn at
    // all (nor cast shadows); the rest pack into the first slots, faded
    // by their distance from the player.
    let visibleFleet = 0;
    // #736 — telemetry rows are reused, one per visible slot.
    const fleetTelemetry = telemetry.fleet.members;
    const fleetPhase = phase;
    const fleetAmp = strokeAmplitude(rideFrame);
    for (let i = 0; i < fleetMembers.length && visibleFleet < FLEET_INSTANCE_CAPACITY; i += 1) {
      const member = fleetMembers[i];
      let relative = member.distanceMeters - boatPlacement.distanceMeters;
      const half = totalDistanceMeters / 2;
      if (relative > half) relative -= totalDistanceMeters;
      else if (relative < -half) relative += totalDistanceMeters;
      const fade = fleetFadeFor(relative);
      if (fade <= 0) continue;
      // #757 VP-33 — not behind the start or past the finish of a route
      // that does not loop.
      if (!fleetMemberOnCourse(relative, boatPlacement.distanceMeters, totalDistanceMeters, !!rideFrame?.loop)) continue;
      const slot = visibleFleet;
      visibleFleet += 1;
      const syntheticFrame = fleetFrameScratch;
      syntheticFrame.distanceMeters = member.distanceMeters;
      syntheticFrame.elapsedSeconds = frame.time;
      placeBoat(
        fleetPlacements[slot],
        routeCurve,
        syntheticFrame,
        totalDistanceMeters,
        curveLength,
        member.laneOffsetMeters,
      );
      const tint = fleetTints[slot];
      tint.set(fleetHullTintFor(member.seed, fleetExcludeIndex));
      const strokeOffset = fleetStrokeOffset(member.seed);
      const row = fleetTelemetry[slot] ?? (fleetTelemetry[slot] = {
        crew: member.crew,
        hullColor: [0, 0, 0],
        strokeOffset: 0,
        lane: 0,
        distanceMeters: 0,
        fade: 0,
      });
      row.crew = member.crew;
      row.hullColor[0] = tint[0];
      row.hullColor[1] = tint[1];
      row.hullColor[2] = tint[2];
      row.strokeOffset = strokeOffset;
      row.lane = member.laneOffsetMeters;
      row.distanceMeters = member.distanceMeters;
      row.fade = fade;
      if (scullLoaded) {
        // #713 — the member rows the scull of its own crew (D2a): the
        // player's when it matches, else the other one, if that loaded.
        const ownCrew = member.crew === playerCrew || boatScullAltPrimitives.length === 0;
        const prims = ownCrew ? boatScullPrimitives : boatScullAltPrimitives;
        const memberCrew = ownCrew ? playerCrew : member.crew;
        const place = fleetPlacements[slot];
        const trs = scullBoatTrs(fleetScullTrs[slot], place.world, place.heading);
        // D4a — the player's stroke, shifted by the member's own offset.
        const memberSweep = oarSweep(memberCrew, (fleetPhase + strokeOffset) % 1, fleetAmp);
        const memberPose = scullPoseScratch.fleet;
        memberPose.boatTrs = trs;
        memberPose.sweep = memberSweep;
        memberPose.stroke = crewStrokePose(memberCrew, memberSweep);
        const sharesPlayerColors = prims === boatScullPrimitives;
        for (const prim of prims) {
          if (!prim.fleetVisible) continue;
          const inst = prim.fleet[slot] ?? (prim.fleet[slot] = scullInstance());
          scullPrimitiveTransform(inst.model, prim, memberPose);
          inst.alpha = fade;
          inst.tint = fleetPrimitiveTint(prim, tint, sharesPlayerColors, inst.tint);
          prim.instances.push(inst);
        }
      }
      tint[3] *= fade;
      boatPass.fleet[slot].write(device, {
        model: fleetPlacements[slot].modelMatrix,
        bones: fleetBones,
        tintRGBA: tint,
        ghost: false,
        visible: true,
      });
    }
    // #713 FR1 — with the scull loaded the placeholder fleet is only the
    // fallback, as it is for the player and the ghost.
    boatPass.fleetVisibleCount.value = scullLoaded ? 0 : visibleFleet;
    telemetry.fleet.model = visibleFleet === 0 ? 'none' : scullLoaded ? 'scull' : 'placeholder';
    fleetTelemetry.length = visibleFleet;
    if (scullLoaded) {
      for (const prim of boatScullPrimitives) sceneryMeshPass.setInstances(prim.id, prim.instances);
      for (const prim of boatScullAltPrimitives) sceneryMeshPass.setInstances(prim.id, prim.instances);
      sceneryMeshPass.flushInstanceGroups();
    }

    telemetry.boat.x = boatPlacement.world[0];
    telemetry.boat.y = boatPlacement.world[1];
    telemetry.boat.z = boatPlacement.world[2];
    // #742 FR6 — the surface under the hull, every frame.
    telemetry.clearance.surface = surfaceAt(routeWater, surfaceLakes, boatPlacement.world[0], boatPlacement.world[2]);
    // #737 FR4 — blade clearance against the ribbon's nearer shore.
    recordClearance(telemetry.clearance, routeWater.shoreDistance(boatPlacement.world[0], boatPlacement.world[2]));
    telemetry.boat.heading = boatPlacement.heading;
    telemetry.boat.distanceMeters = boatPlacement.distanceMeters;
    telemetry.boat.progress = boatPlacement.progress;
    telemetry.boat.holding = !!rideFrame?.holdBoat;
    telemetry.boat.finished = !!rideFrame?.finished;
    telemetry.boat.isPlaying = !!rideFrame?.isPlaying;

    let speedMps = 0;
    if (!telemetry.boat.holding && !telemetry.boat.finished && telemetry.boat.isPlaying) {
      if (lastSpeedTime >= 0) {
        const dt = Math.max(1e-3, frame.time - lastSpeedTime);
        const dd = telemetry.boat.distanceMeters - lastDistanceMeters;
        speedMps = Math.max(0, dd / dt);
      }
    }
    lastDistanceMeters = telemetry.boat.distanceMeters;
    lastSpeedTime = frame.time;
    publishSpeedMps(telemetry, speedMps);
    streamSpeedMps = speedMps;
    telemetry.pos.x = boatPlacement.world[0];
    telemetry.pos.y = boatPlacement.world[1];
    telemetry.pos.z = boatPlacement.world[2];
    telemetry.pos.progress = boatPlacement.progress;
    telemetry.crew.cadenceSpm = Math.max(0, rideFrame?.cadence ?? 0);
    telemetry.crew.strokePhase = phase;
    telemetry.crew.amplitude = amp;
    telemetry.crew.rowers = 1;
    if (ghostInfo) {
      telemetry.ghostMeters.value = ghostInfo.metres;
      telemetry.ghostMeters.active = true;
    } else {
      telemetry.ghostMeters.value = 0;
      telemetry.ghostMeters.active = false;
    }
    // #728 FR1 telemetry: what the ghost is drawn with, and its stroke.
    telemetry.ghostMeters.model = !ghostInfo ? 'none' : boatScullMeshIds.length > 0 ? 'scull' : 'placeholder';
    telemetry.ghostMeters.cadenceSpm = ghostRowing ? ghostRow.cadence : 0;
    telemetry.ghostMeters.strokePhase = ghostPhase;
    telemetry.ghostMeters.lane = -GHOST_LANE_OFFSET_M;

    const { camBoat, camTangent, camSample, up, camForward, lightDirection } = frameScratch;
    camBoat[0] = boatPlacement.world[0];
    camBoat[1] = boatPlacement.world[1];
    camBoat[2] = boatPlacement.world[2];
    routeCurve.sample(boatPlacement.progress, camSample);
    camTangent[0] = camSample.tangent[0];
    camTangent[1] = camSample.tangent[1];
    camTangent[2] = camSample.tangent[2];
    // FR5 — the side camera sits on the outside of the bend 30 m ahead.
    {
      const lengthM = routeCurve.lengthMeters;
      const step = lengthM > 0 ? 30 / lengthM : 0;
      let ahead = boatPlacement.progress + step;
      ahead = isSceneryRoute(opts.route) && opts.route.isClosedLoop ? ahead % 1 : Math.min(1, ahead);
      routeCurve.sample(ahead, bendAhead);
      cameraBendSign = bendSignFromTangents(camTangent, bendAhead.tangent, cameraBendSign);
    }
    const cameraDt = lastCameraTime < 0 ? 0 : frame.time - lastCameraTime;
    lastCameraTime = frame.time;
    stepCameraRig(cameraRig, {
      boat: camBoat,
      tangent: camTangent,
      velocityMps: speedMps,
      view: rideFrame?.view ?? 'chase',
      bendSign: cameraBendSign,
      ceilingAt,
      dt: cameraDt,
      aspect: height > 0 ? width / height : 1,
      reducedMotion: reducedMotionQuery?.matches ?? false,
      // A spec's seek teleports the boat; the camera goes with it.
      snap: seekMeters !== null,
    });
    const eye = cameraRig.applied.position;
    const target = cameraRig.applied.lookAt;
    mat4LookAt(frame.view, eye, target, up);
    const fovY = (cameraRig.applied.fov * Math.PI) / 180;
    projectionWithInsets(frame.proj, fovY, width, height, viewportInsets, CAMERA_NEAR_M, CAMERA_FAR_M);
    mat4Multiply(frame.viewProj, frame.proj, frame.view);
    // #733 VP-15 FR3 telemetry: where the player boat lands on screen, and
    // the area the HUD leaves clear, so a spec can check one is inside the
    // other in every camera view.
    {
      const c = Math.cos(boatPlacement.heading);
      const sn = Math.sin(boatPlacement.heading);
      const bx = boatPlacement.world[0];
      const by = boatPlacement.world[1];
      const bz = boatPlacement.world[2];
      const pts = BOAT_FOOTPRINT.map(
        ([x, y, z]) => [bx + c * x + sn * z, by + y, bz - sn * x + c * z] as [number, number, number],
      );
      telemetry.boat.screenBounds = projectedBounds(frame.viewProj, pts, width, height);
      telemetry.boat.clearRect = clearRect(width, height, viewportInsets);
    }
    // #728 FR2 — the ghost's marker past 30 m, for the host to draw.
    {
      const marker: GhostMarker | null = ghostInfo
        ? ghostMarker({
            ghostWorld: [ghostPlacement.world[0], ghostPlacement.world[1], ghostPlacement.world[2]],
            gapMeters: gapMeters(boatPlacement.distanceMeters, ghostInfo.metres),
            viewProj: frame.viewProj,
            width,
            height,
          })
        : null;
      telemetry.ghostMeters.marker = marker;
      // FR2 spec seam: the ghost's box on screen, as for the player boat.
      if (ghostInfo) {
        const c = Math.cos(ghostPlacement.heading);
        const sn = Math.sin(ghostPlacement.heading);
        const [gx, gy, gz] = [ghostPlacement.world[0], ghostPlacement.world[1], ghostPlacement.world[2]];
        const pts = BOAT_FOOTPRINT.map(
          ([x, y, z]) => [gx + c * x + sn * z, gy + y, gz - sn * x + c * z] as [number, number, number],
        );
        telemetry.ghostMeters.screenBounds = projectedBounds(frame.viewProj, pts, width, height);
      } else {
        telemetry.ghostMeters.screenBounds = null;
      }
      const key = marker ? `${Math.round(marker.x)},${Math.round(marker.y)},${marker.meters},${marker.ahead}` : '';
      if (key !== ghostMarkerKey) {
        ghostMarkerKey = key;
        opts.onGhostMarker?.(marker);
      }
    }
    frame.camPos[0] = eye[0];
    frame.camPos[1] = eye[1];
    frame.camPos[2] = eye[2];

    packFrameUniforms(frame, uniformScratch);
    device.queue.writeBuffer(frameUniforms, 0, uniformScratch as BufferSource);

    camForward[0] = target[0] - eye[0];
    camForward[1] = target[1] - eye[1];
    camForward[2] = target[2] - eye[2];
    lightDirection[0] = -frame.sunDir[0];
    lightDirection[1] = -frame.sunDir[1];
    lightDirection[2] = -frame.sunDir[2];
    const computed = computeCascades({
      cascades: atlas.cascades,
      near: 0.5,
      far: 400,
      // #733: cover the whole canvas, including what shows through the HUD.
      // #735 FR4: fitted with the FOV actually drawn.
      fovY: effectiveFovY(fovY, height, viewportInsets),
      aspect: width / height,
      camPos: eye,
      camForward,
      camUp: up,
      lightDirection,
      lambda: 0.5,
      tileTexels: atlas.tileSize,
    }, frameScratch.cascades);
    shadowStage.payload.cascadeCount = atlas.cascades;
    for (let i = 0; i < 4; i++) {
      const dst = shadowStage.payload.cascades[i] ?? { viewProj: mat4() };
      shadowStage.payload.cascades[i] = dst;
      if (i < atlas.cascades) {
        dst.viewProj.set(computed.cascades[i].viewProj);
        shadowCpu.cascadeViewProj[i].set(computed.cascades[i].viewProj);
        shadowCpu.cascadeSplits[i] = computed.splits[i] ?? 0;
        shadowCpu.cascadeRadius[i] = computed.cascades[i].radius;
      } else {
        shadowCpu.cascadeViewProj[i].fill(0);
        shadowCpu.cascadeSplits[i] = 0;
        shadowCpu.cascadeRadius[i] = 0;
      }
    }
    shadowCpu.cascadeCount = atlas.cascades;
    packShadowUniforms(shadowCpu, shadowScratch);
    device.queue.writeBuffer(shadowUniformsBuf, 0, shadowScratch as BufferSource);
    // #736 — written in place rather than a new array a frame.
    const lastSplits = telemetry.shadows.lastSplits;
    lastSplits.length = computed.splits.length;
    for (let i = 0; i < computed.splits.length; i += 1) lastSplits[i] = computed.splits[i];

    const outputTexture = context.getCurrentTexture();
    const outputView = outputTexture.createView();
    const sceneView = sceneTexture.createView();
    const depthView = depthTexture.createView();
    graph.run(device, sceneView, depthView, pixelWidth, pixelHeight, frame, outputView);
    if (pixelProbe?.pending) pixelProbe.capture(outputTexture);

    telemetry.frameStats.frame += 1;
    telemetry.frameStats.dtMs = realDtMs;
    // FR6: what the simulation stepped by. The first frame back from a
    // hidden tab restarts the clocks, so it steps by nothing.
    telemetry.frameStats.simDtMs = resuming ? 0 : Math.min(realDtMs, SIM_DT_CLAMP_MS);
    if (!resuming && realDtMs > 0) recordFrameDt(pacing, realDtMs);
    summariseFramePacing(pacing, telemetry.framePacing);
    telemetry.frameStats.cpuMs = now() - cpuStart;
    // #584 AC3: the GPU-side frame time, read back one frame behind by the
    // timer's bracket passes. Stays 0 when the adapter has no `timestamp-query`.
    telemetry.frameStats.gpuMs = gpuTimer?.gpuMs ?? 0;
    let draws = 0;
    let otherPasses = 0;
    for (const p of graph.passes) {
      if (p.name.startsWith('shadow')) continue;
      if (p.name === 'postfx') continue;
      if (p.name === 'boat' && !boatPass.boatVisible.value && !boatPass.ghostVisible.value) continue;
      draws += 1;
      if (!GROUPED_PASSES.has(p.name)) otherPasses += 1;
    }
    // #737 FR2 — this frame's counts, by group; cumulative ones in total*.
    assembleRenderStats(telemetry.renderStats, {
      passes: draws,
      sceneryDispatch: telemetry.scenery.dispatchCount,
      sceneryMesh: sceneryMeshPass.stats,
      sprites: { draws: telemetry.scenery.spriteDraws, pools: telemetry.scenery.pools },
      buildings: telemetry.buildings,
      shadows: telemetry.shadows,
      shadowAtlasBytes: telemetry.shadows.atlasBytes,
    });
    // #737 FR3 — the debug panel's frame cost and pacing, against the tier's budget.
    writePanelStats(panelStats, {
      stats: telemetry.renderStats,
      pacing: telemetry.framePacing,
      tier: opts.tier,
      otherPasses,
      now: Date.now(),
    });
    recordRenderStats(panelStats);
    let trees = 0;
    let meshes = 0;
    let treesDrawn = 0;
    let treesRead = false;
    for (const p of telemetry.scenery.pools) {
      if (p.kind !== 'foliage') continue;
      trees += p.instanceCount;
      meshes += 1;
      if (p.drawn >= 0) {
        treesDrawn += p.drawn;
        treesRead = true;
      }
    }
    telemetry.foliage.trees = trees;
    telemetry.foliage.meshes = meshes;
    // #737 FR4 — what the GPU cull kept, read back every few frames; −1
    // until the first read lands.
    telemetry.foliage.drawn = treesRead ? treesDrawn : meshes === 0 ? 0 : -1;
    telemetry.camera.x = eye[0];
    telemetry.camera.y = eye[1];
    telemetry.camera.z = eye[2];
    telemetry.camera.lookX = target[0];
    telemetry.camera.lookY = target[1];
    telemetry.camera.lookZ = target[2];
    telemetry.camera.fov = cameraRig.applied.fov;
    {
      const ceiling = ceilingAt(eye[0], eye[2]);
      telemetry.camera.ceiling = Number.isFinite(ceiling) ? ceiling : null;
    }
  };

  // Lazy flora atlas load (#562 FR2 / FR3). The decoder lives in its own
  // chunk — the engine's main chunk doesn't pull it unless a KTX2 asset is
  // actually fetched. The texture itself is published to telemetry so the
  // smoke can read atlasKind + atlasBytes without a GPU readback.
  type AtlasHandle = Awaited<ReturnType<typeof loadFloraAtlas>>;
  let atlasHandle: AtlasHandle | null = null;
  void loadFloraAtlas(device, opts.tier, {
    url: assetUrl('/assets/flora/atlas'),
    pngWidth: 512,
    pngHeight: 512,
  })
    .then((handle) => {
      if (disposed) {
        handle.texture.dispose();
        return;
      }
      atlasHandle = handle;
      opts.onLoadPhase?.('atlas', 'done');
      telemetry.textures.atlasKind = handle.kind;
      telemetry.textures.transcodedMs = handle.transcodedMs;
      telemetry.textures.mipsGenerated = handle.texture.mipLevelCount;
      const bytesFmt = handle.kind === 'ktx2' ? 'bc7-rgba-unorm-srgb' : 'rgba8unorm-srgb';
      telemetry.textures.atlasBytes = textureBytes(
        handle.texture.width,
        handle.texture.height,
        bytesFmt,
        handle.texture.mipLevelCount,
      );
    })
    .catch(() => {
      telemetry.textures.atlasKind = 'placeholder';
      if (!disposed) opts.onLoadPhase?.('atlas', 'failed');
    });

  const setAppearance = (palette: CrewPalette): void => {
    currentAppearance = palette;
    for (const prim of boatScullPrimitives) {
      // #736 FR4 — hair and hat visibility only change with the palette.
      prim.visible = isCrewNodeVisible(prim.nodeName, palette);
      if (!prim.slot || !prim.authoredColors) continue;
      const tinted = tintPrimitiveColors(prim.authoredColors, prim.slot, palette);
      sceneryMeshPass.writeColors(prim.id, tinted);
    }
  };

  // #578 FR2 — expose the seam on a window global so an attach caller
  // without a scene reference (the Svelte picker in a sibling component)
  // can still push a palette change. Gated to Playwright + the shell's
  // own useRowerAppearance effect; a stray page cannot reach into the
  // engine without discovering the key.
  const SET_APPEARANCE_KEY = '__ROWER3D_SET_APPEARANCE' as const;
  try {
    (globalThis as unknown as Record<string, unknown>)[SET_APPEARANCE_KEY] = setAppearance;
  } catch { /* non-browser (SSR) — the shell never calls it there anyway */ }

  const setViewportInsets = (insets: unknown): void => {
    if (disposed) return;
    viewportInsets = sanitiseInsets(insets);
  };

  const setConditions = (conditions: unknown): void => {
    if (disposed || !isLightingConditions(conditions)) return;
    applyLighting(conditionsToFrameLighting(conditions));
    telemetry.conditions.updates += 1;
  };
  // #730 — the same seam for specs that switch conditions mid-row. The
  // shell goes through `RideRenderer.setConditions`; this is for tests.
  const SET_CONDITIONS_KEY = '__ROWER3D_SET_CONDITIONS' as const;
  const HIDE_GHOST_KEY = '__ROWER3D_HIDE_GHOST' as const;
  const GHOST_MASK_KEY = '__ROWER3D_GHOST_MASK' as const;
  const PLAYER_MASK_KEY = '__ROWER3D_PLAYER_MASK' as const;
  const HOLD_FRAME_KEY = '__ROWER3D_HOLD_FRAME' as const;
  const SEEK_METERS_KEY = '__ROWER3D_SEEK_METERS' as const;
  const READ_PIXELS_KEY = '__ROWER3D_READ_PIXELS' as const;
  const SCENERY_CLEARANCE_KEY = '__ROWER3D_SCENERY_CLEARANCE' as const;
  if (opts.testMode) {
    try {
      // #761 — read by scenery-clearance.spec.ts.
      (globalThis as unknown as Record<string, unknown>)[SCENERY_CLEARANCE_KEY] = sceneryClearance;
      // #807 — draw a frame and sample its pixels from the GPU.
      (globalThis as unknown as Record<string, unknown>)[READ_PIXELS_KEY] = (grid = 20, minBrightness = 15) => {
        const result = pixelProbe!.request(grid, minBrightness);
        frameOnce();
        return result;
      };
      (globalThis as unknown as Record<string, unknown>)[SET_CONDITIONS_KEY] = setConditions;
      (globalThis as unknown as Record<string, unknown>)[HIDE_GHOST_KEY] = (hidden: boolean) => {
        ghostHidden = !!hidden;
      };
      (globalThis as unknown as Record<string, unknown>)[GHOST_MASK_KEY] = (on: boolean) => {
        ghostMask = !!on;
      };
      (globalThis as unknown as Record<string, unknown>)[PLAYER_MASK_KEY] = (on: boolean) => {
        playerMask = !!on;
      };
      (globalThis as unknown as Record<string, unknown>)[HOLD_FRAME_KEY] = (on: boolean) => {
        holdFrame = !!on;
      };
      (globalThis as unknown as Record<string, unknown>)[SEEK_METERS_KEY] = (metres: number | null) => {
        seekMeters = typeof metres === 'number' && Number.isFinite(metres) ? Math.max(0, metres) : null;
      };
    } catch { /* non-browser */ }
  }
  // Reference so a build-time dead-code pass doesn't drop the helper:
  void flatPrimitiveColors;

  // #726 FR1 — the first frame the player sees already holds every model
  // with an instance within the start window, so nothing arrives on screen
  // in the opening seconds. They register here, all at once and without a
  // fade: the loading bar is still up. One still loading after
  // START_SCENERY_TIMEOUT_MS joins the stream queue and fades in (FR3).
  let firstFrameDrawn = false;
  const frameOnce = (): void => {
    drawFrame();
    if (firstFrameDrawn || disposed) return;
    firstFrameDrawn = true;
    const failed = new Set(telemetry.scenery.failedIds);
    telemetry.scenery.registeredAtFirstFrame = [...sceneryLoaded].filter((id) => !failed.has(id));
    opts.onLoadPhase?.('frame', 'done');
  };
  opts.onLoadPhase?.('scene', 'done');
  const nearStartIds = sceneryModelsToLoad(sceneryPlan, new Set(), 0, streamLookaheadMeters(0), Infinity);
  telemetry.scenery.nearStartIds = nearStartIds;
  const nearStart = Promise.all(
    nearStartIds.map(async (id) => {
      sceneryLoading.add(id);
      try {
        const decoded = await loadSceneryModel(id);
        if (disposed) return;
        if (firstFrameDrawn) {
          sceneryRegistrations.push({ id, decoded });
          return;
        }
        registerSceneryModel(id, decoded);
        sceneryMeshPass.setInstances(id, sceneryInstanceMats.get(id) ?? []);
        sceneryLoading.delete(id);
        sceneryLoaded.add(id);
        telemetry.scenery.registered = sceneryLoaded.size - telemetry.scenery.failed;
      } catch {
        sceneryLoading.delete(id);
        sceneryLoaded.add(id);
        if (!telemetry.scenery.failedIds.includes(id)) telemetry.scenery.failedIds.push(id);
        telemetry.scenery.failed = telemetry.scenery.failedIds.length;
      }
    }),
  ).then(() => 'done' as const);
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const nearStatus = await Promise.race([
    nearStart,
    new Promise<'failed'>((resolve) => {
      startTimer = setTimeout(() => resolve('failed'), START_SCENERY_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(startTimer);
  opts.onLoadPhase?.('scenery-near', nearStatus);

  return {
    device,
    frameOnce,
    resume() {
      resumePending = true;
    },
    setAppearance,
    setConditions,
    setViewportInsets,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      graph.dispose();
      gpuTimer?.dispose();
      decoderPool.dispose();
      for (const pool of scenePools) pool.dispose();
      buildingsPool?.dispose();
      postFx.dispose();
      sceneTexture.destroy();
      depthTexture.destroy();
      frameUniforms.destroy();
      lightingUniforms.destroy();
      shadowUniformsBuf.destroy();
      sproutUniforms.destroy();
      atlasHandle?.texture.dispose();
      atlas.dispose();
      try {
        delete (globalThis as unknown as Record<string, unknown>)[SET_APPEARANCE_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[SET_CONDITIONS_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[HIDE_GHOST_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[GHOST_MASK_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[PLAYER_MASK_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[HOLD_FRAME_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[SEEK_METERS_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[READ_PIXELS_KEY];
        delete (globalThis as unknown as Record<string, unknown>)[SCENERY_CLEARANCE_KEY];
      } catch { /* non-browser */ }
      clearPolygonWaterTelemetry();
      clearRenderStats();
      session.dispose();
    },
  };
};
