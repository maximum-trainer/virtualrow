import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// #736 VP-18: a steady-state frame creates no garbage, and the scull's
// per-primitive matrices go up in one buffer write.

const counts = vi.hoisted(() => ({ mat4: 0, vec3: 0 }));

vi.mock('../../math/mat4', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../math/mat4')>();
  return {
    ...real,
    mat4: () => {
      counts.mat4 += 1;
      return real.mat4();
    },
  };
});
vi.mock('../../math/vec3', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../math/vec3')>();
  return {
    ...real,
    vec3: (x?: number, y?: number, z?: number) => {
      counts.vec3 += 1;
      return real.vec3(x, y, z);
    },
  };
});

import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import { installGPUStub, makeMockAdapter, makeMockCanvas, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';

type Harness = {
  _frameOnce: () => void;
  _liveDevice: GPUDevice;
  dispose(): void;
};

const scullBytes = readFileSync(resolve(process.cwd(), 'public/assets/boat/scull-male.glb'));
const femaleBytes = readFileSync(resolve(process.cwd(), 'public/assets/boat/scull-female.glb'));
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.endsWith('/scull-male.glb')) return new Response(scullBytes);
    if (url.endsWith('/scull-female.glb')) return new Response(femaleBytes);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  installGPUStub(makeMockGPU(makeMockAdapter()));
  resetWebGPUHealth();
});
afterEach(() => {
  installGPUStub(undefined);
  releaseTelemetry();
});

let distance = 40;
const rowing = () => {
  distance += 0.05;
  return {
    paceSPer500: 120,
    distanceMeters: distance,
    cadence: 24,
    isPlaying: true,
    holdBoat: false,
    finished: false,
    intensityFactor: 1,
    elapsedSeconds: distance / 4,
    ghost: { kind: 'pace' as const, paceSPer500: 115 },
  };
};

const attachRowing = async (): Promise<Harness> => {
  const renderer = (await attach(makeMockCanvas(), { testMode: true, getFrame: rowing })) as unknown as Harness;
  expect(renderer).not.toBeNull();
  return renderer;
};

describe('frame loop allocations (#736)', () => {
  it('a steady-state frame builds no matrices, vectors or sets', async () => {
    const renderer = await attachRowing();
    for (let i = 0; i < 60; i += 1) renderer._frameOnce();

    const arrayFrom = vi.spyOn(Array, 'from');
    const RealSet = globalThis.Set;
    let sets = 0;
    globalThis.Set = class extends RealSet<unknown> {
      constructor(values?: Iterable<unknown> | null) {
        super(values);
        // Only the app's own: the test runner builds sets of its own meanwhile.
        if (/\/src\/lib\/(?!.*__tests__)/.test(new Error().stack?.split('\n').slice(2).join('\n') ?? '')) sets += 1;
      }
    } as SetConstructor;
    counts.mat4 = 0;
    counts.vec3 = 0;
    try {
      for (let i = 0; i < 600; i += 1) renderer._frameOnce();
    } finally {
      globalThis.Set = RealSet;
    }
    const arrays = arrayFrom.mock.calls.length;
    arrayFrom.mockRestore();

    expect({ mat4: counts.mat4, vec3: counts.vec3, sets, arrays }).toEqual({ mat4: 0, vec3: 0, sets: 0, arrays: 0 });
    renderer.dispose();
    // 660 frames plus a stack capture per Set: ~1.5 s alone, past the 5 s
    // default under the full parallel pre-push suite.
  }, 30_000);

  it('uploads the scull in at most two writes a frame', async () => {
    const renderer = await attachRowing();
    for (let i = 0; i < 5; i += 1) renderer._frameOnce();
    const write = vi.spyOn(renderer._liveDevice.queue, 'writeBuffer');
    renderer._frameOnce();
    const scullWrites = write.mock.calls.filter(([buffer]) =>
      /^sceneryMesh:boat-scull.*-inst$/.test((buffer as GPUBuffer).label),
    );
    write.mockRestore();

    expect(scullWrites.length).toBeGreaterThan(0);
    expect(scullWrites.length).toBeLessThanOrEqual(2);
    renderer.dispose();
  });
});
