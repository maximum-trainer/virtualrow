import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attach, isSceneryRoute } from '../attach';
import { resetWebGPUHealth } from '../health';
import {
  installGPUStub,
  makeMockAdapter,
  makeMockCanvas,
  makeMockGPU,
} from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';
import { buildSmokeFoliagePools } from '../../plan/instancePools';

type WithTest = {
  _frameOnce: () => void;
  _telemetry: {
    frameStats: { frame: number };
    renderStats: { draws: number; sceneryDraws: number; sceneryDispatch: number };
    scenery: { pools: { kind: string; instanceCount: number }[]; dispatchCount: number; drawCount: number; foliageDraws?: number; landCover?: unknown; relief?: unknown };
    foliage: { trees: number; meshes: number; drawn: number; draws: number };
    contextState: { kind: string; backend: string };
  };
  dispose(): void;
};

beforeEach(() => {
  installGPUStub(makeMockGPU(makeMockAdapter()));
  resetWebGPUHealth();
});

afterEach(() => {
  installGPUStub(undefined);
  releaseTelemetry();
});

describe('attach', () => {
  it('returns null when WebGPU is unavailable', async () => {
    installGPUStub(undefined);
    const canvas = makeMockCanvas();
    const renderer = await attach(canvas);
    expect(renderer).toBeNull();
  });

  it('returns null on a software adapter', async () => {
    installGPUStub(makeMockGPU(makeMockAdapter({ software: true })));
    const canvas = makeMockCanvas();
    const renderer = await attach(canvas);
    expect(renderer).toBeNull();
  });

  it('mounts and draws one frame in testMode', async () => {
    const canvas = makeMockCanvas();
    const renderer = (await attach(canvas, { testMode: true })) as unknown as WithTest;
    expect(renderer).not.toBeNull();
    expect(canvas.getAttribute('data-backend')).toBe('webgpu');
    expect(renderer._telemetry.contextState.kind).toBe('ready');
    const before = renderer._telemetry.frameStats.frame;
    renderer._frameOnce();
    expect(renderer._telemetry.frameStats.frame).toBeGreaterThan(before);
    renderer.dispose();
    expect(canvas.getAttribute('data-backend')).toBeNull();
    // Disposing twice is a no-op.
    renderer.dispose();
  });

  it('waits for the GPU to finish a warm-up frame before it reports ready (#803)', async () => {
    const canvas = makeMockCanvas();
    const renderer = (await attach(canvas, { testMode: true })) as unknown as WithTest & {
      _liveDevice: { __log: { drainedAfterSubmits: number[] } };
    };
    expect(renderer._telemetry.contextState.kind).toBe('ready');
    // The mock GPU drains instantly, so the warm-up draws two frames and
    // waits after each one's submit.
    const drained = renderer._liveDevice.__log.drainedAfterSubmits;
    expect(drained.length).toBeGreaterThanOrEqual(2);
    expect(drained[0]).toBeGreaterThanOrEqual(1);
    expect(drained[1]).toBeGreaterThan(drained[0]);
    renderer.dispose();
  });

  it('keeps drawing behind the loading screen and reports ready only after it has gone (#803)', async () => {
    const canvas = makeMockCanvas();
    let shownChecks = 0;
    const renderer = (await attach(canvas, {
      testMode: true,
      // Covered for the first three checks, gone from the fourth.
      loadingOverlayShown: () => {
        shownChecks += 1;
        return shownChecks <= 3;
      },
    })) as unknown as WithTest & { _liveDevice: { __log: { submits: number } } };
    expect(renderer._telemetry.contextState.kind).toBe('ready');
    expect(shownChecks).toBe(4);
    // Two drain frames, one per covered check, then three settle frames.
    expect(renderer._liveDevice.__log.submits).toBeGreaterThanOrEqual(2 + 3 + 3);
    renderer.dispose();
  });

  it('leaves vr:attach measures for the pipelines and the crew (#729 FR5)', async () => {
    // `vr:attach:atlas` is recorded around the atlas paint + upload, which
    // the mock queue (no writeTexture) skips; foliageAtlasUpload.test.ts
    // covers the upload.
    performance.clearMeasures();
    const renderer = await attach(makeMockCanvas(), { testMode: true });
    for (const phase of ['pipelines', 'crew']) {
      expect(performance.getEntriesByName(`vr:attach:${phase}`, 'measure').length, phase).toBeGreaterThan(0);
    }
    renderer?.dispose();
  });

  it('surfaces renderer-unavailable when getContext returns null', async () => {
    const canvas = makeMockCanvas();
    (canvas as unknown as { getContext(): null }).getContext = () => null;
    const renderer = await attach(canvas);
    expect(renderer).toBeNull();
  });

  it('runs the full colour-pass graph on every frame', async () => {
    const canvas = makeMockCanvas();
    const renderer = (await attach(canvas, { testMode: true })) as unknown as WithTest;
    expect(renderer).not.toBeNull();
    renderer._frameOnce();
    // sky, clouds, bank, buildings, scenery, water, boat, sceneryMesh,
    // wake, oarSplash (#566 added clouds + buildings on medium+; #570
    // added boat; #549 scenery slice added sceneryMesh for GLB course
    // furniture / structures; #571 added wake foam particles + oar-blade
    // splash, both at low+; #623 Phase 1 retired the procedural
    // floraSolid pass — near trees now draw through sceneryMesh). Rain
    // overlay is opt-in (default off) so it is not counted here.
    // #731 FR3 — plus the MSAA depth resolve at medium (the test tier).
    expect(renderer._telemetry.renderStats.draws).toBe(11);
    renderer.dispose();
  });

  it('publishes what the map land cover and terrain put in the scene (#764 FR10, #763 FR9)', async () => {
    const pools = buildSmokeFoliagePools({ speciesCount: 1, chunkCount: 1, perChunk: 1 });
    const landCoverSummary = { classesPresent: [3, 10], woodlandPolygons: 2, treelineInstances: 7, hedgeMetres: 120 };
    const reliefSummary = { runs: 5, placed: 3, maxElevationDeg: 8.5 };
    const withData = (await attach(makeMockCanvas(), {
      testMode: true,
      route: { pools, landCoverSummary, reliefSummary },
    })) as unknown as WithTest;
    expect(withData._telemetry.scenery.landCover).toEqual(landCoverSummary);
    expect(withData._telemetry.scenery.relief).toEqual(reliefSummary);
    withData.dispose();
    const without = (await attach(makeMockCanvas(), { testMode: true, route: { pools } })) as unknown as WithTest;
    expect(without._telemetry.scenery.landCover).toBeNull();
    expect(without._telemetry.scenery.relief).toBeNull();
    without.dispose();
  });

  it('wires scenery pools from a SceneryRoute', async () => {
    const canvas = makeMockCanvas();
    const pools = buildSmokeFoliagePools({ speciesCount: 2, chunkCount: 2, perChunk: 10 });
    const renderer = (await attach(canvas, {
      testMode: true,
      route: { pools },
    })) as unknown as WithTest;
    expect(renderer).not.toBeNull();
    expect(renderer._telemetry.scenery.pools.length).toBeGreaterThanOrEqual(4);
    expect(renderer._telemetry.scenery.dispatchCount).toBeGreaterThan(0);
    expect(renderer._telemetry.foliage.trees).toBe(2 * 2 * 10);
    expect(renderer._telemetry.foliage.meshes).toBe(4);
    // #870 — a draw call only for the pools in view and in range.
    expect(renderer._telemetry.foliage.draws).toBe(renderer._telemetry.scenery.foliageDraws);
    expect(renderer._telemetry.foliage.draws).toBeLessThanOrEqual(4);
    renderer.dispose();
  });

  // #742 VP-22 FR2/FR3 — an out-and-back whose legs run 60 m apart: the
  // gap between them is water, and a tree planted in it is not drawn.
  it('flags the parallel legs and takes scenery off the water between them', async () => {
    const curvePoints: [number, number, number][] = [];
    for (let z = 0; z >= -1000; z -= 50) curvePoints.push([0, 0, z]);
    for (let k = 1; k < 8; k += 1) {
      const a = (k / 8) * Math.PI;
      curvePoints.push([30 - 30 * Math.cos(a), 0, -1000 - 30 * Math.sin(a)]);
    }
    for (let z = -1000; z <= 0; z += 50) curvePoints.push([60, 0, z]);
    const pools = [{
      kind: 'foliage' as const,
      speciesIndex: 0,
      chunkIndex: 0,
      // In the gap between the legs, then well outside both.
      positions: new Float32Array([30, 0, -500, -100, 0, -500]),
      bounds: { cx: 0, cy: 0, cz: -500, radius: 200 },
    }];
    const renderer = (await attach(makeMockCanvas(), {
      testMode: true,
      route: { pools, curvePoints, waterEdgesForProgress: () => ({ left: 10, right: 10 }) },
    })) as unknown as WithTest & {
      _telemetry: {
        route: { selfParallel?: [number, number][]; rejectedOnWater?: number };
        clearance: { surface?: string };
      };
    };
    renderer._frameOnce();
    expect(renderer._telemetry.clearance.surface, 'the surface under the boat (FR6)').toBe('water');
    expect(renderer._telemetry.route.selfParallel?.length ?? 0).toBeGreaterThan(0);
    expect(renderer._telemetry.route.rejectedOnWater).toBe(1);
    expect(renderer._telemetry.foliage.trees).toBe(1);
    renderer.dispose();
  });

  // #726 VP-08 FR6 — a model that fails to load is reported, not swallowed.
  it('reports scenery models whose fetch fails on __ROWER3D_SCENERY', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    try {
      const renderer = (await attach(makeMockCanvas(), {
        testMode: true,
        route: {
          pools: [],
          sceneryGlbs: [{ id: 'a09-gazebo-hexagonal', instances: [{ position: [40, 0, -50], rotationY: 0, scale: 1 }] }],
        },
      })) as unknown as WithTest & {
        _telemetry: { scenery: { failed: number; failedIds: string[]; registered: number } };
      };
      for (let i = 0; i < 20 && renderer._telemetry.scenery.failed === 0; i += 1) {
        renderer._frameOnce();
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(renderer._telemetry.scenery.failedIds).toContain('a09-gazebo-hexagonal');
      expect(renderer._telemetry.scenery.failed).toBe(renderer._telemetry.scenery.failedIds.length);
      renderer.dispose();
    } finally {
      globalThis.fetch = original;
    }
  });

  // #726 VP-08 FR3 — a model streamed in mid-ride starts its fade on the
  // frame it registers (reveal alpha 0) and is fully drawn 1.5 s later.
  it('reports each streamed model\'s reveal on __ROWER3D_SCENERY', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const bytes = readFileSync(resolve(process.cwd(), 'public/assets/scenery/tier-a/a01-buoy-lane-sphere.glb'));
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith('/b04-boat-rack-outdoor.glb')) return new Response(bytes);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const renderer = (await attach(makeMockCanvas(), {
        testMode: true,
        // Far past the 600 m start window, so it streams in once the boat
        // has rowed there rather than before the first frame (FR1).
        route: {
          pools: [],
          curvePoints: [[0, 0, 0], [0, 0, -3000]],
          totalDistanceMeters: 3000,
          sceneryGlbs: [{ id: 'b04-boat-rack-outdoor', instances: [{ position: [30, 0, -2000], rotationY: 0, scale: 1 }] }],
        },
        getFrame: () => ({
          paceSPer500: 120,
          distanceMeters: 1900,
          cadence: 20,
          isPlaying: true,
          holdBoat: false,
          finished: false,
          intensityFactor: 1,
          elapsedSeconds: 10,
          ghost: null,
        }),
      })) as unknown as WithTest & {
        _telemetry: {
          scenery: {
            frame: number;
            registered: number;
            reveals: { id: string; registeredAtFrame: number; registeredAt: number; revealAlpha: number }[];
          };
        };
      };
      const scenery = renderer._telemetry.scenery;
      for (let i = 0; i < 40 && scenery.reveals.length === 0; i += 1) {
        renderer._frameOnce();
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(scenery.reveals.map((r) => r.id)).toEqual(['b04-boat-rack-outdoor']);
      const reveal = scenery.reveals[0];
      expect(reveal.registeredAtFrame).toBe(scenery.frame);
      expect(reveal.revealAlpha).toBe(0);
      expect(scenery.registered).toBeGreaterThanOrEqual(1);
      renderer.dispose();
    } finally {
      globalThis.fetch = original;
    }
  });

  // #726 VP-08 FR1 — the first frame already holds every model with an
  // instance within 600 m of the start, and the load reports its phases.
  describe('a fully dressed start (#726 FR1)', () => {
    const serve = async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const bytes = readFileSync(resolve(process.cwd(), 'public/assets/scenery/tier-a/a01-buoy-lane-sphere.glb'));
      return (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes('/assets/scenery/')) return new Response(bytes);
        return new Response(null, { status: 404 });
      }) as typeof fetch;
    };
    const route = {
      pools: [],
      curvePoints: [[0, 0, 0], [0, 0, -3000]] as [number, number, number][],
      totalDistanceMeters: 3000,
      sceneryGlbs: [
        // Nearest instance 300 m in: inside the start window.
        { id: 'b04-boat-rack-outdoor', instances: [{ position: [30, 0, -2000], rotationY: 0, scale: 1 }, { position: [30, 0, -300], rotationY: 0, scale: 1 }] },
        { id: 'b05-quay-wall-stone', instances: [{ position: [-30, 0, -580], rotationY: 0, scale: 1 }] },
        // 1.5 km in: streams in later.
        { id: 'b02-boathouse-uk-victorian', instances: [{ position: [-30, 0, -1500], rotationY: 0, scale: 1 }] },
      ],
    };
    type Scenery = {
      nearStartIds: string[];
      registeredAtFirstFrame: string[] | null;
      reveals: { id: string }[];
    };

    it('registers every model near the start before the first frame, without a fade', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = await serve();
      try {
        const renderer = (await attach(makeMockCanvas(), { testMode: true, route })) as unknown as WithTest & {
          _telemetry: { scenery: Scenery };
        };
        const scenery = renderer._telemetry.scenery;
        // The engine's own course furniture at the start is in the window too.
        expect(scenery.nearStartIds).toContain('b04-boat-rack-outdoor');
        expect(scenery.nearStartIds).toContain('b05-quay-wall-stone');
        expect(scenery.nearStartIds).not.toContain('b02-boathouse-uk-victorian');
        expect([...(scenery.registeredAtFirstFrame ?? [])].sort()).toEqual([...scenery.nearStartIds].sort());
        expect(scenery.reveals, 'models placed before the start do not fade').toEqual([]);
        renderer.dispose();
      } finally {
        globalThis.fetch = original;
      }
    });

    // #753 FR1 — a stake's turn buoy is engine course furniture like the lane buoys.
    it('places a turn buoy at a stake and loads it with the start', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = await serve();
      try {
        const withStake = (await attach(makeMockCanvas(), {
          testMode: true,
          route: { ...route, turnBuoys: [{ x: 15, z: -400 }] },
        })) as unknown as WithTest & { _telemetry: { scenery: Scenery } };
        expect(withStake._telemetry.scenery.nearStartIds).toContain('a02-buoy-turn-cylinder');
        withStake.dispose();
        const without = (await attach(makeMockCanvas(), { testMode: true, route })) as unknown as WithTest & {
          _telemetry: { scenery: Scenery };
        };
        expect(without._telemetry.scenery.nearStartIds).not.toContain('a02-buoy-turn-cylinder');
        without.dispose();
      } finally {
        globalThis.fetch = original;
      }
    });

    it('reports each load phase once, the first frame last', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = await serve();
      const reported: [string, string][] = [];
      try {
        const renderer = (await attach(makeMockCanvas(), {
          testMode: true,
          route,
          onLoadPhase: (phase: string, status: string) => reported.push([phase, status]),
        })) as unknown as WithTest;
        for (let i = 0; i < 20 && !reported.some(([p]) => p === 'atlas'); i += 1) {
          await new Promise((r) => setTimeout(r, 5));
        }
        const phases = reported.map(([p]) => p);
        expect([...phases].sort()).toEqual(['atlas', 'boat', 'crew', 'frame', 'scene', 'scenery-near']);
        expect(phases.indexOf('frame')).toBeGreaterThan(phases.indexOf('scenery-near'));
        expect(phases.indexOf('scenery-near')).toBeGreaterThan(phases.indexOf('scene'));
        expect(reported.find(([p]) => p === 'scenery-near')?.[1]).toBe('done');
        renderer._frameOnce();
        expect(reported.filter(([p]) => p === 'frame')).toHaveLength(1);
        renderer.dispose();
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  it('isSceneryRoute recognises the shape', () => {
    expect(isSceneryRoute({ pools: [] })).toBe(true);
    expect(isSceneryRoute(null)).toBe(false);
    expect(isSceneryRoute({})).toBe(false);
    expect(isSceneryRoute({ pools: 'not-an-array' })).toBe(false);
  });

  describe('crew option', () => {
    const captureBoatFetches = (): { urls: string[] } => {
      const urls: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        urls.push(url);
        // Return a 404 so the engine quietly falls back to the baked boat —
        // we only care about which URL was requested, not GLB bytes.
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      // Patch-cleanup helper the test awaits before restoring.
      (urls as unknown as { restore(): void }).restore = () => {
        globalThis.fetch = original;
      };
      return urls as unknown as { urls: string[] };
    };

    it('decodes the scull through the GLB decoder pool, off the main thread (#729 FR4)', async () => {
      const poolUrls: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        poolUrls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      const renderer = await attach(makeMockCanvas(), { testMode: true, glbDecoderPool: { fetchImpl } } as never);
      expect(poolUrls.some((u) => u.endsWith('/assets/boat/scull-male.glb'))).toBe(true);
      renderer?.dispose();
    });

    it('defaults to scull-male.glb when no crew is passed (unchanged pre-seam behaviour)', async () => {
      const captured = captureBoatFetches() as unknown as string[] & { restore(): void };
      try {
        const canvas = makeMockCanvas();
        const renderer = (await attach(canvas, { testMode: true })) as unknown as WithTest;
        expect(renderer).not.toBeNull();
        const boatRequests = (captured as unknown as string[]).filter((u: string) => u.includes('/assets/boat/'));
        expect(boatRequests.some((u: string) => u.endsWith('/scull-male.glb'))).toBe(true);
        expect(boatRequests.some((u: string) => u.endsWith('/scull-female.glb'))).toBe(false);
        renderer.dispose();
      } finally {
        captured.restore();
      }
    });

    it('fetches scull-female.glb when crew is "female"', async () => {
      const captured = captureBoatFetches() as unknown as string[] & { restore(): void };
      try {
        const canvas = makeMockCanvas();
        const renderer = (await attach(canvas, { testMode: true, crew: 'female' })) as unknown as WithTest;
        expect(renderer).not.toBeNull();
        const boatRequests = (captured as unknown as string[]).filter((u: string) => u.includes('/assets/boat/'));
        expect(boatRequests.some((u: string) => u.endsWith('/scull-female.glb'))).toBe(true);
        expect(boatRequests.some((u: string) => u.endsWith('/scull-male.glb'))).toBe(false);
        renderer.dispose();
      } finally {
        captured.restore();
      }
    });

    it('fetches scull-male.glb when crew is explicitly "male"', async () => {
      const captured = captureBoatFetches() as unknown as string[] & { restore(): void };
      try {
        const canvas = makeMockCanvas();
        const renderer = (await attach(canvas, { testMode: true, crew: 'male' })) as unknown as WithTest;
        expect(renderer).not.toBeNull();
        const boatRequests = (captured as unknown as string[]).filter((u: string) => u.includes('/assets/boat/'));
        expect(boatRequests.some((u: string) => u.endsWith('/scull-male.glb'))).toBe(true);
        expect(boatRequests.some((u: string) => u.endsWith('/scull-female.glb'))).toBe(false);
        renderer.dispose();
      } finally {
        captured.restore();
      }
    });
  });
});

