import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createBankPass, GROUND_BIOME_OFFSET, meanLinearGrass } from '../bank';
import { BANK_BIOME_SLOTS, BANK_BIOME_WEIGHTS } from '../../plan/bankBiome';
import { HORIZON_BLEND, HORIZON_HAZE_WGSL } from '../../engine/shaderSnippets';
import { GROUND_HAZE_END_M, GROUND_HAZE_START_M } from '../../plan/groundPlane';

const passesDir = dirname(fileURLToPath(import.meta.url)) + '/..';
const read = (f: string) => readFileSync(join(passesDir, f), 'utf8');

beforeAll(() => {
  const g = globalThis as unknown as Record<string, Record<string, number>>;
  g.GPUBufferUsage = { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 };
  g.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
});

interface PipelineDesc {
  label: string;
  vertex: { entryPoint: string };
  depthStencil: { depthWriteEnabled: boolean; depthCompare: string };
}

const makeDevice = () => {
  const pipelines: PipelineDesc[] = [];
  const modules: string[] = [];
  const device = {
    createShaderModule: vi.fn((d: { code: string }) => { modules.push(d.code); return {}; }),
    createRenderPipeline: vi.fn((d: PipelineDesc) => {
      pipelines.push(d);
      return { label: d.label, getBindGroupLayout: vi.fn(() => ({})) };
    }),
    createBuffer: vi.fn((d: { size: number }) => ({ size: d.size, destroy: vi.fn() })),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createSampler: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
  };
  return { device: device as unknown as GPUDevice, pipelines, modules };
};

const makeCtx = () => {
  const calls: string[] = [];
  const pass = {
    setPipeline: vi.fn((p: { label: string }) => calls.push(`pipeline:${p.label}`)),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    drawIndexed: vi.fn((n: number) => calls.push(`draw:${n}`)),
    end: vi.fn(),
  };
  const ctx = {
    encoder: { beginRenderPass: vi.fn(() => pass) },
    swapView: {},
    depthView: {},
  };
  return { ctx: ctx as never, calls };
};

const opts = (device: GPUDevice) => ({
  device,
  format: 'bgra8unorm' as GPUTextureFormat,
  frameUniforms: {} as GPUBuffer,
  lightingUniforms: {} as GPUBuffer,
  shadow: { uniforms: {} as GPUBuffer, atlasView: {} as GPUTextureView, cmpSampler: {} as GPUSampler },
});

describe('bank pass draws the land out to the horizon (#725, #755)', () => {
  it('creates a ground pipeline that never writes or tests depth', async () => {
    const { device, pipelines } = makeDevice();
    await createBankPass(opts(device));
    const ground = pipelines.find((p) => p.label === 'bank-ground');
    expect(ground).toBeTruthy();
    expect(ground!.vertex.entryPoint).toBe('vs_ground');
    // No depth write and no depth test: the plane can never z-fight the
    // water or hide anything, whatever the distance.
    expect(ground!.depthStencil.depthWriteEnabled).toBe(false);
    expect(ground!.depthStencil.depthCompare).toBe('always');
  });

  it('draws the ground before the bank strips', async () => {
    const { device } = makeDevice();
    const pass = await createBankPass(opts(device));
    const { ctx, calls } = makeCtx();
    pass.encode(ctx);
    const ground = calls.indexOf('pipeline:bank-ground');
    const bank = calls.indexOf('pipeline:bank');
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(bank).toBeGreaterThan(ground);
    expect(calls.filter((c) => c.startsWith('draw:')).length).toBe(2);
  });

  it('fades by alpha, so ground, bank and water all blend into the sky behind', async () => {
    const { device, pipelines, modules } = makeDevice();
    await createBankPass(opts(device));
    expect(modules[0]).toContain('fn horizonAlpha(');
    expect(modules[0]).toContain('fn vs_ground(');
    for (const p of pipelines) {
      expect((p as unknown as { fragment: { targets: { blend?: unknown }[] } }).fragment.targets[0].blend)
        .toEqual(HORIZON_BLEND);
    }
    expect(read('water.wgsl')).toContain('horizonAlpha(');
    expect(read('water.ts')).toContain('blend: HORIZON_BLEND');
    expect(read('waterPolygon.ts')).toContain('blend: HORIZON_BLEND');
  });

  it('gives the far ground the mean grass colour in linear space', () => {
    const px = new Uint8Array(128 * 128 * 4).fill(255);
    // Left (grass) half mid-grey sRGB 188 = linear 0.5; right half stays white.
    for (let y = 0; y < 128; y++) for (let x = 0; x < 64; x++) {
      const i = (y * 128 + x) * 4; px[i] = 188; px[i + 1] = 188; px[i + 2] = 188;
    }
    const m = meanLinearGrass(px);
    expect(m[0]).toBeCloseTo(0.5, 1);
    expect(m[1]).toBeCloseTo(0.5, 1);
    expect(m[2]).toBeCloseTo(0.5, 1);
  });
});

