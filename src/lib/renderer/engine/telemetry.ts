/**
 * Writes the `__ROWER3D_*` globals the engine publishes each frame, keeping
 * the same shapes the three scene's `Rower3D.tsx` and `src/webgpu/health.ts`
 * write on `main` (P2-AC5 of #550 — a schema snapshot diffs this).
 *
 * The UI thread's host leaves these to the engine (no sink callback).
 */

import type { Rower3DSurface } from './surface';
import type { FramePacingSummary } from './framePacing';
import { OAR_REACH_METRES } from './clearance';
import { emptyRenderGroups } from './frameRenderStats';

/** #737 FR2 — one group's share of a frame. */
export interface Rower3DRenderGroup {
  draws: number;
  instances: number;
  triangles: number;
}

/** #737 FR2 — the frame by what drew it; `scene` is the lit groups together. */
export interface Rower3DRenderGroups {
  scene: Rower3DRenderGroup;
  sceneryMesh: Rower3DRenderGroup;
  sprites: Rower3DRenderGroup;
  buildings: Rower3DRenderGroup;
  shadows: Rower3DRenderGroup;
}

/**
 * Every field is this frame's own (#737 FR2) except the `total*` ones,
 * which accumulate since the scene was built. See `frameRenderStats.ts`.
 */
export interface Rower3DRenderStats {
  /** Passes that ran this frame. */
  draws: number;
  /** Alias of `draws` for the legacy spec harness. Kept in sync via a getter. */
  readonly drawCalls: number;
  /** Triangles submitted this frame, scene and shadows. */
  triangles: number;
  /** Instances drawn this frame, scene and shadows. */
  instances: number;
  /**
   * Per-pass counts for scenery (#555 FR6): the cull dispatches, and the
   * sprite + kit-mesh draws and triangles, this frame.
   */
  sceneryDispatch: number;
  sceneryDraws: number;
  sceneryTriangles: number;
  /** #737 FR2 — the scenery counts summed since the scene was built. */
  totalSceneryDispatch: number;
  totalSceneryDraws: number;
  totalSceneryTriangles: number;
  groups: Rower3DRenderGroups;
  /** Shadow stage counts (#559 FR7). */
  shadowDraws: number;
  shadowTriangles: number;
  shadowAtlasBytes: number;
}

export interface Rower3DFrameStats {
  frame: number;
  /** #737 FR1 — the real interval since the previous drawn frame. */
  dtMs: number;
  /**
   * #737 FR6 — the step the simulation took this frame: `dtMs` clamped to
   * 100 ms, and 0 on the first frame back from a hidden tab.
   */
  simDtMs: number;
  /**
   * GPU-side frame time read back from the `timestamp-query` feature when
   * the adapter has it (D6-c of #584 FR3). Zero when the feature is absent.
   */
  gpuMs: number;
  /**
   * CPU-side frame-encode time measured via `performance.now()` around the
   * engine's command-buffer build + submit. Always populated — the fallback
   * for `gpuMs: 0` on an adapter without `timestamp-query` (D6-c of #584 FR3).
   */
  cpuMs: number;
}

export interface Rower3DCamera {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  fov: number;
  /** #724 FR4 — the bridge-deck underside over the camera; null in open sky. */
  ceiling?: number | null;
}

/** #724 — a bridge span as placed: model, world spot, turn, fitted scale and headroom. */
export interface Rower3DSpan {
  id: string;
  x: number;
  z: number;
  rotationY: number;
  scale: number;
  ceiling: number | null;
}

export interface Rower3DContextState {
  /**
   * `lost` is #584 FR1: the current device has signalled `device.lost` and
   * the engine is attempting a reattach. The frame loop stops drawing to
   * the dead device while in `lost`; on retry success it goes back to
   * `ready`, on retry failure it goes to `unavailable` with
   * reason `renderer-unavailable`.
   */
  kind: 'pending' | 'ready' | 'lost' | 'unavailable';
  backend: 'webgpu' | 'webgl' | 'none';
  reason?: string;
}

/**
 * #584 FR1 — user-facing banner the Svelte ride view shows while the engine
 * is handling a device loss. `visible` + `message` map 1:1 to the retired
 * WebGL spec's banner copy (D2-a).
 */
export interface Rower3DBanner {
  visible: boolean;
  message: string;
  /**
   * `restoring` while the engine is attempting a reattach; `failed` once the
   * reattach has run out of tries; empty string outside a loss event.
   */
  variant: '' | 'restoring' | 'failed';
}