describe('conditions (#730 VP-12)', () => {
  type Cond = { name: string; sunElevationDeg: number; sunDisc: number; cloudCover: number; updates: number };
  const published = (): Cond | undefined =>
    (globalThis as unknown as { window?: Record<string, unknown> }).window?.['__ROWER3D_CONDITIONS'] as Cond | undefined;

  it('publishes the default lighting when no conditions are passed (FR5, FR6)', async () => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true })) as unknown as WithTest;
    expect(published()?.name).toBe('default');
    expect(published()?.sunDisc).toBe(1);
    renderer.dispose();
    expect(published()).toBeUndefined();
  });

  it('applies the conditions passed at attach (FR1)', async () => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true, conditions: 'dusk' })) as unknown as WithTest;
    expect(published()?.name).toBe('dusk');
    expect(published()?.sunElevationDeg).toBe(4);
    renderer.dispose();
  });

  it('switches live without a new device or scene (FR1, "switching mid-row")', async () => {
    let devices = 0;
    const gpu = makeMockGPU(makeMockAdapter());
    const adapter = (await gpu.requestAdapter()) as GPUAdapter;
    const original = adapter.requestDevice.bind(adapter);
    gpu.requestAdapter = async () =>
      ({
        ...adapter,
        requestDevice: async (d?: GPUDeviceDescriptor) => {
          devices += 1;
          return original(d);
        },
      }) as unknown as GPUAdapter;
    installGPUStub(gpu);
    const renderer = (await attach(makeMockCanvas(), { testMode: true, conditions: 'midday' })) as unknown as WithTest & {
      setConditions(c: unknown): void;
    };
    expect(devices).toBe(1);
    expect(published()?.name).toBe('midday');
    renderer.setConditions('overcast');
    renderer._frameOnce();
    expect(published()?.name).toBe('overcast');
    expect(published()?.sunDisc).toBe(0);
    expect(published()?.cloudCover).toBeGreaterThanOrEqual(0.8);
    expect(devices).toBe(1);
    // An unknown value is ignored rather than resetting the sky.
    renderer.setConditions('noon');
    expect(published()?.name).toBe('overcast');
    renderer.dispose();
  });
});

