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
    scenery: { pools: { kind: string; instanceCount: number }[]; dispatchCount: number; drawCount: number };
    foliage: { trees: number; meshes: number; drawn: number };
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
    expect(renderer._telemetry.renderStats.draws).toBe(10);
    renderer.dispose();
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
    renderer.dispose();
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
      renderer.dispose();
      expect((globalThis as unknown as Record<string, unknown>)['__ROWER3D_HIDE_GHOST']).toBeUndefined();
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
