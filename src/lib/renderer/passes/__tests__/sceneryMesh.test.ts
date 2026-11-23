/// <reference types="@webgpu/types" />
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSceneryMeshPass, SCENERY_INSTANCE_BYTES, type SceneryMeshInput } from '../sceneryMesh';
import sceneryMeshDepthWgsl from '../sceneryMeshDepth.wgsl?raw';
import sceneryMeshWgsl from '../sceneryMesh.wgsl?raw';
import { mat4, mat4Identity } from '../../math/mat4';
import { ALWAYS_REVEALED, SCENERY_REVEAL_SECONDS, SCENERY_VISIBILITY_METRES } from '../sceneryReveal';

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
    createBuffer: vi.fn((_desc?: GPUBufferDescriptor) => makeBuffer()),
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
  ...(over.revealAt !== undefined ? { revealAt: over.revealAt } : {}),
});

describe('createSceneryMeshPass', () => {
  it('starts with no registered meshes', async () => {
    const { device } = makeDevice();
    const frameBuf = makeBuffer();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: frameBuf });
    expect(p.meshCount).toBe(0);
  });

  it('registers a mesh and ignores a second register with the same id', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    expect(p.meshCount).toBe(1);
    p.register(makeInput({ id: 'buoy' }));
    expect(p.meshCount).toBe(1);
    p.register(makeInput({ id: 'post' }));
    expect(p.meshCount).toBe(2);
  });

  it('setInstances is a no-op for unknown ids', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    const writeCountBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    p.setInstances('does-not-exist', [mat4Identity(mat4())]);
    const writeCountAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(writeCountAfter).toBe(writeCountBefore);
  });

  it('clamps setInstances to the registered maxInstances', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy', maxInstances: 2 }));
    const writesBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    p.setInstances('buoy', [mat4Identity(mat4()), mat4Identity(mat4()), mat4Identity(mat4()), mat4Identity(mat4())]);
    const writesAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    // Clamped to 2 instances, in one write.
    expect(writesAfter - writesBefore).toBe(1);
    const last = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
    expect((last[2] as Float32Array).byteLength).toBe(2 * SCENERY_INSTANCE_BYTES);
  });

  // #726 VP-08 FR4 — one model's instances go up in one write, not one per instance.
  it('uploads 400 instances in exactly one writeBuffer', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'tree', maxInstances: 1024 }));
    const calls = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const before = calls.length;
    const instances = Array.from({ length: 400 }, (_, i) => {
      const m = mat4Identity(mat4());
      m[12] = i;
      return m;
    });
    p.setInstances('tree', instances);
    expect(calls.length - before).toBe(1);
    const [, offset, data] = calls[calls.length - 1] as [GPUBuffer, number, Float32Array];
    expect(offset).toBe(0);
    expect(data.byteLength).toBe(400 * SCENERY_INSTANCE_BYTES);
    expect(data[399 * (SCENERY_INSTANCE_BYTES / 4) + 12]).toBe(399);
  });

  it('encode skips when nothing is registered', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    const encoderBeginRenderPass = vi.fn();
    p.encode({ encoder: { beginRenderPass: encoderBeginRenderPass } } as unknown as Parameters<typeof p.encode>[0]);
    expect(encoderBeginRenderPass).not.toHaveBeenCalled();
  });

  it('encode skips when every registered mesh has 0 instances', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    const beginRenderPass = vi.fn();
    p.encode({ encoder: { beginRenderPass } } as unknown as Parameters<typeof p.encode>[0]);
    expect(beginRenderPass).not.toHaveBeenCalled();
  });

  it('encode draws per-mesh when instances are set', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
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

  it('publishes this frame\'s draws, instances and triangles, reset every frame (#737 FR2)', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy', maxInstances: 4, indices: new Uint16Array([0, 1, 2, 0, 2, 1]) }));
    p.register(makeInput({ id: 'post', maxInstances: 4 }));
    p.setInstances('buoy', [mat4Identity(mat4()), { model: mat4Identity(mat4()), alpha: 0.5 }]);
    p.setInstances('post', [mat4Identity(mat4())]);
    const ctx = () => ({
      encoder: { beginRenderPass: vi.fn(() => makePass().pass) },
      swapView: {},
      depthView: {},
    }) as unknown as Parameters<typeof p.encode>[0];
    p.encode(ctx());
    // buoy: one opaque run + one translucent run; post: one draw.
    expect(p.stats).toEqual({ draws: 3, instances: 3, triangles: 2 * 2 + 1 });
    p.encode(ctx());
    expect(p.stats).toEqual({ draws: 3, instances: 3, triangles: 5 });
    p.setInstances('buoy', []);
    p.setInstances('post', []);
    p.encode(ctx());
    expect(p.stats).toEqual({ draws: 0, instances: 0, triangles: 0 });
  });

  it('pads an odd-length uint16 index upload to 4 bytes but still draws the real count (#672)', async () => {
    // WebGPU rejects a writeBuffer whose size is not a multiple of 4, and the
    // index buffer then stays zero-filled: every triangle collapses onto
    // vertex 0 and the primitive is invisible. The HD rower's meshopt output
    // has many primitives with an odd triangle count (3 × u16 = 6 B each), so
    // its head, neck, shoulders and arms vanished while the torso drew.
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
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

  it('uploads a supplied per-vertex colour buffer verbatim', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    // 3 vertices → 12 colour floats: part A brown, parts B/C green.
    const colors = new Float32Array([0.4, 0.26, 0.13, 1, 0.1, 0.6, 0.15, 1, 0.1, 0.6, 0.15, 1]);
    p.register(makeInput({ id: 'tree', colors }));
    const calls = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // The colour buffer is written with the exact array we supplied.
    expect(calls.some((c) => c[2] === colors)).toBe(true);
  });

  it('synthesizes a per-vertex colour buffer from baseColor when colors omitted', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
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

  it('encode binds the colour vertex buffer at slot 2', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
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

  it('dispose destroys every registered mesh buffer and clears the registry', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    expect(p.meshCount).toBe(1);
    p.dispose();
    expect(p.meshCount).toBe(0);
    // Calling dispose again is idempotent.
    p.dispose();
    expect(p.meshCount).toBe(0);
  });

  it('writeColors updates the colour buffer when the byte length matches (#578 FR2)', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'crew-top', positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint16Array([0, 1, 2]), baseColor: [0.1, 0.2, 0.3, 1] }));
    // Three vertices × 4 floats × 4 bytes = 48 bytes.
    const writesBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    const next = new Float32Array(12);
    for (let i = 0; i < 12; i += 1) next[i] = 0.5;
    p.writeColors('crew-top', next);
    const writesAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(writesAfter - writesBefore).toBe(1);
  });

  it('writeColors is a no-op on byte-length mismatch (#578 safety)', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'crew-top', positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint16Array([0, 1, 2]), baseColor: [0.1, 0.2, 0.3, 1] }));
    const writesBefore = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    // Wrong vertex count — 8 floats instead of 12.
    p.writeColors('crew-top', new Float32Array(8));
    const writesAfter = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    expect(writesAfter).toBe(writesBefore);
  });

  it('writeColors on unknown ids is a no-op', async () => {
    const { device, queue } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
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

  // #726 VP-08 FR3 — a model streamed in mid-ride fades in over 1.5 s,
  // driven by a per-mesh reveal uniform at group 1 binding 2.
  describe('reveal fade (#726 FR3)', () => {
    type Desc = { entries: { binding: number; resource: { buffer: unknown } }[] };
    const revealWrites = (queue: GPUQueue) =>
      (queue.writeBuffer as unknown as { mock: { calls: [GPUBuffer, number, Float32Array][] } }).mock.calls.filter(
        ([, , data]) => data instanceof Float32Array && data.length === 4 && data[1] === SCENERY_REVEAL_SECONDS,
      );

    it('binds one reveal uniform at binding 2 in both bind groups', async () => {
      const { device, bindGroups } = makeDevice();
      const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      p.register(makeInput({ id: 'boathouse' }));
      const meshGroups = (bindGroups as Desc[]).filter((d) => d.entries.some((e) => e.binding === 1));
      expect(meshGroups).toHaveLength(2);
      const reveal = meshGroups.map((d) => d.entries.find((e) => e.binding === 2)?.resource.buffer);
      expect(reveal[0]).toBeDefined();
      expect(reveal[1]).toBe(reveal[0]);
    });

    it('writes the registration time when the model is revealed mid-ride', async () => {
      const { device, queue } = makeDevice();
      const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      p.register(makeInput({ id: 'boathouse', revealAt: 42.5 }));
      const w = revealWrites(queue);
      expect(w).toHaveLength(1);
      expect(Array.from(w[0][2])).toEqual([42.5, SCENERY_REVEAL_SECONDS, SCENERY_VISIBILITY_METRES, 0]);
    });

    it('draws a mesh registered without revealAt at full opacity from the first frame', async () => {
      const { device, queue } = makeDevice();
      const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      p.register(makeInput({ id: 'boat' }));
      expect(revealWrites(queue)[0][2][0]).toBe(ALWAYS_REVEALED);
    });

    it('destroys the reveal buffer on dispose', async () => {
      const created: GPUBuffer[] = [];
      const { device } = makeDevice();
      (device.createBuffer as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const b = makeBuffer();
        created.push(b);
        return b;
      });
      const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      p.register(makeInput({ id: 'boathouse', revealAt: 1 }));
      p.dispose();
      for (const b of created) expect(b.destroy).toHaveBeenCalled();
    });

    it('the fragment shader dithers instances out until their reveal alpha reaches 1', () => {
      expect(sceneryMeshWgsl).toMatch(/@group\(1\)\s*@binding\(2\)\s*var<uniform>\s*reveal\s*:\s*vec4<f32>/);
      expect(sceneryMeshWgsl).toMatch(/frame\.time\s*-\s*reveal\.x/);
      expect(sceneryMeshWgsl).toMatch(/in\.worldDist\s*>\s*reveal\.z/);
      expect(sceneryMeshWgsl).toMatch(/discard/);
    });
  });

  it('encode is a no-op after dispose', async () => {
    const { device } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    p.register(makeInput({ id: 'buoy' }));
    p.setInstances('buoy', [mat4Identity(mat4())]);
    p.dispose();
    const beginRenderPass = vi.fn();
    p.encode({ encoder: { beginRenderPass } } as unknown as Parameters<typeof p.encode>[0]);
    expect(beginRenderPass).not.toHaveBeenCalled();
  });

  // #728 VP-10 FR1/FR2 and #713 D3a: the ghost and the fleet draw the
  // player's scull GLB as further instances of the same primitives, each
  // with its own tint, opacity and rim.
  describe('per-instance style (#728, #713 D3a)', () => {
    const writes = (queue: GPUQueue) =>
      (queue.writeBuffer as unknown as { mock: { calls: [GPUBuffer, number, Float32Array][] } }).mock.calls;
    const encode = (p: Awaited<ReturnType<typeof createSceneryMeshPass>>) => {
      const m = makePass();
      p.encode({
        encoder: { beginRenderPass: vi.fn(() => m.pass) },
        swapView: {},
        depthView: {},
      } as unknown as Parameters<typeof p.encode>[0]);
      return m;
    };

    it('packs a model, a tint and an effect vec4 per instance (96 B)', async () => {
      expect(SCENERY_INSTANCE_BYTES).toBe(96);
      const { device, queue } = makeDevice();
      const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      p.register(makeInput({ id: 'hull', maxInstances: 2 }));
      // The pass reuses one scratch array, so keep a copy of each write.
      const copies: Float32Array[] = [];
      (queue.writeBuffer as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_b: GPUBuffer, _o: number, data: Float32Array) => { copies.push(Float32Array.from(data)); },
      );
      const before = writes(queue).length;
      p.setInstances('hull', [
        mat4Identity(mat4()),
        { model: mat4Identity(mat4()), tint: [0.6, 1, 0.3, 1], alpha: 0.6, rim: 0.8, flat: 1 },
      ]);
      const w = writes(queue).slice(before);
      expect(w).toHaveLength(1);
      expect(w[0][1]).toBe(0);
      const both = copies[copies.length - 1];
      expect(both.length).toBe(2 * 24);
      // An unstyled instance keeps its authored colour, fully opaque.
      // fx.w is the share of the distance haze it takes: all of it by default.
      expect(Array.from(both.slice(16, 24))).toEqual([0, 0, 0, 0, 1, 0, 0, 1]);
      expect(Array.from(both.slice(24 + 16, 24 + 24)).map((v) => Number(v.toFixed(3)))).toEqual([0.6, 1, 0.3, 1, 0.6, 0.8, 1, 1]);
      p.setInstances('hull', [{ model: mat4Identity(mat4()), tint: [0, 0, 0, 1], haze: 0 }]);
      expect(copies[copies.length - 1][23]).toBe(0);
    });

    it('draws opaque instances first and translucent ones after, with their own pipeline', async () => {
      const { device } = makeDevice();
      const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      p.register(makeInput({ id: 'hull', maxInstances: 4 }));
      p.register(makeInput({ id: 'oar', maxInstances: 4 }));
      const ghost = { model: mat4Identity(mat4()), tint: [0.6, 1, 0.3, 1] as const, alpha: 0.6 };
      p.setInstances('hull', [mat4Identity(mat4()), ghost, mat4Identity(mat4()), mat4Identity(mat4())]);
      p.setInstances('oar', [mat4Identity(mat4()), ghost]);
      const { drawIndexed, setPipeline } = encode(p);
      // [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
      const calls = drawIndexed.mock.calls.map((c) => [c[1], c[4] ?? 0]);
      expect(calls).toEqual([
        [1, 0], [2, 2], // hull: player, then the two fleet boats
        [1, 0], // oar: player
        [1, 1], // hull: ghost
        [1, 1], // oar: ghost
      ]);
      expect(setPipeline).toHaveBeenCalledTimes(2);
      expect(setPipeline.mock.calls[0][0]).not.toBe(setPipeline.mock.calls[1][0]);
    });

    it('builds the translucent pipeline with alpha blending and no depth write', async () => {
      const { device } = makeDevice();
      await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      const descs = (device.createRenderPipeline as unknown as { mock: { calls: [GPURenderPipelineDescriptor][] } }).mock.calls.map((c) => c[0]);
      const translucent = descs.find((d) => d.label === 'sceneryMesh-translucent');
      expect(translucent).toBeDefined();
      expect(translucent!.depthStencil?.depthWriteEnabled).toBe(false);
      expect((translucent!.fragment!.targets as GPUColorTargetState[])[0].blend?.color.dstFactor).toBe('one-minus-src-alpha');
    });

    it('skips the translucent pipeline when nothing is translucent', async () => {
      const { device } = makeDevice();
      const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
      p.register(makeInput({ id: 'hull', maxInstances: 2 }));
      p.setInstances('hull', [mat4Identity(mat4()), { model: mat4Identity(mat4()), tint: [1, 0, 0, 1] }]);
      const { drawIndexed, setPipeline } = encode(p);
      expect(setPipeline).toHaveBeenCalledTimes(1);
      expect(drawIndexed.mock.calls.map((c) => c[1])).toEqual([2]);
    });

    it('reads the same 96 B instance record in the lit and the shadow shaders', () => {
      for (const src of [sceneryMeshWgsl, sceneryMeshDepthWgsl]) {
        expect(src).toMatch(/struct SceneryInstance\s*\{[^}]*model:\s*mat4x4<f32>[^}]*tint:\s*vec4<f32>[^}]*fx:\s*vec4<f32>/);
        expect(src).toMatch(/array<SceneryInstance>/);
      }
    });

    it('applies the tint, a fresnel rim and the opacity in the lit shader', () => {
      expect(sceneryMeshWgsl).toMatch(/mix\(\s*lit\s*,[^;]*inst\.tint/);
      expect(sceneryMeshWgsl).toMatch(/fresnel/);
      // fresnel^4: the rim stays on the silhouette, off the hull's sides.
      expect(sceneryMeshWgsl).toMatch(/pow\([^;]*abs\(dot\(n, v\)\)[^;]*,\s*4\.0\)/);
      expect(sceneryMeshWgsl).toMatch(/inst\.fx\.x/);
    });

    it('scales the distance haze by the instance share, so the ghost can opt out', () => {
      expect(sceneryMeshWgsl).toMatch(/min\(f,\s*0\.35\)\s*\*\s*inst\.fx\.w/);
    });
  });
});

