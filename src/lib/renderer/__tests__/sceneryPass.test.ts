import { describe, expect, it } from 'vitest';
import { makeMockDevice } from './_mockWebGPU';
import { createSceneryPass, DEFAULT_MAX_DISTANCE } from '../engine/sceneryPass';
import { createInstancePool, type InstancePool } from '../plan/instancePools';
import { mat4, mat4Identity } from '../math/mat4';
import { vec3 } from '../math/vec3';
import type { FrameContext } from '../engine/frameGraph';
import sceneryWgsl from '../passes/scenery.wgsl?raw';

const makeUniformBuffer = (device: ReturnType<typeof makeMockDevice>): GPUBuffer =>
  device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

const makePools = (device: ReturnType<typeof makeMockDevice>): InstancePool[] => {
  const pos = (count: number): Float32Array => {
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      out[i * 3 + 0] = i;
      out[i * 3 + 2] = -i;
    }
    return out;
  };
  return [
    createInstancePool(device, {
      kind: 'foliage',
      speciesIndex: 0,
      chunkIndex: 0,
      positions: pos(32),
      bounds: { cx: 0, cy: 0, cz: 0, radius: 50 },
    }),
    createInstancePool(device, {
      kind: 'foliage',
      speciesIndex: 1,
      chunkIndex: 0,
      positions: pos(16),
      bounds: { cx: 0, cy: 0, cz: 0, radius: 50 },
    }),
    createInstancePool(device, {
      kind: 'scenery',
      speciesIndex: 0,
      positions: pos(8),
      bounds: { cx: 0, cy: 0, cz: 0, radius: 50 },
    }),
  ];
};

const makeFrameCtx = (
  device: ReturnType<typeof makeMockDevice>,
): FrameContext => {
  const encoder = device.createCommandEncoder();
  return {
    device,
    encoder,
    swapView: {} as GPUTextureView,
    outputView: {} as GPUTextureView,
    depthView: {} as GPUTextureView,
    width: 320,
    height: 240,
    frame: {
      view: mat4(),
      proj: mat4(),
      viewProj: mat4Identity(mat4()),
      camPos: vec3(0, 2.6, 7),
      sunDir: vec3(0, 1, 0),
      fog: new Float32Array(4),
      time: 0,
    },
    colorCleared: true,
    depthCleared: true,
  };
};