describe('viewport insets (#733 VP-15)', () => {
  type Rect = { left: number; top: number; right: number; bottom: number };
  type Boat = { screenBounds: Rect | null; clearRect: Rect };
  const boat = (): Boat =>
    (globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_BOAT'] as Boat;
  const inside = (b: Rect, r: Rect): boolean =>
    b.left >= r.left - 0.5 && b.right <= r.right + 0.5 && b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5;

  it('publishes the whole canvas as clear when no insets are passed', async () => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true })) as unknown as WithTest;
    renderer._frameOnce();
    expect(boat().clearRect).toEqual({ left: 0, top: 0, right: 320, bottom: 240 });
    expect(boat().screenBounds).not.toBeNull();
    renderer.dispose();
  });

  it('frames the boat inside the clear area at attach and after a live change (FR1-FR3)', async () => {
    const renderer = (await attach(makeMockCanvas(), {
      testMode: true,
      viewportInsets: { top: 0, right: 0, bottom: 96, left: 0 },
    })) as unknown as WithTest & { setViewportInsets(i: unknown): void };
    renderer._frameOnce();
    expect(boat().clearRect.bottom).toBe(240 - 96);
    expect(inside(boat().screenBounds as Rect, boat().clearRect)).toBe(true);

    renderer.setViewportInsets({ top: 30, right: 0, bottom: 60, left: 0 });
    renderer._frameOnce();
    expect(boat().clearRect).toEqual({ left: 0, top: 30, right: 320, bottom: 180 });
    expect(inside(boat().screenBounds as Rect, boat().clearRect)).toBe(true);
    renderer.dispose();
  });
});