export interface Rower3DPos {
  x: number;
  y: number;
  z: number;
  progress: number;
}

export interface Rower3DRoute {
  hasCurve: boolean;
  totalDistance: number;
  curveLength: number;
  builds?: number;
  /** #724 — every bridge span the scene placed. */
  spans?: Rower3DSpan[];
  /** #742 FR3 — progress ranges lying alongside another part of the route. */
  selfParallel?: Array<[number, number]>;
  /** #742 FR3 — scenery and furniture instances not placed because they stood on the route's water. */
  rejectedOnWater?: number;
}

export interface Rower3DClearance {
  /** #737 FR4 — the narrowest blade clearance (metres) over the row so far. */
  min: number;
  /** #737 FR4 — frames that measured one (frames on the route's ribbon). */
  samples: number;
  /** #737 FR4 — this frame's clearance; null off the ribbon (open lake water). */
  current: number | null;
  /** #737 FR4 — centreline to blade tip the clearance is measured from. */
  oarReachM: number;
  /** #742 FR6 — what lies under the boat's hull this frame. */
  surface?: 'water' | 'land';
}

/**
 * Compatible shape with today's `publishFoliage` writes in
 * `src/components/rower3d/foliageComponents.tsx` (`trees`, `meshes`, `drawn`).
 */
export interface Rower3DFoliage {
  trees: number;
  meshes: number;
  drawn: number;
}

/**
 * Per-pool scenery entry (#555 FR6). The engine writes
 * `__ROWER3D_SCENERY = { pools, dispatchCount, drawCount }`.
 */
export interface Rower3DSceneryEntry {
  kind: string;
  speciesIndex: number;
  chunkIndex: number;
  instanceCount: number;
  drawn: number;
}

/** #726 FR3 — one kit model's fade-in, as the shader runs it. */
export interface Rower3DSceneryReveal {
  id: string;
  /** `scenery.frame` on the frame the model registered. */
  registeredAtFrame: number;
  /** `frame.time` (seconds) it registered at. */
  registeredAt: number;
  /** Fade progress this frame, 0..1, before the per-instance distance skip. */
  revealAlpha: number;
}

export interface Rower3DScenery {
  pools: Rower3DSceneryEntry[];
  dispatchCount: number;
  drawCount: number;
  /** Draws split (#562 FR6). `spriteDraws + solidDraws` equals `drawCount`. */
  spriteDraws: number;
  solidDraws: number;
  solidTriangles: number;
  /** #726 FR5 — kit models registered with the mesh pass so far. */
  registered: number;
  /** #726 FR6 — kit models whose fetch or decode failed, and which. */
  failed: number;
  failedIds: string[];
  /** #726 FR3 — frames drawn since the scene was built. */
  frame: number;
  /** #726 FR3 — models streamed in mid-ride, in registration order. */
  reveals: Rower3DSceneryReveal[];
  /** #726 FR1 — models with an instance inside the start window. */
  nearStartIds: string[];
  /** #726 FR1 — models registered when the first frame was drawn; null before it. */
  registeredAtFirstFrame: string[] | null;
}

/**
 * Texture-pipeline telemetry (#562 FR2 / FR3). Written once per attach when
 * the flora atlas resolves; carries the atlas kind (ktx2 / png / placeholder),
 * the uploaded GPU footprint and the transcode cost. Published as
 * `__ROWER3D_TEXTURES`.
 */
export interface Rower3DTextures {
  atlasKind: 'ktx2' | 'png' | 'placeholder' | 'pending';
  atlasBytes: number;
  mipsGenerated: number;
  transcodedMs: number;
}

/** Shadow telemetry (#559 FR7). */
export interface Rower3DShadows {
  cascades: number;
  atlasSize: number;
  drawsPerCascade: number;
  lastSplits: number[];
  draws: number;
  triangles: number;
  /** #737 FR2 — instances drawn into the cascades this frame. */
  instances: number;
  atlasBytes: number;
}

/**
 * Buildings telemetry (#566 FR1/FR4, AC8). `pool` is the resident
 * instance count on the pool buffer, `drawn` the number issued this frame
 * (no per-building cull in P6 so these match), `triangles` the resulting
 * primitive count, and `footprintM2` the sum of `halfWidth*halfDepth*4` for
 * the route — the AC6 memory check uses it together with `instances *
 * BUILDINGS_FLOATS_PER_INSTANCE * 4` as the resident bound.
 */
export interface Rower3DBuildings {
  routes: number;
  drawn: number;
  pool: number;
  triangles: number;
  footprintM2: number;
  resident: boolean;
  cast: boolean;
}

