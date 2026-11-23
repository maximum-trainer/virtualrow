import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createBankPass, meanLinearGrass } from '../bank';
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
  it('creates a ground pipeline that never writes or tests depth', () => {
    const { device, pipelines } = makeDevice();
    createBankPass(opts(device));
    const ground = pipelines.find((p) => p.label === 'bank-ground');
    expect(ground).toBeTruthy();
    expect(ground!.vertex.entryPoint).toBe('vs_ground');
    // No depth write and no depth test: the plane can never z-fight the
    // water or hide anything, whatever the distance.
    expect(ground!.depthStencil.depthWriteEnabled).toBe(false);
    expect(ground!.depthStencil.depthCompare).toBe('always');
  });

  it('draws the ground before the bank strips', () => {
    const { device } = makeDevice();
    const pass = createBankPass(opts(device));
    const { ctx, calls } = makeCtx();
    pass.encode(ctx);
    const ground = calls.indexOf('pipeline:bank-ground');
    const bank = calls.indexOf('pipeline:bank');
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(bank).toBeGreaterThan(ground);
    expect(calls.filter((c) => c.startsWith('draw:')).length).toBe(2);
  });

  it('fades by alpha, so ground, bank and water all blend into the sky behind', () => {
    const { device, pipelines, modules } = makeDevice();
    createBankPass(opts(device));
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

describe('horizon haze range', () => {
  it('is generated from the plan constants, not typed twice', () => {
    expect(HORIZON_HAZE_WGSL).toContain(`const HAZE_START_M: f32 = ${GROUND_HAZE_START_M.toFixed(1)};`);
    expect(HORIZON_HAZE_WGSL).toContain(`const HAZE_END_M: f32 = ${GROUND_HAZE_END_M.toFixed(1)};`);
    expect(read('bank.wgsl')).not.toContain('const HAZE_START_M');
  });

  it('fields begin inside the bank strip and are complete at its outer edge', () => {
    const src = read('bank.wgsl');
    expect(src).toContain('const GROUND_SHORE_DIST_M: f32 = 60.0;');
    expect(src).toMatch(/smoothstep\(\s*FIELD_BLEND_START_M\s*,\s*GROUND_SHORE_DIST_M/);
  });
});