// #735 VP-17 FR3/FR5 — the camera telemetry reports the FOV actually drawn,
// including the portrait widening, rather than a constant 58.
describe('the ride camera publishes what it draws (#735)', () => {
  it('reports the portrait-widened FOV on a tall canvas', async () => {
    const { portraitFov, BASE_FOV } = await import('../camera');
    const canvas = makeMockCanvas();
    Object.assign(canvas, { width: 400, height: 800, clientWidth: 400, clientHeight: 800 });
    const renderer = (await attach(canvas, {
      testMode: true,
      getFrame: () => ({
        paceSPer500: 120,
        distanceMeters: 40,
        cadence: 24,
        isPlaying: false,
        holdBoat: false,
        finished: false,
        intensityFactor: 1,
        elapsedSeconds: 10,
        ghost: null,
        view: 'chase',
      }),
    })) as unknown as WithTest;
    renderer._frameOnce();
    const camera = (globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_CAMERA'] as {
      fov: number;
    };
    expect(camera.fov).toBeCloseTo(portraitFov(BASE_FOV, 0.5), 6);
    expect(camera.fov).toBeGreaterThan(BASE_FOV);
    renderer.dispose();
  });
});

describe('the boat is never behind the HUD (#733 FR3)', () => {
  type Rect = { left: number; top: number; right: number; bottom: number };
  const VIEWPORTS: [number, number][] = [
    [1280, 720],
    [1456, 840],
    [1920, 1080],
    [768, 1024],
    [844, 390],
  ];
  const VIEWS = ['chase', 'side', 'bow', 'high'] as const;

  for (const [w, h] of VIEWPORTS) {
    for (const view of VIEWS) {
      it(`${w}x${h} ${view}`, async () => {
        const canvas = makeMockCanvas();
        Object.assign(canvas, { width: w, height: h, clientWidth: w, clientHeight: h });
        // A full HUD on tall stages, the compact one (FR4, <= 28%) below 800 px.
        const bottom = Math.round(h * (h < 800 ? 0.28 : 0.4));
        const renderer = (await attach(canvas, {
          testMode: true,
          viewportInsets: { top: 0, right: 0, bottom, left: 0 },
          getFrame: () => ({
            paceSPer500: 120,
            distanceMeters: 40,
            cadence: 24,
            isPlaying: true,
            holdBoat: false,
            finished: false,
            intensityFactor: 1,
            elapsedSeconds: 10,
            ghost: null,
            view,
          }),
        })) as unknown as WithTest;
        for (let i = 0; i < 90; i++) renderer._frameOnce();
        const boat = (globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_BOAT'] as {
          screenBounds: Rect | null;
          clearRect: Rect;
        };
        const b = boat.screenBounds as Rect;
        const r = boat.clearRect;
        if (view === 'bow') {
          // The bow view is a point-of-view shot from ahead of the bow,
          // looking down the course: the boat is behind the camera by
          // design, so there is nothing for the HUD to cover.
          expect(b).toBeNull();
          renderer.dispose();
          return;
        }
        expect(b, 'boat on screen').not.toBeNull();
        expect(b.left, 'left').toBeGreaterThanOrEqual(r.left);
        expect(b.right, 'right').toBeLessThanOrEqual(r.right);
        expect(b.top, 'top').toBeGreaterThanOrEqual(r.top);
        expect(b.bottom, 'bottom').toBeLessThanOrEqual(r.bottom);
        renderer.dispose();
      });
    }
  }
});