// #736 VP-18 FR3 — a model of many primitives shares one instance buffer and
// goes up in one write a frame.
describe('instance groups', () => {
  const setup = async () => {
    const { device, queue, bindGroups } = makeDevice();
    const p = await createSceneryMeshPass({ device, format: 'bgra8unorm', frameUniforms: makeBuffer() });
    const calls = (queue.writeBuffer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return { device, p, calls, bindGroups };
  };

  it('uploads every mesh in the group with one write, at its own aligned slot', async () => {
    const { device, p, calls, bindGroups } = await setup();
    p.reserveInstanceGroup('scull', 3, 2);
    for (let i = 0; i < 3; i += 1) {
      p.register({ ...makeInput({ id: `g:${i}` }), instanceGroup: { name: 'scull', index: i } });
    }
    const groupBuffer = (device.createBuffer as unknown as { mock: { results: { value: GPUBuffer }[] } }).mock.results
      .map((r) => r.value)
      .find((_, k) => ((device.createBuffer as unknown as { mock: { calls: [GPUBufferDescriptor][] } }).mock.calls[k][0].label === 'sceneryMesh:scull-inst'));
    expect(groupBuffer).toBeDefined();

    const before = calls.length;
    for (let i = 0; i < 3; i += 1) {
      const m = mat4Identity(mat4());
      m[12] = i + 1;
      p.setInstances(`g:${i}`, [m]);
    }
    expect(calls.length - before, 'nothing written until the flush').toBe(0);
    p.flushInstanceGroups();
    expect(calls.length - before).toBe(1);
    const [buffer, offset, data] = calls.at(-1) as [GPUBuffer, number, Float32Array];
    expect(buffer).toBe(groupBuffer);
    expect(offset).toBe(0);
    // 2 instances × 96 B = 192 B, padded to the 256 B storage-offset alignment.
    expect(data.byteLength).toBe(3 * 256);
    for (let i = 0; i < 3; i += 1) expect(data[(i * 256) / 4 + 12]).toBe(i + 1);

    // Each mesh binds its own slot of the shared buffer.
    const entries = bindGroups
      .map((d) => d as GPUBindGroupDescriptor)
      .filter((d) => /^sceneryMesh:g:\d-bg$/.test(d.label ?? ''))
      .map((d) => (Array.from(d.entries)[0].resource as GPUBufferBinding));
    expect(entries.map((e) => e.offset)).toEqual([0, 256, 512]);
    expect(entries.every((e) => e.buffer === groupBuffer && e.size === 2 * SCENERY_INSTANCE_BYTES)).toBe(true);

    // Nothing changed since: the next flush writes nothing.
    p.flushInstanceGroups();
    expect(calls.length - before).toBe(1);
  });

  it('reports each grouped mesh with its own byte range for the shadow pass', async () => {
    const { p } = await setup();
    p.reserveInstanceGroup('scull', 2, 2);
    p.register({ ...makeInput({ id: 'a' }), instanceGroup: { name: 'scull', index: 0 } });
    p.register({ ...makeInput({ id: 'b' }), instanceGroup: { name: 'scull', index: 1 } });
    p.setInstances('a', [mat4Identity(mat4())]);
    p.setInstances('b', [mat4Identity(mat4())]);
    const seen: { id: string; offset: number; size: number }[] = [];
    p.forEachActiveShadowCaster((m) => seen.push({ id: m.id, offset: m.instanceOffset, size: m.instanceSize }));
    expect(seen).toEqual([
      { id: 'a', offset: 0, size: 2 * SCENERY_INSTANCE_BYTES },
      { id: 'b', offset: 256, size: 2 * SCENERY_INSTANCE_BYTES },
    ]);
  });

  it('refuses a slot the group does not have', async () => {
    const { p } = await setup();
    p.reserveInstanceGroup('scull', 1, 2);
    expect(() => p.register({ ...makeInput({ id: 'x' }), instanceGroup: { name: 'scull', index: 1 } })).toThrow(/no slot 1/);
    expect(() => p.register({ ...makeInput({ id: 'y' }), instanceGroup: { name: 'missing', index: 0 } })).toThrow(/missing/);
  });
});
