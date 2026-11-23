import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostFx, postFxBytes, DEFAULT_POSTFX_CAPS, type PostFxCaps } from '../postFx';
import type { FrameContext } from '../frameGraph';
import { installGPUStub, makeMockAdapter, makeMockDevice, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { mat4 } from '../../math/mat4';
import { vec3 } from '../../math/vec3';

// #732: the high tier's SSAO is half resolution and bilaterally blurred, and
// auto-exposure adapts from last frame's value (two luminance textures).

beforeEach(() => installGPUStub(makeMockGPU(makeMockAdapter())));
afterEach(() => installGPUStub(undefined));

const view = () => ({}) as GPUTextureView;
const tex = () => ({ destroy: () => undefined }) as unknown as GPUTexture;

const build = async (caps: Partial<PostFxCaps>) => {
  const device = makeMockDevice();
  const textures: { label: string; width: number; height: number; view: GPUTextureView }[] = [];
  const realCreateTexture = device.createTexture.bind(device);
  device.createTexture = ((desc: GPUTextureDescriptor) => {
    const t = realCreateTexture(desc);
    const size = desc.size as GPUExtent3DDict;
    const v = {} as GPUTextureView;
    textures.push({ label: desc.label ?? '', width: size.width, height: size.height ?? 1, view: v });
    return { ...t, createView: () => v, destroy: () => undefined } as unknown as GPUTexture;
  }) as GPUDevice['createTexture'];
  const handle = await createPostFx({
    device,
    sceneFormat: 'rgba16float',
    outputFormat: 'bgra8unorm',
    caps: { ...DEFAULT_POSTFX_CAPS, ...caps },
  });
  handle.setInputs({ sceneView: view(), sceneTexture: tex(), depthView: view(), width: 320, height: 240 });
  return { device, handle, textures };
};

const ctxAt = (device: GPUDevice, time: number, passes: GPURenderPassDescriptor[]): FrameContext => {
  const encoder = device.createCommandEncoder();
  const begin = encoder.beginRenderPass.bind(encoder);
  return {
    device,
    encoder: {
      ...encoder,
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        passes.push(desc);
        return begin(desc);
      },
    } as GPUCommandEncoder,
    swapView: view(),
    outputView: view(),
    depthView: view(),
    width: 320,
    height: 240,
    frame: { view: mat4(), proj: mat4(), viewProj: mat4(), camPos: vec3(), sunDir: vec3(0, 1, 0), fog: new Float32Array(4), time },
    colorCleared: true,
    depthCleared: true,
  };
};

describe('half-resolution SSAO with a bilateral blur (#732 FR3)', () => {
  it('builds the blur pipeline and two half-resolution AO targets', async () => {
    const { device, handle, textures } = await build({ ssao: true });
    expect(device.__log.createdPipelines).toContain('ssao-blur');
    const ao = textures.filter((t) => t.label.startsWith('postfx-ssao'));
    expect(ao.map((t) => [t.label, t.width, t.height])).toEqual([
      ['postfx-ssao', 160, 120],
      ['postfx-ssao-blur', 160, 120],
    ]);
    handle.dispose();
  });

  it('blurs the AO after SSAO and before the composite', async () => {
    const { device, handle } = await build({ ssao: true });
    const passes: GPURenderPassDescriptor[] = [];
    handle.pass.encode(ctxAt(device, 0, passes));
    const labels = passes.map((p) => p.label);
    expect(labels.indexOf('ssao')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('ssao-blur')).toBe(labels.indexOf('ssao') + 1);
    expect(labels.indexOf('composite')).toBeGreaterThan(labels.indexOf('ssao-blur'));
    handle.dispose();
  });

  it('counts the two half-resolution targets in the memory budget', () => {
    const base: PostFxCaps = { ...DEFAULT_POSTFX_CAPS, ssao: false };
    expect(postFxBytes(320, 240, { ...base, ssao: true }) - postFxBytes(320, 240, base)).toBe(2 * 160 * 120);
  });

  it('skips the blur when SSAO is off', async () => {
    const { device, handle } = await build({ ssao: false });
    expect(device.__log.createdPipelines).not.toContain('ssao-blur');
    handle.dispose();
  });
});

describe('temporally adapted auto-exposure (#732 FR2)', () => {
  it('alternates the two exposure textures, reading last frame and writing this one', async () => {
    const { device, handle, textures } = await build({ autoExposure: true });
    const exposure = textures.filter((t) => t.label.startsWith('auto-exposure-1x1'));
    expect(exposure).toHaveLength(2);
    const written: GPUTextureView[] = [];
    for (let i = 0; i < 3; i += 1) {
      const passes: GPURenderPassDescriptor[] = [];
      handle.pass.encode(ctxAt(device, i / 60, passes));
      const lum = passes.find((p) => p.label === 'luminance');
      written.push([...lum!.colorAttachments][0]!.view as GPUTextureView);
    }
    expect(written[0]).not.toBe(written[1]);
    expect(written[2]).toBe(written[0]);
    expect(exposure.map((t) => t.view)).toEqual(expect.arrayContaining([written[0], written[1]]));
    handle.dispose();
  });

  it('sends the frame delta and resets on the first frame', async () => {
    const { device, handle } = await build({ autoExposure: true });
    const writes: number[][] = [];
    vi.spyOn(device.queue, 'writeBuffer').mockImplementation((buffer, _o, data) => {
      if ((buffer as GPUBuffer).label === 'luminance-u') writes.push([...(data as Float32Array).slice(0, 2)]);
    });
    handle.pass.encode(ctxAt(device, 10, []));
    handle.pass.encode(ctxAt(device, 10.5, []));
    expect(writes[0]).toEqual([0, 1]);
    expect(writes[1][0]).toBeCloseTo(0.5, 6);
    expect(writes[1][1]).toBe(0);
    handle.dispose();
  });
});