// #728 VP-10 FR1/FR3 — with the scull GLB loaded, the race ghost is drawn
// from it (not the placeholder), a full 7 m lane to port, rowing at its
// own pace-derived rate.
describe('the race ghost rows the scull GLB (#728)', () => {
  it('draws the ghost from the scull at its own cadence, 7 m to port', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const bytes = readFileSync(resolve(process.cwd(), 'public/assets/boat/scull-male.glb'));
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith('/scull-male.glb')) return new Response(bytes);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const canvas = makeMockCanvas();
      const renderer = (await attach(canvas, {
        testMode: true,
        getFrame: () => ({
          paceSPer500: 120,
          distanceMeters: 40,
          cadence: 20,
          isPlaying: true,
          holdBoat: false,
          finished: false,
          intensityFactor: 1,
          elapsedSeconds: 10,
          ghost: { kind: 'pace', paceSPer500: 105 },
        }),
      })) as unknown as WithTest;
      for (let i = 0; i < 10; i++) renderer._frameOnce();
      const g = (globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_GHOST_METERS'] as {
        active: boolean;
        model: string;
        cadenceSpm: number;
        lane: number;
      };
      expect(g.active).toBe(true);
      expect(g.model).toBe('scull');
      expect(g.cadenceSpm).toBeCloseTo(28, 6);
      expect(g.lane).toBe(-7);
      // FR2 spec seam: in test mode the ghost can be left out of a frame,
      // so a spec can diff it against the water behind it.
      const hide = (globalThis as unknown as Record<string, unknown>)['__ROWER3D_HIDE_GHOST'] as (h: boolean) => void;
      expect(hide).toBeTypeOf('function');
      hide(true);
      renderer._frameOnce();
      expect(g.active, 'still raced, only not drawn').toBe(true);
      hide(false);
      const mask = (globalThis as unknown as Record<string, unknown>)['__ROWER3D_GHOST_MASK'] as (on: boolean) => void;
      expect(mask).toBeTypeOf('function');
      mask(true);
      renderer._frameOnce();
      mask(false);
      // #734 AC2: the player's scull can be masked the same way.
      const playerMask = (globalThis as unknown as Record<string, unknown>)['__ROWER3D_PLAYER_MASK'] as (on: boolean) => void;
      expect(playerMask).toBeTypeOf('function');
      playerMask(true);
      expect(() => renderer._frameOnce()).not.toThrow();
      playerMask(false);
      renderer.dispose();
      expect((globalThis as unknown as Record<string, unknown>)['__ROWER3D_HIDE_GHOST']).toBeUndefined();
      expect((globalThis as unknown as Record<string, unknown>)['__ROWER3D_PLAYER_MASK']).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
  // FR2 spec seam: the contrast check compares three frames (normal, mask,
  // ghost hidden) of the same pixels, so the ride must stand still between
  // them, or the oars and the hull's edge sample the water.
  it('holds the ride still across frames while __ROWER3D_HOLD_FRAME is on', async () => {
    const canvas = makeMockCanvas();
    let calls = 0;
    const renderer = (await attach(canvas, {
      testMode: true,
      getFrame: () => {
        calls += 1;
        return {
          paceSPer500: 120,
          distanceMeters: 40 + calls,
          cadence: 20,
          isPlaying: true,
          holdBoat: false,
          finished: false,
          intensityFactor: 1,
          elapsedSeconds: 10 + calls * 0.5,
          ghost: { kind: 'pace', paceSPer500: 105 },
        };
      },
    })) as unknown as WithTest;
    for (let i = 0; i < 5; i++) renderer._frameOnce();
    const read = () => {
      const g = (globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_GHOST_METERS'] as {
        value: number;
        strokePhase: number;
      };
      return { meters: g.value, phase: g.strokePhase };
    };
    const hold = (globalThis as unknown as Record<string, unknown>)['__ROWER3D_HOLD_FRAME'] as (on: boolean) => void;
    expect(hold).toBeTypeOf('function');
    hold(true);
    renderer._frameOnce();
    const held = read();
    for (let i = 0; i < 3; i++) renderer._frameOnce();
    expect(read()).toEqual(held);
    hold(false);
    renderer._frameOnce();
    expect(read().meters).not.toBe(held.meters);
    renderer.dispose();
    expect((globalThis as unknown as Record<string, unknown>)['__ROWER3D_HOLD_FRAME']).toBeUndefined();
  });

  // #724 VP-06 — the Willowbrook arches cross the river, and the high
  // camera stays under the deck while it is beneath one.
  it('fits the Willowbrook bridges and keeps the high camera under their decks', async () => {
    const canvas = makeMockCanvas();
    const routeMeters = 6000;
    const renderer = (await attach(canvas, {
      testMode: true,
      routeId: '1',
      route: { pools: [], totalDistanceMeters: routeMeters },
      getFrame: () => ({
        paceSPer500: 120,
        distanceMeters: 0,
        cadence: 20,
        isPlaying: true,
        holdBoat: false,
        finished: false,
        intensityFactor: 1,
        elapsedSeconds: 10,
        ghost: null,
        view: 'high',
      }),
    })) as unknown as WithTest;
    renderer._frameOnce();
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    const route = w['__ROWER3D_ROUTE'] as {
      spans?: Array<{ id: string; x: number; z: number; scale: number; ceiling: number | null }>;
    };
    const arches = (route.spans ?? []).filter((s) => s.id === 'c01-bridge-arch-masonry');
    expect(arches).toHaveLength(2);
    for (const arch of arches) {
      expect(arch.scale).toBeGreaterThan(1);
      expect(arch.ceiling).toBeGreaterThanOrEqual(4.5);
    }
    const seek = (globalThis as unknown as Record<string, unknown>)['__ROWER3D_SEEK_METERS'] as (m: number | null) => void;
    expect(seek).toBeTypeOf('function');
    const camera = () => w['__ROWER3D_CAMERA'] as { x: number; y: number; z: number; ceiling?: number | null };
    // Open water: the high view keeps its height.
    seek(0.4 * routeMeters);
    renderer._frameOnce();
    expect(camera().ceiling).toBeNull();
    const openY = camera().y;
    // The camera, 18 m of curve behind the boat, passes under the first
    // arch (progress 0.15 of the test's 200 m curve).
    let ducked = 0;
    for (let p = 0.1; p <= 0.3; p += 0.002) {
      seek(p * routeMeters);
      renderer._frameOnce();
      const c = camera();
      if (c.ceiling !== null && c.ceiling !== undefined) {
        ducked += 1;
        expect(c.y).toBeLessThanOrEqual(c.ceiling - 1 + 1e-6);
      }
    }
    expect(ducked).toBeGreaterThan(0);
    expect(openY).toBeGreaterThan(6);
    seek(null);
    renderer.dispose();
    expect((globalThis as unknown as Record<string, unknown>)['__ROWER3D_SEEK_METERS']).toBeUndefined();
  });
});

