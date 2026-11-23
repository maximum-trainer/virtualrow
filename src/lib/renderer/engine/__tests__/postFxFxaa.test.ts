// #731 VP-13 FR3 — FXAA runs last, over the finished frame.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { createPostFx, postFxBytes, DEFAULT_POSTFX_CAPS, type PostFxCaps } from '../postFx';
import { fxaa, type Vec3 } from '../postFxMath';
import type { FrameContext } from '../frameGraph';
import { installGPUStub, makeMockAdapter, makeMockDevice, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { mat4 } from '../../math/mat4';
import { vec3 } from '../../math/vec3';

beforeEach(() => installGPUStub(makeMockGPU(makeMockAdapter())));
afterEach(() => installGPUStub(undefined));

const view = () => ({}) as GPUTextureView;
const tex = () => ({ destroy: () => undefined }) as unknown as GPUTexture;

const run = async (caps: Partial<PostFxCaps>) => {
  const device = makeMockDevice();
  const labels = new Map<GPUTextureView, string>();
  const realCreateTexture = device.createTexture.bind(device);
  device.createTexture = ((desc: GPUTextureDescriptor) => {
    const t = realCreateTexture(desc);
    const v = {} as GPUTextureView;
    labels.set(v, desc.label ?? '');
    return { ...t, createView: () => v, destroy: () => undefined } as unknown as GPUTexture;
  }) as GPUDevice['createTexture'];
  const handle = await createPostFx({ device, sceneFormat: 'rgba16float', outputFormat: 'bgra8unorm', caps: { ...DEFAULT_POSTFX_CAPS, ...caps } });
  handle.setInputs({ sceneView: view(), sceneTexture: tex(), depthView: view(), width: 320, height: 240 });
  const outputView = view();
  labels.set(outputView, 'swap-chain');
  const passes: { label: string; target: string }[] = [];
  const encoder = device.createCommandEncoder();
  const begin = encoder.beginRenderPass.bind(encoder);
  const ctx: FrameContext = {
    device,
    encoder: {
      ...encoder,
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const att = [...desc.colorAttachments][0];
        passes.push({ label: desc.label ?? '', target: labels.get(att?.view as GPUTextureView) ?? '?' });
        return begin(desc);
      },
    } as GPUCommandEncoder,
    swapView: view(),
    outputView,
    depthView: view(),
    width: 320,
    height: 240,
    frame: { view: mat4(), proj: mat4(), viewProj: mat4(), camPos: vec3(), sunDir: vec3(0, 1, 0), fog: new Float32Array(4), time: 1 },
    colorCleared: true,
    depthCleared: true,
  };
  handle.pass.encode(ctx);
  return { passes, handle };
};

describe('FXAA in the post-fx chain (#731 FR3)', () => {
  it('composite writes the swap chain directly when FXAA is off', async () => {
    const { passes } = await run({ fxaa: false });
    expect(passes.find((p) => p.label === 'composite')?.target).toBe('swap-chain');
    expect(passes.some((p) => p.label === 'fxaa')).toBe(false);
  });

  it('composite writes a copy and FXAA writes the swap chain, last', async () => {
    const { passes } = await run({ fxaa: true });
    expect(passes.find((p) => p.label === 'composite')?.target).toBe('postfx-fxaa-input');
    expect(passes.at(-1)).toEqual({ label: 'fxaa', target: 'swap-chain' });
  });

  it('runs after DOF when both are on', async () => {
    const { passes } = await run({ fxaa: true, dof: true });
    expect(passes.find((p) => p.label === 'composite')?.target).toBe('postfx-dof-copy');
    expect(passes.find((p) => p.label === 'dof')?.target).toBe('postfx-fxaa-input');
    expect(passes.at(-1)).toEqual({ label: 'fxaa', target: 'swap-chain' });
  });

  it('counts the FXAA copy in the post-fx memory', () => {
    const off = postFxBytes(320, 240, { ...DEFAULT_POSTFX_CAPS, fxaa: false });
    expect(postFxBytes(320, 240, { ...DEFAULT_POSTFX_CAPS, fxaa: true }) - off).toBe(320 * 240 * 4);
  });

  it('ships a shader that parses and samples by level (legal in non-uniform control flow)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../passes/fxaa.wgsl'), 'utf8');
    expect(() => new WgslReflect(src)).not.toThrow();
    expect(src).not.toMatch(/textureSample\(/);
  });
});

describe('fxaa (CPU twin)', () => {
  const W = 24;
  // A hard diagonal edge: white above y = x / 2, black below — the stair-step FXAA is for.
  const stairs = (x: number, y: number): Vec3 => {
    const cx = Math.max(0, Math.min(W - 1, x));
    const cy = Math.max(0, Math.min(W - 1, y));
    return cy < Math.floor(cx / 2) + 4 ? [1, 1, 1] : [0, 0, 0];
  };

  it('leaves flat areas alone', () => {
    expect(fxaa(() => [0.4, 0.5, 0.6], 5, 5)).toEqual([0.4, 0.5, 0.6]);
  });

  it('softens a stair-step edge, staying inside the local range', () => {
    let softened = 0;
    for (let y = 2; y < W - 2; y += 1) {
      for (let x = 2; x < W - 2; x += 1) {
        const out = fxaa(stairs, x, y);
        for (const c of out) {
          expect(c).toBeGreaterThanOrEqual(-1e-9);
          expect(c).toBeLessThanOrEqual(1 + 1e-9);
        }
        if (out[0] > 0.02 && out[0] < 0.98) softened += 1;
      }
    }
    // Before FXAA every pixel is 0 or 1; after it the stair has grey steps.
    expect(softened).toBeGreaterThan(10);
  });
});
