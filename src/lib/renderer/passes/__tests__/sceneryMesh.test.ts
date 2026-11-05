/// <reference types="@webgpu/types" />
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSceneryMeshPass, type SceneryMeshInput } from '../sceneryMesh';
import sceneryMeshWgsl from '../sceneryMesh.wgsl?raw';
import { mat4, mat4Identity } from '../../math/mat4';

// jsdom doesn't ship the WebGPU globals; the pass only reads
// GPUBufferUsage.*, so a numeric stub is enough for coverage.
beforeAll(() => {
  (globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
    VERTEX: 32, INDEX: 16, STORAGE: 128, UNIFORM: 64, COPY_DST: 8,
  };
});

/**
 * The pass is thin WebGPU wiring — no Node WebGPU implementation to run it
 * against — so these tests stub the device and check that the pass walks the
 * registry correctly: skips when no meshes are registered, skips when every
 * mesh has 0 instances, draws N instances when they're set, clamps to
 * `maxInstances`, and ignores a double `register` of the same id.
 */

const makeBuffer = () => ({
  destroy: vi.fn(),
  mapAsync: vi.fn(),
  getMappedRange: vi.fn(),
  unmap: vi.fn(),
}) as unknown as GPUBuffer;

const makePass = () => {
  const setBindGroup = vi.fn();
  const setPipeline = vi.fn();
  const setVertexBuffer = vi.fn();
  const setIndexBuffer = vi.fn();
  const drawIndexed = vi.fn();
  const end = vi.fn();
  const pass = { setBindGroup, setPipeline, setVertexBuffer, setIndexBuffer, drawIndexed, end } as unknown as GPURenderPassEncoder;
  return { pass, setBindGroup, setPipeline, setVertexBuffer, drawIndexed, setIndexBuffer, end };
};

const makeDevice = () => {
  const queue = { writeBuffer: vi.fn() } as unknown as GPUQueue;
  const bindGroups: unknown[] = [];
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createRenderPipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createBuffer: vi.fn(() => makeBuffer()),
    createBindGroup: vi.fn((desc: GPUBindGroupDescriptor) => {
      bindGroups.push(desc);
      return {} as GPUBindGroup;
    }),
    queue,
  } as unknown as GPUDevice;
  return { device, queue, bindGroups };
};

const makeInput = (over: Partial<SceneryMeshInput> = {}): SceneryMeshInput => ({
  id: over.id ?? 'test-mesh',
  positions: over.positions ?? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: over.normals ?? new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: over.indices ?? new Uint16Array([0, 1, 2]),
  baseColor: over.baseColor ?? [0.3, 0.5, 0.4, 1],
  ...(over.colors ? { colors: over.colors } : {}),
  maxInstances: over.maxInstances ?? 4,
});