// #713 — the fleet rows the same scull GLB as the player (D1a): each
// member's hull in its own palette colour (D3a), a male or female crew
// from its seed (D2a), oars on the shared stroke with its own offset (D4a).
describe('the fleet rows the scull GLB (#713)', () => {
  it('draws every visible member from a scull with its own hull colour, crew and stroke offset', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { FLEET_HULL_PALETTE } = await import('../fleet');
    const glbs: Record<string, Buffer> = {
      'scull-male.glb': readFileSync(resolve(process.cwd(), 'public/assets/boat/scull-male.glb')),
      'scull-female.glb': readFileSync(resolve(process.cwd(), 'public/assets/boat/scull-female.glb')),
    };
    const fetched: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const name = url.split('/').pop() ?? '';
      if (glbs[name]) {
        fetched.push(name);
        return new Response(new Uint8Array(glbs[name]));
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const canvas = makeMockCanvas();
      const renderer = (await attach(canvas, {
        testMode: true,
        tier: 'extra-high',
        getFrame: () => ({
          paceSPer500: 120,
          distanceMeters: 40,
          cadence: 24,
          isPlaying: true,
          holdBoat: false,
          finished: false,
          intensityFactor: 1,
          elapsedSeconds: 10,
          ghost: null,
        }),
      })) as unknown as WithTest;
      for (let i = 0; i < 10; i++) renderer._frameOnce();
      // Both crews are loaded once each, whatever the player rows.
      expect(new Set(fetched)).toEqual(new Set(['scull-male.glb', 'scull-female.glb']));
      const fleet = (globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_FLEET'] as {
        model: string;
        members: { crew: string; hullColor: number[]; strokeOffset: number }[];
      };
      expect(fleet.model).toBe('scull');
      expect(fleet.members.length).toBeGreaterThan(0);
      const palette = FLEET_HULL_PALETTE.map((c) => Array.from(c.slice(0, 3)).map((v) => v.toFixed(3)).join());
      for (const m of fleet.members) {
        expect(['male', 'female']).toContain(m.crew);
        expect(palette, 'a palette colour, not the grey fallback').toContain(m.hullColor.map((v) => v.toFixed(3)).join());
        expect(m.strokeOffset).toBeGreaterThanOrEqual(0);
        expect(m.strokeOffset).toBeLessThan(1);
      }
      if (fleet.members.length > 1) {
        expect(new Set(fleet.members.map((m) => m.strokeOffset)).size, 'not in lockstep').toBeGreaterThan(1);
      }
      renderer.dispose();
      expect((globalThis as unknown as Record<string, unknown>)['__ROWER3D_FLEET']).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

// #757 VP-33 — at the start of a route that does not loop, no fleet boat
// is drawn behind the start line (wrapped round to the finish).
describe('nothing stranded behind the start (#757)', () => {
  it('draws no fleet member behind the player at the start', async () => {
    const canvas = makeMockCanvas();
    const renderer = (await attach(canvas, {
      testMode: true,
      tier: 'extra-high',
      // A 4 km course that does not loop.
      route: { pools: [], totalDistanceMeters: 4000 },
      getFrame: () => ({
        paceSPer500: 120,
        distanceMeters: 0,
        cadence: 0,
        isPlaying: false,
        holdBoat: true,
        finished: false,
        intensityFactor: 1,
        elapsedSeconds: 0,
        ghost: null,
      }),
    })) as unknown as WithTest;
    for (let i = 0; i < 5; i++) renderer._frameOnce();
    const fleet = (globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_FLEET'] as {
      members: { distanceMeters: number }[];
    };
    for (const m of fleet.members) {
      expect(m.distanceMeters, 'ahead of the start, not wrapped to the finish').toBeLessThanOrEqual(400);
    }
    expect(fleet.members.length).toBeGreaterThan(0);
    renderer.dispose();
  });
});

// #737 VP-19 — frame timing the gates can read: the real interval between
// frames (FR1), a pacing window over it (FR3), and no lurch when a hidden
// tab comes back (FR6).
describe('frame timing (#737 VP-19)', () => {
  type Timing = WithTest & {
    _telemetry: {
      frameStats: { frame: number; dtMs: number; simDtMs: number };
      framePacing: { samples: number; p50: number; max: number; over50ms: number; longestStallMs: number };
    };
  };
  const rowing = () => ({
    paceSPer500: 120,
    distanceMeters: 100,
    cadence: 24,
    isPlaying: true,
    holdBoat: false,
    finished: false,
    intensityFactor: 1,
    elapsedSeconds: 30,
    ghost: null,
  });
  let clock = 0;
  let realNow: () => number;
  beforeEach(() => {
    clock = 1_000;
    realNow = performance.now.bind(performance);
    performance.now = () => clock;
  });
  afterEach(() => {
    performance.now = realNow;
  });

  it('publishes the real interval between frames as dtMs (FR1)', async () => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true, getFrame: rowing })) as unknown as Timing;
    clock += 16.7;
    renderer._frameOnce();
    expect(renderer._telemetry.frameStats.dtMs).toBeCloseTo(16.7, 6);
    expect(renderer._telemetry.frameStats.simDtMs).toBeCloseTo(16.7, 6);
    clock += 250;
    renderer._frameOnce();
    expect(renderer._telemetry.frameStats.dtMs).toBeCloseTo(250, 6);
    expect(renderer._telemetry.frameStats.simDtMs).toBe(100);
    renderer.dispose();
  });

  it('publishes __ROWER3D_FRAME_PACING over the drawn frames (FR3)', async () => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true, getFrame: rowing })) as unknown as Timing;
    for (let i = 0; i < 59; i += 1) {
      clock += 16.7;
      renderer._frameOnce();
    }
    clock += 80;
    renderer._frameOnce();
    const pacing = (globalThis as unknown as { window: Record<string, unknown> }).window[
      '__ROWER3D_FRAME_PACING'
    ] as Timing['_telemetry']['framePacing'];
    expect(pacing).toBe(renderer._telemetry.framePacing);
    expect(pacing.samples).toBe(60);
    expect(pacing.max).toBeCloseTo(80, 6);
    expect(pacing.over50ms).toBe(1);
    expect(pacing.p50).toBeCloseTo(16.7, 1);
    renderer.dispose();
    expect((globalThis as unknown as { window: Record<string, unknown> }).window['__ROWER3D_FRAME_PACING']).toBeUndefined();
  });

  it('Scenario: returning to the tab does not lurch (FR6)', async () => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true, getFrame: rowing })) as unknown as Timing;
    for (let i = 0; i < 30; i += 1) {
      clock += 16.7;
      renderer._frameOnce();
    }
    const setVisibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('hidden');
    clock += 10_000;
    setVisibility('visible');
    renderer._frameOnce();
    expect(renderer._telemetry.frameStats.simDtMs).toBeLessThanOrEqual(100);
    expect(renderer._telemetry.frameStats.simDtMs).toBe(0);
    // The hidden time is not a stall the pacing gate should fail on.
    clock += 16.7;
    for (let i = 0; i < 15; i += 1) {
      renderer._frameOnce();
      clock += 16.7;
    }
    expect(renderer._telemetry.framePacing.longestStallMs).toBeLessThan(100);
    renderer.dispose();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
});