describe('ground cover by biome (#725 FR5)', () => {
  it('feeds the strips their biome weights and the shader the biome tints', async () => {
    const { device, pipelines, modules } = makeDevice();
    const pass = await createBankPass(opts(device));
    expect(modules[0]).toContain('const BIOME_TINT_MARSH:');
    const bank = pipelines.find((p) => p.label === 'bank') as unknown as {
      vertex: { buffers: { arrayStride: number; attributes: { shaderLocation: number; format: string }[] }[] };
    };
    expect(bank.vertex.buffers[2].arrayStride).toBe(BANK_BIOME_WEIGHTS * 4);
    expect(bank.vertex.buffers[2].attributes.map((a) => a.format)).toEqual(['float32x4', 'float32']);
    const { ctx } = makeCtx();
    pass.encode(ctx);
    for (const name of ['marsh', 'scrub', 'green', 'woodland', 'meadow', 'fields']) {
      expect(read('bank.wgsl')).toContain(`fn ${name}Ground(`);
    }
  });

  it('turns the ground plane over to the band the boat is in, writing only on a change', async () => {
    const { device } = makeDevice();
    const pass = await createBankPass({
      ...opts(device),
      profileForProgress: (t: number) => (t < 0.5 ? 'farmland' : 'wetland'),
    });
    const write = device.queue.writeBuffer as unknown as ReturnType<typeof vi.fn>;
    const groundWrites = () => write.mock.calls.filter((c) => c[1] === GROUND_BIOME_OFFSET);
    const last = () => groundWrites().at(-1)![2] as Float32Array;
    expect(last()[BANK_BIOME_SLOTS.indexOf('fields')]).toBeCloseTo(1);
    const before = groundWrites().length;
    pass.setBoatProgress(0.1);
    expect(groundWrites().length).toBe(before);
    pass.setBoatProgress(0.9);
    expect(last()[BANK_BIOME_SLOTS.indexOf('marsh')]).toBeCloseTo(1);
    expect(last()[BANK_BIOME_SLOTS.indexOf('fields')]).toBe(0);
  });
});

describe('the ground plane at the land relief (#745 FR1)', () => {
  it('lifts the ground to the relief at the boat and lights the bank from its own slope', async () => {
    const { device } = makeDevice();
    const pass = await createBankPass({ ...opts(device), reliefForProgress: (t: number) => 4 * t });
    const write = device.queue.writeBuffer as unknown as ReturnType<typeof vi.fn>;
    const last = () => write.mock.calls.filter((c) => c[1] === GROUND_BIOME_OFFSET).at(-1)![2] as Float32Array;
    expect(last()[BANK_BIOME_WEIGHTS]).toBe(0);
    pass.setBoatProgress(0.5);
    expect(last()[BANK_BIOME_WEIGHTS]).toBeCloseTo(2);
    const src = read('bank.wgsl');
    expect(src).toContain('position.y + grass.groundLift');
    expect(src).toMatch(/cross\(dpdy\(in\.worldPos\), dpdx\(in\.worldPos\)\)/);
  });
});