describe('createSceneryMeshPass', () => {
  it('starts with no registered meshes', () => {
    const { device } = makeDevice();
    const frameBuf = makeBuffer();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: frameBuf });
    expect(p.meshCount).toBe(0);
  });

  it('registers a mesh and ignores a second register with the same id', () => {
    const { device } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    expect(p.meshCount).toBe(1);
    p.register(makeInput({ id: 'buoy' }));
    expect(p.meshCount).toBe(1);
    p.register(makeInput({ id: 'post' }));
    expect(p.meshCount).toBe(2);
  });

  it('setInstances is a no-op for unknown ids', () => {
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    const writeCountBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    p.setInstances('does-not-exist', [mat4Identity(mat4())]);
    const writeCountAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(writeCountAfter).toBe(writeCountBefore);
  });

  it('clamps setInstances to the registered maxInstances', () => {
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy', maxInstances: 2 }));
    const writesBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    p.setInstances('buoy', [mat4Identity(mat4()), mat4Identity(mat4()), mat4Identity(mat4()), mat4Identity(mat4())]);
    const writesAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    // Clamped to 2 writes.
    expect(writesAfter - writesBefore).toBe(2);
  });

  it('encode skips when nothing is registered', () => {
    const { device } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    const encoderBeginRenderPass = vi.fn();
    p.encode({ encoder: { beginRenderPass: encoderBeginRenderPass } } as unknown as Parameters<typeof p.encode>[0]);
    expect(encoderBeginRenderPass).not.toHaveBeenCalled();
  });

  it('encode skips when every registered mesh has 0 instances', () => {
    const { device } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    const beginRenderPass = vi.fn();
    p.encode({ encoder: { beginRenderPass } } as unknown as Parameters<typeof p.encode>[0]);
    expect(beginRenderPass).not.toHaveBeenCalled();
  });

  it('encode draws per-mesh when instances are set', () => {
    const { device } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy', maxInstances: 4 }));
    p.register(makeInput({ id: 'post', maxInstances: 4, indices: new Uint32Array([0, 1, 2]) }));
    p.setInstances('buoy', [mat4Identity(mat4()), mat4Identity(mat4())]);
    p.setInstances('post', [mat4Identity(mat4())]);
    const { pass, drawIndexed, end } = makePass();
    const beginRenderPass = vi.fn(() => pass);
    p.encode({
      encoder: { beginRenderPass },
      swapView: {},
      depthView: {},
    } as unknown as Parameters<typeof p.encode>[0]);
    expect(beginRenderPass).toHaveBeenCalledTimes(1);
    // One drawIndexed per registered-with-instances mesh.
    expect(drawIndexed).toHaveBeenCalledTimes(2);
    // 3 indices per mesh, 2 instances for buoy, 1 for post.
    expect(drawIndexed.mock.calls[0][1]).toBe(2);
    expect(drawIndexed.mock.calls[1][1]).toBe(1);
    expect(end).toHaveBeenCalled();
  });

  it('pads an odd-length uint16 index upload to 4 bytes but still draws the real count (#672)', () => {
    // WebGPU rejects a writeBuffer whose size is not a multiple of 4, and the
    // index buffer then stays zero-filled: every triangle collapses onto
    // vertex 0 and the primitive is invisible. The HD rower's meshopt output
    // has many primitives with an odd triangle count (3 × u16 = 6 B each), so
    // its head, neck, shoulders and arms vanished while the torso drew.
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    const indices = new Uint16Array([0, 1, 2]);
    p.register(makeInput({ id: 'odd', indices }));

    const sizes = (device.createBuffer as unknown as { mock: { calls: [GPUBufferDescriptor][] } }).mock.calls
      .filter(([d]) => d.label === 'sceneryMesh:odd-idx')
      .map(([d]) => d.size);
    expect(sizes).toEqual([8]);

    const writes = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of writes) {
      const data = call[2] as ArrayBufferView;
      const size = (call[4] as number | undefined) ?? data.byteLength;
      expect(size % 4, 'every writeBuffer is 4-byte aligned').toBe(0);
    }
    const idxWrite = writes.find((c) => (c[2] as ArrayBufferView) instanceof Uint16Array);
    expect(Array.from((idxWrite![2] as Uint16Array).subarray(0, 3))).toEqual([0, 1, 2]);

    p.setInstances('odd', [mat4Identity(mat4())]);
    const { pass, drawIndexed } = makePass();
    p.encode({
      encoder: { beginRenderPass: vi.fn(() => pass) },
      swapView: {},
      depthView: {},
    } as unknown as Parameters<typeof p.encode>[0]);
    expect(drawIndexed.mock.calls[0][0]).toBe(3);
  });

  it('uploads a supplied per-vertex colour buffer verbatim', () => {
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    // 3 vertices → 12 colour floats: part A brown, parts B/C green.
    const colors = new Float32Array([0.4, 0.26, 0.13, 1, 0.1, 0.6, 0.15, 1, 0.1, 0.6, 0.15, 1]);
    p.register(makeInput({ id: 'tree', colors }));
    const calls = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // The colour buffer is written with the exact array we supplied.
    expect(calls.some((c) => c[2] === colors)).toBe(true);
  });

  it('synthesizes a per-vertex colour buffer from baseColor when colors omitted', () => {
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    // Default input has 3 vertices (9 position floats) and no colors.
    p.register(makeInput({ id: 'block', baseColor: [0.5, 0.25, 0.75, 1] }));
    const calls = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // The only length-12 Float32Array write is the synthesized colour buffer.
    const colourWrite = calls.find((c) => c[2] instanceof Float32Array && (c[2] as Float32Array).length === 12);
    expect(colourWrite).toBeTruthy();
    const arr = colourWrite![2] as Float32Array;
    expect(Array.from(arr.slice(0, 4))).toEqual([0.5, 0.25, 0.75, 1]);
    expect(Array.from(arr.slice(8, 12))).toEqual([0.5, 0.25, 0.75, 1]);
  });

  it('encode binds the colour vertex buffer at slot 2', () => {
    const { device } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    p.setInstances('buoy', [mat4Identity(mat4())]);
    const { pass, setVertexBuffer } = makePass();
    const beginRenderPass = vi.fn(() => pass);
    p.encode({
      encoder: { beginRenderPass },
      swapView: {},
      depthView: {},
    } as unknown as Parameters<typeof p.encode>[0]);
    expect(setVertexBuffer.mock.calls.some((c) => c[0] === 2)).toBe(true);
  });

  it('dispose destroys every registered mesh buffer and clears the registry', () => {
    const { device } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    expect(p.meshCount).toBe(1);
    p.dispose();
    expect(p.meshCount).toBe(0);
    // Calling dispose again is idempotent.
    p.dispose();
    expect(p.meshCount).toBe(0);
  });

  it('writeColors updates the colour buffer when the byte length matches (#578 FR2)', () => {
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'crew-top', positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint16Array([0, 1, 2]), baseColor: [0.1, 0.2, 0.3, 1] }));
    // Three vertices × 4 floats × 4 bytes = 48 bytes.
    const writesBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    const next = new Float32Array(12);
    for (let i = 0; i < 12; i += 1) next[i] = 0.5;
    p.writeColors('crew-top', next);
    const writesAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(writesAfter - writesBefore).toBe(1);
  });

  it('writeColors is a no-op on byte-length mismatch (#578 safety)', () => {
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'crew-top', positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint16Array([0, 1, 2]), baseColor: [0.1, 0.2, 0.3, 1] }));
    const writesBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    // Wrong vertex count — 8 floats instead of 12.
    p.writeColors('crew-top', new Float32Array(8));
    const writesAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(writesAfter).toBe(writesBefore);
  });

  it('writeColors on unknown ids is a no-op', () => {
    const { device, queue } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    const writesBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    p.writeColors('nope', new Float32Array(4));
    const writesAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(writesAfter).toBe(writesBefore);
  });

  // The shader used to blend each tree fragment with the pale fog colour
  // `(0.72, 0.78, 0.82)` at the full exponential mix (`f` up to 1.0), so a
  // tree 60 m from the camera read as a near-pure pale-blue silhouette with
  // only a hint of leaf colour (frame.fog baseline `[0.001, 0.0005]` gives
  // `f ≈ 0.84` at 60 m). Dan filed this as "trees appear transparent" — the
  // trees were being bleached to the fog colour, not actually blended out.
  // The fix caps the mix at a modest ceiling so distant trees retain their
  // authored tint while still sitting under atmospheric haze.
  it('caps the fog mix so distant trees never bleach to pure fog colour', () => {
    // The shader clamps `f` to `≤ TREE_FOG_MAX` where TREE_FOG_MAX is well
    // under 1.0. Encoded as `min(..., 0.X)` in the mix argument.
    const match = sceneryMeshWgsl.match(/min\(\s*f\s*,\s*(0?\.\d+)\s*\)/);
    expect(match, 'sceneryMesh.wgsl should clamp fog mix via min(f, C)').not.toBeNull();
    const ceiling = Number(match![1]);
    expect(ceiling).toBeGreaterThan(0);
    expect(ceiling).toBeLessThanOrEqual(0.5);
  });

  it('encode is a no-op after dispose', () => {
    const { device } = makeDevice();
    const p = createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    p.setInstances('buoy', [mat4Identity(mat4())]);
    p.dispose();
    const beginRenderPass = vi.fn();
    p.encode({ encoder: { beginRenderPass } } as unknown as Parameters<typeof p.encode>[0]);
    expect(beginRenderPass).not.toHaveBeenCalled();
  });
});