describe('sceneryPass', () => {
  it('dispatches once per pool and emits one indirect draw per pool', async () => {
    const device = makeMockDevice();
    const frameUniforms = makeUniformBuffer(device);
    const pools = makePools(device);
    const pass = await createSceneryPass({
      device,
      format: 'bgra8unorm',
      frameUniforms,
      sproutUniforms: frameUniforms,
      pools,
    });
    expect(pass.name).toBe('scenery');
    expect(pass.pools.length).toBe(3);

    pass.encode(makeFrameCtx(device));
    expect(device.__log.computeDispatches).toBe(3);
    expect(device.__log.indirectDraws).toBe(3);

    pass.dispose();
    pass.dispose(); // idempotent
    for (const p of pools) p.dispose();
  });

  it('encodes nothing when pools are empty', async () => {
    const device = makeMockDevice();
    const frameUniforms = makeUniformBuffer(device);
    const pass = await createSceneryPass({
      device,
      format: 'bgra8unorm',
      frameUniforms,
      sproutUniforms: frameUniforms,
      pools: [],
    });
    pass.encode(makeFrameCtx(device));
    expect(device.__log.computeDispatches).toBe(0);
    expect(device.__log.indirectDraws).toBe(0);
    pass.dispose();
  });

  it('populates telemetry per pool', async () => {
    const device = makeMockDevice();
    const frameUniforms = makeUniformBuffer(device);
    const pools = makePools(device);
    const pass = await createSceneryPass({
      device,
      format: 'bgra8unorm',
      frameUniforms,
      sproutUniforms: frameUniforms,
      pools,
    });
    expect(pass.telemetry.pools.length).toBe(3);
    expect(pass.telemetry.pools[0].kind).toBe('foliage');
    expect(pass.telemetry.pools[0].instanceCount).toBe(32);
    pass.encode(makeFrameCtx(device));
    expect(pass.telemetry.dispatchCount).toBe(3);
    expect(pass.telemetry.drawCount).toBe(3);
    pass.dispose();
    for (const p of pools) p.dispose();
  });

  it('counts dispatches and draws per frame, not since mount (#737 FR2)', async () => {
    const device = makeMockDevice();
    const frameUniforms = makeUniformBuffer(device);
    const pools = makePools(device);
    const pass = await createSceneryPass({ device, format: 'bgra8unorm', frameUniforms, sproutUniforms: frameUniforms, pools });
    pass.encode(makeFrameCtx(device));
    pass.encode(makeFrameCtx(device));
    expect(pass.telemetry.dispatchCount).toBe(3);
    expect(pass.telemetry.drawCount).toBe(3);
    expect(pass.telemetry.spriteDraws).toBe(3);
    pass.dispose();
    for (const p of pools) p.dispose();
  });

  it('reads back how many instances each pool\'s cull kept (#737 FR4)', async () => {
    const device = makeMockDevice();
    const kept = new Uint32Array([7, 0, 3]);
    const copies: Array<[number, number, number]> = [];
    const realCreate = device.createBuffer.bind(device);
    let readBuffer: GPUBuffer | null = null;
    device.createBuffer = ((desc: GPUBufferDescriptor) => {
      const b = realCreate(desc);
      if (desc.usage & GPUBufferUsage.MAP_READ) {
        readBuffer = b;
        (b as unknown as { getMappedRange: () => ArrayBuffer }).getMappedRange = () => kept.buffer.slice(0);
      }
      return b;
    }) as typeof device.createBuffer;
    const frameUniforms = makeUniformBuffer(device);
    const pools = makePools(device);
    const pass = await createSceneryPass({ device, format: 'bgra8unorm', frameUniforms, sproutUniforms: frameUniforms, pools });
    expect(readBuffer).not.toBeNull();
    expect(pass.telemetry.pools.map((p) => p.drawn)).toEqual([-1, -1, -1]);
    const ctx = makeFrameCtx(device);
    (ctx.encoder as unknown as { copyBufferToBuffer: unknown }).copyBufferToBuffer = (
      _src: GPUBuffer, srcOffset: number, dst: GPUBuffer, dstOffset: number, size: number,
    ) => { if (dst === readBuffer) copies.push([srcOffset, dstOffset, size]); };
    pass.encode(ctx);
    // instanceCount is the second u32 of each pool's indirect args.
    expect(copies).toEqual([[4, 0, 4], [4, 4, 4], [4, 8, 4]]);
    pass.afterSubmit?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(pass.telemetry.pools.map((p) => p.drawn)).toEqual([7, 0, 3]);
    // Not every frame: the next copy waits out the interval.
    copies.length = 0;
    pass.encode(ctx);
    expect(copies).toEqual([]);
    pass.dispose();
    for (const p of pools) p.dispose();
  });

  it('uses the default max distance when none is supplied', () => {
    expect(DEFAULT_MAX_DISTANCE).toBe(320);
  });

  it('creates a 1×1 placeholder atlas when no foliageAtlasView is supplied', async () => {
    // The pass has to bind a texture to its frame bind-group, so when a
    // caller mounts it without a real atlas (unit tests) it falls back to a
    // tiny placeholder; mount succeeds, dispose stays idempotent.
    const device = makeMockDevice();
    const frameUniforms = makeUniformBuffer(device);
    const pools = makePools(device);
    const pass = await createSceneryPass({
      device,
      format: 'bgra8unorm',
      frameUniforms,
      sproutUniforms: frameUniforms,
      pools,
    });
    expect(pass.name).toBe('scenery');
    pass.dispose();
    for (const p of pools) p.dispose();
  });

  // Dan reported sprite trees rendering as pale, washed-out silhouettes
  // against a saturated bank and sky — the exponential fog ramp bleached
  // them to near-pure `fogCol = (0.72, 0.78, 0.82)` even at short range,
  // because the sprite's alpha is `fade * tex.a` so the premult RGB ends
  // up mixed with the actual sky behind. Buildings and the bank don't
  // apply fog at all. #678 followup drops fog from the sprite pass so the
  // trees render at their authored brightness, matching the buildings.
  it('sprite flora pass does not blend with a fog-colour constant', () => {
    // Strip // line comments, then assert: no literal pale-blue fog
    // colour, and no `mix(..., fogCol, …)` expression. The uniform struct
    // still declares `fog` (shared Frame layout) — that's fine.
    const code = sceneryWgsl.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/fogCol/);
    expect(code).not.toMatch(/vec3<f32>\s*\(\s*0\.72\s*,\s*0\.78\s*,\s*0\.82/);
  });

  it('refuses work after dispose', async () => {
    const device = makeMockDevice();
    const frameUniforms = makeUniformBuffer(device);
    const pools = makePools(device);
    const pass = await createSceneryPass({
      device,
      format: 'bgra8unorm',
      frameUniforms,
      sproutUniforms: frameUniforms,
      pools,
    });
    pass.dispose();
    pass.encode(makeFrameCtx(device));
    expect(device.__log.computeDispatches).toBe(0);
    expect(device.__log.indirectDraws).toBe(0);
    for (const p of pools) p.dispose();
  });
});