/**
 * Boat telemetry (#570 FR6 / AC1). Published as `__ROWER3D_BOAT`. Carries
 * the per-frame world placement + the derived progress; the HUD reads this
 * to decide the finish ribbon and the camera to decide where to look.
 */
export interface Rower3DBoat {
  x: number;
  y: number;
  z: number;
  heading: number;
  distanceMeters: number;
  progress: number;
  holding: boolean;
  finished: boolean;
  isPlaying: boolean;
  /** Which boat-mesh buffer the engine is drawing (#570 D1-b, extended
   *  in #623 Phase 1 so the user-facing path can report `'failed'`
   *  instead of silently drawing the procedural stub — see D4-a). */
  meshSource: 'baked' | 'procedural' | 'failed';
  /**
   * #733 VP-15 — the player boat on screen (bow, stern, both blade tips and
   * the rower's head), in CSS px of the canvas, or null before the first
   * frame or when part of it is behind the camera.
   */
  screenBounds: { left: number; top: number; right: number; bottom: number } | null;
  /** #733 VP-15 — the canvas area the HUD leaves clear, in CSS px. */
  clearRect: { left: number; top: number; right: number; bottom: number };
}

/**
 * Crew telemetry (#570 FR6 / AC5). Published as `__ROWER3D_CREW`. Carries
 * the stroke driver outputs so a spec can assert the crew is moving at
 * cadence.
 */
export interface Rower3DCrew {
  cadenceSpm: number;
  strokePhase: number;
  amplitude: number;
  rowers: number;
}

/**
 * Ghost metres (#570 FR6). Published as `__ROWER3D_GHOST_METERS`. Zero
 * when there is no ghost or `elapsedSeconds <= 0`.
 */
export interface Rower3DGhostMetersHandle {
  value: number;
  active: boolean;
  /** #728 FR1 — what the ghost is drawn with this frame. */
  model?: 'scull' | 'placeholder' | 'none';
  /** #728 FR1 — the ghost's own stroke rate while it rows, else 0. */
  cadenceSpm?: number;
  strokePhase?: number;
  /** #728 FR3 — the ghost's lateral offset, metres (negative = port). */
  lane?: number;
  /** #728 FR2 — the marker over a ghost more than 30 m away, or null. */
  marker?: { x: number; y: number; meters: number; ahead: boolean } | null;
  /** #728 FR2 — the ghost's CSS-px box on the canvas, or null. */
  screenBounds?: { left: number; top: number; right: number; bottom: number } | null;
}

/**
 * The fleet (#713). Published as `__ROWER3D_FLEET`: what each visible
 * member is drawn with this frame.
 */
export interface Rower3DFleet {
  model: 'scull' | 'placeholder' | 'none';
  members: {
    crew: 'male' | 'female';
    /** The member's hull colour, linear rgb (D3a). */
    hullColor: number[];
    /** Its share of a stroke ahead of the player's phase (D4a). */
    strokeOffset: number;
    lane: number;
    distanceMeters: number;
    fade: number;
  }[];
}

/**
 * Boat speed (#570 — world-scale spec reads `__ROWER3D_SPEED_MPS`). The
 * engine computes this from the per-frame `distanceMeters` delta divided by
 * frame dt; zero when the boat is holding (`holdBoat`) or paused.
 */
export interface Rower3DSpeedHandle {
  value: number;
}

/**
 * Conditions telemetry (#730 VP-12 FR5). Published as
 * `__ROWER3D_CONDITIONS`: the lighting the engine applied for the rower's
 * Dawn / Midday / Golden hour / Overcast / Dusk choice, or `default` when
 * the shell passed none. `updates` counts live switches since attach.
 */
export interface Rower3DConditions {
  name: string;
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  sunDir: number[];
  sunDisc: number;
  cloudCover: number;
  shadowStrength: number;
  exposureBias: number;
  fogDensityScale: number;
  skyZenith: number[];
  skyHorizon: number[];
  updates: number;
}

