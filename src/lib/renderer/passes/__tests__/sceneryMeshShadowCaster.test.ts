// #688 — sceneryMeshPass's shadow iterator only yields meshes
// registered with `castsShadow: true`. The lit iterator still yields
// every mesh with instances, regardless of the shadow flag.

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { createSceneryMeshPass, type SceneryMeshPass } from '../sceneryMesh';

// jsdom doesn't ship the WebGPU globals; the pass only reads
// GPUBufferUsage.*, so a numeric stub is enough for coverage.
beforeAll(() => {
  (globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
    VERTEX: 32, INDEX: 16, STORAGE: 128, UNIFORM: 64, COPY_DST: 8,
  };
});

// A minimal fake GPUDevice that satisfies the pass's init path. Only
// the four buffer / bind-group factories need to return objects the
// pass can keep references to; nothing is actually rasterised here.
const makeFakeDevice = (): GPUDevice => {
  const bufferStub = (label?: string): GPUBuffer => ({ label, size: 0, usage: 0 }) as unknown as GPUBuffer;
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createBuffer: vi.fn((desc?: { label?: string }) => bufferStub(desc?.label)),
    createBindGroup: vi.fn(() => ({})),
    queue: {
      writeBuffer: vi.fn(),
    },
  } as unknown as GPUDevice;
  return device;
};

const register = (pass: SceneryMeshPass, id: string, castsShadow?: boolean): void => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  pass.register({
    id,
    positions,
    normals,
    indices,
    baseColor: [1, 1, 1, 1],
    maxInstances: 1,
    ...(castsShadow === undefined ? {} : { castsShadow }),
  });
  // Mark it active so the iterators actually yield something.
  pass.setInstances(id, [new Float32Array(16)]);
};

describe('#688 sceneryMesh pass — shadow-caster exemption', () => {
  let pass: SceneryMeshPass;

  beforeEach(async () => {
    pass = await createSceneryMeshPass({
      device: makeFakeDevice(),
      format: 'rgba8unorm',
      frameUniforms: {} as GPUBuffer,
    });
  });

  it('defaults castsShadow to true when unset', () => {
    register(pass, 'default-mesh');
    const casters: string[] = [];
    pass.forEachActiveShadowCaster((m) => casters.push(m.id));
    expect(casters).toEqual(['default-mesh']);
  });

  it('skips a mesh registered with castsShadow: false', () => {
    register(pass, 'buoy', false);
    const casters: string[] = [];
    pass.forEachActiveShadowCaster((m) => casters.push(m.id));
    expect(casters).toEqual([]);
  });

  it('still draws shadow-neutral meshes in the lit iteration', () => {
    register(pass, 'buoy', false);
    register(pass, 'boathouse', true);
    const lit: string[] = [];
    pass.forEachActiveMesh((m) => lit.push(m.id));
    expect(lit.sort()).toEqual(['boathouse', 'buoy']);
  });

  it('shadow iteration yields only the casters when the registry mixes both', () => {
    register(pass, 'buoy', false);
    register(pass, 'boathouse', true);
    register(pass, 'flagpole', false);
    register(pass, 'bridge', true);
    const casters: string[] = [];
    pass.forEachActiveShadowCaster((m) => casters.push(m.id));
    expect(casters.sort()).toEqual(['boathouse', 'bridge']);
  });

  it('skips a shadow-caster-flagged mesh that has zero instances', () => {
    pass.register({
      id: 'idle-caster',
      positions: new Float32Array([0, 0, 0]),
      normals: new Float32Array([0, 1, 0]),
      indices: new Uint16Array([0]),
      baseColor: [1, 1, 1, 1],
      maxInstances: 1,
      castsShadow: true,
    });
    // No setInstances call → instanceCount stays 0.
    const casters: string[] = [];
    pass.forEachActiveShadowCaster((m) => casters.push(m.id));
    expect(casters).toEqual([]);
  });

  it('every snapshot carries the castsShadow flag so a single iteration could branch on it', () => {
    register(pass, 'boathouse', true);
    register(pass, 'buoy', false);
    const seen: Array<{ id: string; castsShadow: boolean }> = [];
    pass.forEachActiveMesh((m) => seen.push({ id: m.id, castsShadow: m.castsShadow }));
    expect(seen.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'boathouse', castsShadow: true },
      { id: 'buoy', castsShadow: false },
    ]);
  });
});