// #727 VP-09 FR2 — below extra-high the far cascades skip frames.
describe('far shadow cascades redraw less often (#727 FR2)', () => {
  const drawnPerFrame = async (tier: string) => {
    const canvas = makeMockCanvas();
    const renderer = (await attach(canvas, {
      testMode: true,
      tier,
      route: { pools: [], totalDistanceMeters: 4000 },
      getFrame: () => ({
        paceSPer500: 120,
        distanceMeters: 100,
        cadence: 24,
        isPlaying: true,
        holdBoat: false,
        finished: false,
        intensityFactor: 1,
        elapsedSeconds: 30,
        ghost: null,
      }),
    })) as unknown as WithTest & { _telemetry: { shadows: { cascades: number; cascadesDrawn?: number } } };
    const drawn: number[] = [];
    let cascades = 0;
    for (let i = 0; i < 8; i++) {
      renderer._frameOnce();
      cascades = renderer._telemetry.shadows.cascades;
      drawn.push(renderer._telemetry.shadows.cascadesDrawn ?? -1);
    }
    renderer.dispose();
    return { drawn, cascades };
  };

  it('redraws the nearest every frame and at most one of the far two at high', async () => {
    // attach's warm-up frames (#814) have already drawn every cascade once.
    const { drawn, cascades } = await drawnPerFrame('high');
    expect(cascades).toBe(3);
    // The 2nd every other frame, the 3rd one frame in four, never together.
    for (const n of drawn) expect(n).toBeGreaterThanOrEqual(1);
    for (const n of drawn) expect(n).toBeLessThanOrEqual(2);
    expect(drawn.reduce((a, b) => a + b, 0)).toBe(8 + 4 + 2);
  });

  it('draws every cascade every frame at extra-high', async () => {
    const { drawn, cascades } = await drawnPerFrame('extra-high');
    expect(drawn.every((n) => n === cascades)).toBe(true);
  });
});