export interface TelemetryHandles {
  renderStats: Rower3DRenderStats;
  frameStats: Rower3DFrameStats;
  /** #737 FR3 — `__ROWER3D_FRAME_PACING`, refreshed every few frames. */
  framePacing: FramePacingSummary;
  camera: Rower3DCamera;
  contextState: Rower3DContextState;
  pos: Rower3DPos;
  route: Rower3DRoute;
  clearance: Rower3DClearance;
  foliage: Rower3DFoliage;
  scenery: Rower3DScenery;
  shadows: Rower3DShadows;
  textures: Rower3DTextures;
  buildings: Rower3DBuildings;
  boat: Rower3DBoat;
  crew: Rower3DCrew;
  ghostMeters: Rower3DGhostMetersHandle;
  fleet: Rower3DFleet;
  speed: Rower3DSpeedHandle;
  banner: Rower3DBanner;
  conditions: Rower3DConditions;
  /** #731 VP-13 FR4 — `__ROWER3D_SURFACE`: CSS and backing size, scale, AA. */
  surface: Rower3DSurface;
}

// Keep this a mutable record view of `window`: on `main` these globals carry
// WebGL-flavoured shapes from `src/lib/types/index.ts`; the engine's shapes
// land here as the P1/P2 cutover removes the three scene. Using a record view
// avoids a declaration-merging duel between the two shapes while the React
// scene is still on the branch.
type Win = Record<string, unknown>;

const win = (): Win | undefined => {
  const w = (globalThis as unknown as { window?: Win }).window;
  return w;
};

export const createTelemetry = (forceRender: () => void): TelemetryHandles => {
  // `drawCalls` is a read-only alias of `draws` for the legacy spec harness
  // (route-loading-progress.spec reads `__ROWER3D_RENDER_STATS.drawCalls`).
  // A getter keeps it in sync without every per-frame writer having to set
  // two fields.
  const renderStats = {
    draws: 0,
    triangles: 0,
    instances: 0,
    sceneryDispatch: 0,
    sceneryDraws: 0,
    sceneryTriangles: 0,
    totalSceneryDispatch: 0,
    totalSceneryDraws: 0,
    totalSceneryTriangles: 0,
    groups: emptyRenderGroups(),
    shadowDraws: 0,
    shadowTriangles: 0,
    shadowAtlasBytes: 0,
  } as Omit<Rower3DRenderStats, 'drawCalls'>;
  Object.defineProperty(renderStats, 'drawCalls', {
    enumerable: true,
    get() {
      return (this as { draws: number }).draws;
    },
  });
  const handles: TelemetryHandles = {
    renderStats: renderStats as Rower3DRenderStats,
    frameStats: { frame: 0, dtMs: 0, simDtMs: 0, gpuMs: 0, cpuMs: 0 },
    framePacing: { samples: 0, p50: 0, p95: 0, p99: 0, max: 0, over25ms: 0, over50ms: 0, longestStallMs: 0 },
    camera: { x: 0, y: 0, z: 0, lookX: 0, lookY: 0, lookZ: 0, fov: 58 },
    contextState: { kind: 'pending', backend: 'none' },
    surface: { cssWidth: 0, cssHeight: 0, devicePixelRatio: 1, scale: 1, width: 0, height: 0, antialias: 'none' },
    pos: { x: 0, y: 0, z: 0, progress: 0 },
    route: { hasCurve: false, totalDistance: 0, curveLength: 0 },
    clearance: { min: 0, samples: 0, current: null, oarReachM: OAR_REACH_METRES },
    foliage: { trees: 0, meshes: 0, drawn: 0 },
    scenery: {
      pools: [],
      dispatchCount: 0,
      drawCount: 0,
      spriteDraws: 0,
      solidDraws: 0,
      solidTriangles: 0,
      registered: 0,
      failed: 0,
      failedIds: [],
      frame: 0,
      reveals: [],
      nearStartIds: [],
      registeredAtFirstFrame: null,
    },
    shadows: {
      cascades: 0,
      atlasSize: 0,
      drawsPerCascade: 0,
      lastSplits: [],
      draws: 0,
      triangles: 0,
      instances: 0,
      atlasBytes: 0,
    },
    textures: { atlasKind: 'pending', atlasBytes: 0, mipsGenerated: 0, transcodedMs: 0 },
    buildings: {
      routes: 0,
      drawn: 0,
      pool: 0,
      triangles: 0,
      footprintM2: 0,
      resident: false,
      cast: false,
    },
    boat: {
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      distanceMeters: 0,
      progress: 0,
      holding: false,
      finished: false,
      isPlaying: false,
      meshSource: 'procedural',
      screenBounds: null,
      clearRect: { left: 0, top: 0, right: 0, bottom: 0 },
    },
    crew: { cadenceSpm: 0, strokePhase: 0, amplitude: 0, rowers: 1 },
    ghostMeters: { value: 0, active: false },
    fleet: { model: 'none', members: [] },
    speed: { value: 0 },
    banner: { visible: false, message: '', variant: '' },
    conditions: {
      name: 'default',
      sunElevationDeg: 0,
      sunAzimuthDeg: 0,
      sunDir: [0, 1, 0],
      sunDisc: 1,
      cloudCover: 0,
      shadowStrength: 1,
      exposureBias: 0,
      fogDensityScale: 1,
      skyZenith: [0, 0, 0],
      skyHorizon: [0, 0, 0],
      updates: 0,
    },
  };
  const w = win();
  if (w) {
    w['__ROWER3D_RENDER_STATS'] = handles.renderStats;
    w['__ROWER3D_FRAME_STATS'] = handles.frameStats;
    w['__ROWER3D_FRAME_PACING'] = handles.framePacing;
    w['__ROWER3D_CAMERA'] = handles.camera;
    w['__ROWER3D_CONTEXT_STATE'] = handles.contextState;
    w['__ROWER3D_SURFACE'] = handles.surface;
    w['__ROWER3D_POS'] = handles.pos;
    w['__ROWER3D_ROUTE'] = handles.route;
    w['__ROWER3D_CLEARANCE'] = handles.clearance;
    w['__ROWER3D_FORCE_RENDER'] = forceRender;
    w['__ROWER3D_GPU_BACKEND'] = 'webgpu';
    w['__ROWER3D_FOLIAGE'] = handles.foliage;
    w['__ROWER3D_SCENERY'] = handles.scenery;
    w['__ROWER3D_SHADOWS'] = handles.shadows;
    w['__ROWER3D_TEXTURES'] = handles.textures;
    w['__ROWER3D_BUILDINGS'] = handles.buildings;
    w['__ROWER3D_BOAT'] = handles.boat;
    w['__ROWER3D_CREW'] = handles.crew;
    w['__ROWER3D_GHOST_METERS'] = handles.ghostMeters;
    w['__ROWER3D_FLEET'] = handles.fleet;
    // Speed is published as a scalar so the legacy world-scale spec can
    // read it with a simple compare; the engine re-assigns the global each
    // frame via `publishSpeedMps` below.
    w['__ROWER3D_SPEED_MPS'] = 0;
    // #584 FR1 — the Svelte ride view reads this to render the user-facing
    // "lost the graphics context" / "restoring" / "could not get it back"
    // banner. The engine owns the message copy (D2-a).
    w['__ROWER3D_BANNER'] = handles.banner;
    w['__ROWER3D_CONDITIONS'] = handles.conditions;
  }
  return handles;
};