describe('the shore of a drawn lake (#745 FR2)', () => {
  it('draws a shore band round each lake after the strips, and none without lakes', async () => {
    const lake = { outer: [{ x: -200, z: -200 }, { x: 200, z: -200 }, { x: 200, z: 200 }, { x: -200, z: 200 }], holes: [] };
    const { device } = makeDevice();
    const pass = await createBankPass({ ...opts(device), lakes: [lake], lakeShoreOnWater: () => false });
    const { ctx, calls } = makeCtx();
    pass.encode(ctx);
    expect(calls.filter((c) => c.startsWith('draw:')).length).toBe(3);
    const plain = makeDevice();
    const none = await createBankPass({ ...opts(plain.device), lakes: [] });
    const quiet = makeCtx();
    none.encode(quiet.ctx);
    expect(quiet.calls.filter((c) => c.startsWith('draw:')).length).toBe(2);
  });
});

describe('horizon haze range', () => {
  it('is generated from the plan constants, not typed twice', () => {
    expect(HORIZON_HAZE_WGSL).toContain(`const HAZE_START_M: f32 = ${GROUND_HAZE_START_M.toFixed(1)};`);
    expect(HORIZON_HAZE_WGSL).toContain(`const HAZE_END_M: f32 = ${GROUND_HAZE_END_M.toFixed(1)};`);
    expect(read('bank.wgsl')).not.toContain('const HAZE_START_M');
  });

  it('the biome ground begins inside the bank strip and is complete at its outer edge', () => {
    const src = read('bank.wgsl');
    expect(src).toContain('const GROUND_SHORE_DIST_M: f32 = 60.0;');
    expect(src).toMatch(/smoothstep\(\s*BIOME_BLEND_START_M\s*,\s*GROUND_SHORE_DIST_M/);
  });
});

describe('the ground from the map land cover (#764 FR1-FR3, FR9)', () => {
  it('uploads the class mask as r8uint, binds it, and switches the shader to it', async () => {
    const { buildLandCoverMask } = await import('../../../scenery/landCoverMask');
    const { LAND_COVER_MASK_OFFSET } = await import('../bank');
    const mask = buildLandCoverMask({
      bounds: { minX: -100, minZ: -50, maxX: 100, maxZ: 50 },
      features: [{ kind: 'wood', shape: 'polygon', points: [[0, 0], [40, 0], [40, 40], [0, 0]] }],
    });
    const { device } = makeDevice();
    const textures = (device.createTexture as unknown as ReturnType<typeof vi.fn>);
    await createBankPass({ ...opts(device), landCover: mask });
    const landCover = textures.mock.calls.map((c) => c[0]).find((d: { label: string }) => d.label === 'bank-land-cover');
    expect(landCover).toMatchObject({ format: 'r8uint', size: { width: mask.width, height: mask.height } });
    const writes = (device.queue.writeTexture as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes.some((c) => c[1] === mask.data)).toBe(true);
    const uniform = (device.queue.writeBuffer as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === LAND_COVER_MASK_OFFSET,
    )!;
    expect(Array.from(uniform[2] as Float32Array)).toEqual([-100, -50, 8, 1, mask.width, mask.height, 0, 0]);
    const groups = (device.createBindGroup as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as { label: string; entries: { binding: number }[] })
      .filter((g) => g.entries.some((e) => e.binding === 5));
    expect(groups).toHaveLength(2);
  });

  it('binds a 1x1 unknown stand-in with the mask off when there is no land cover (FR9)', async () => {
    const { packLandCoverUniform } = await import('../bank');
    const { device } = makeDevice();
    await createBankPass(opts(device));
    const landCover = (device.createTexture as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((d: { label: string }) => d.label === 'bank-land-cover');
    expect(landCover.size).toEqual({ width: 1, height: 1 });
    expect(packLandCoverUniform(null)[3]).toBe(0);
  });

  it('decides the ground by class where it is known and drops invented hedges near real ones', () => {
    const wgsl = read('bank.wgsl');
    expect(wgsl).toContain('var landCover: texture_2d<u32>;');
    expect(wgsl).toContain('fn landCoverAt(');
    // The hash-field patchwork only through the fields weight, and its
    // hedge grid scaled by the near-real-hedge bit.
    expect(wgsl).toMatch(/fieldsGround\(worldXZ, dist, inventedHedges\) \* biome\.x/);
    expect(wgsl).toContain('select(1.0, 0.0, (maskTexel(here) & 128u) != 0u)');
    expect(wgsl).toContain('builtGround(worldXZ, dist) * built');
  });
});