/**
 * Write the per-frame boat speed scalar to `window.__ROWER3D_SPEED_MPS`.
 * No-op outside a browser window (SSR, Node unit tests without a global).
 */
export const publishSpeedMps = (handles: TelemetryHandles, speedMps: number): void => {
  handles.speed.value = speedMps;
  const w = win();
  if (w) w['__ROWER3D_SPEED_MPS'] = speedMps;
};

/** #584 FR1 — set the user-facing banner on a device-loss transition. */
export const publishBanner = (
  handles: TelemetryHandles,
  message: string,
  variant: Rower3DBanner['variant'],
): void => {
  handles.banner.visible = message.length > 0;
  handles.banner.message = message;
  handles.banner.variant = variant;
};

export const releaseTelemetry = (): void => {
  const w = win();
  if (!w) return;
  for (const key of [
    '__ROWER3D_RENDER_STATS',
    '__ROWER3D_FRAME_STATS',
    '__ROWER3D_FRAME_PACING',
    '__ROWER3D_CAMERA',
    '__ROWER3D_CONTEXT_STATE',
    '__ROWER3D_SURFACE',
    '__ROWER3D_POS',
    '__ROWER3D_ROUTE',
    '__ROWER3D_CLEARANCE',
    '__ROWER3D_FORCE_RENDER',
    '__ROWER3D_GPU_BACKEND',
    '__ROWER3D_FOLIAGE',
    '__ROWER3D_SCENERY',
    '__ROWER3D_SHADOWS',
    '__ROWER3D_TEXTURES',
    '__ROWER3D_BUILDINGS',
    '__ROWER3D_BOAT',
    '__ROWER3D_CREW',
    '__ROWER3D_GHOST_METERS',
    '__ROWER3D_FLEET',
    '__ROWER3D_SPEED_MPS',
    '__ROWER3D_BANNER',
    '__ROWER3D_CONDITIONS',
    '__ROWER3D_SET_CONDITIONS',
  ]) {
    delete w[key];
  }
};
