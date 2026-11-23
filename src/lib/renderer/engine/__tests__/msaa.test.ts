// #731 VP-13 FR3 — 4x MSAA on the scene at medium and up, FXAA below.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import {
  createMsaaResolvePass,
  DEPTH_RESOLVE_WGSL,
  sceneMultisample,
  sceneSampleCountFor,
  setSceneSampleCount,
} from '../msaa';
import { tierCapsFor } from '../tierCaps';
import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import {
  installGPUStub,
  makeMockAdapter,
  makeMockCanvas,
  makeMockDevice,
  makeMockGPU,
  type MockGPULog,
} from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';
import type { FrameContext } from '../frameGraph';

describe('tier anti-aliasing (#731 FR3)', () => {
  it('MSAA at medium and up, FXAA on basic and low', () => {
    expect(tierCapsFor('basic').antialias).toBe('fxaa');
    expect(tierCapsFor('low').antialias).toBe('fxaa');
    for (const tier of ['medium', 'high', 'extra-high'] as const) expect(tierCapsFor(tier).antialias).toBe('msaa');
    expect(sceneSampleCountFor('msaa')).toBe(4);
    expect(sceneSampleCountFor('fxaa')).toBe(1);
    expect(sceneSampleCountFor('none')).toBe(1);
  });

  it('records the scene sample count per device', () => {
    const a = makeMockDevice();
    const b = makeMockDevice();
    expect(sceneMultisample(a)).toEqual({ count: 1 });
    setSceneSampleCount(a, 4);
    expect(sceneMultisample(a)).toEqual({ count: 4 });
    expect(sceneMultisample(b)).toEqual({ count: 1 });
  });
});

describe('the MSAA resolve pass', () => {
  it('the depth resolve shader reads the 4-sample depth and writes frag_depth', () => {
    expect(() => new WgslReflect(DEPTH_RESOLVE_WGSL)).not.toThrow();
    expect(DEPTH_RESOLVE_WGSL).toContain('texture_depth_multisampled_2d');
    expect(DEPTH_RESOLVE_WGSL).toContain('@builtin(frag_depth)');
  });

  it('resolves colour through a resolve target, then draws the depth across', async () => {
    const device = makeMockDevice();
    const pass = await createMsaaResolvePass(device);
    const ctx = { encoder: device.createCommandEncoder(), swapView: {}, depthView: {} } as unknown as FrameContext;
    pass.encode(ctx);
    expect(device.__log.encoderPasses).toEqual([]); // no targets yet
    pass.setTargets({
      sceneView: {} as GPUTextureView,
      msaaDepthTexture: device.createTexture({ label: 'd', size: [1, 1], format: 'depth32float', usage: 0, sampleCount: 4 }),
      depthView: {} as GPUTextureView,
    });
    pass.encode(ctx);
    expect(device.__log.encoderPasses).toEqual(['msaa-colour-resolve', 'msaa-depth-resolve']);
    expect(device.__log.resolvingPasses).toEqual(['msaa-colour-resolve']);
    expect(device.__log.pipelineSampleCounts).toContainEqual({ label: 'msaa-depth-resolve', count: 1 });
  });
});

describe('attach builds the scene at the tier sample count', () => {
  beforeEach(() => {
    installGPUStub(makeMockGPU(makeMockAdapter()));
    resetWebGPUHealth();
  });
  afterEach(() => {
    installGPUStub(undefined);
    releaseTelemetry();
  });

  const SCENE_PIPELINES = ['sky', 'bank', 'water', 'sceneryMesh'];
  const ride = async (tier: string) => {
    const renderer = (await attach(makeMockCanvas(), { testMode: true, tier })) as unknown as {
      _frameOnce(): void;
      _liveDevice: { __log: MockGPULog };
      dispose(): void;
    };
    renderer._frameOnce();
    const log = renderer._liveDevice.__log;
    renderer.dispose();
    return log;
  };

  it('medium: 4-sample scene targets and pipelines, resolved before post-FX', async () => {
    const log = await ride('medium');
    const msaa = log.createdTextures.filter((t) => t.sampleCount === 4).map((t) => t.label);
    expect(msaa).toEqual(expect.arrayContaining(['scene-hdr-msaa', 'depth-msaa']));
    for (const label of SCENE_PIPELINES) {
      expect(log.pipelineSampleCounts.find((p) => p.label === label), label).toEqual({ label, count: 4 });
    }
    // Shadow depth and post-FX stay single-sample.
    for (const p of log.pipelineSampleCounts) {
      if (/depth|cascade|postfx|composite|bloom|fxaa|resolve/i.test(p.label)) expect(p.count, p.label).toBe(1);
    }
    expect(log.resolvingPasses).toContain('msaa-colour-resolve');
    const order = log.encoderPasses;
    const resolveAt = order.indexOf('msaa-depth-resolve');
    expect(resolveAt).toBeGreaterThan(0);
    const firstPost = order.findIndex((n, i) => i > resolveAt && /post|composite|bloom|tonemap/i.test(n));
    expect(firstPost).toBeGreaterThan(resolveAt);
  });

  it('basic: single-sample everywhere, no resolve', async () => {
    const log = await ride('basic');
    expect(log.createdTextures.filter((t) => t.sampleCount !== 1)).toEqual([]);
    expect(log.pipelineSampleCounts.filter((p) => p.count !== 1)).toEqual([]);
    expect(log.encoderPasses).not.toContain('msaa-depth-resolve');
  });
});

describe('particle and rain passes follow the scene sample count', () => {
  it('oarSplashParticles, wakeParticles and rainOverlay build 4-sample pipelines on an MSAA device', async () => {
    const { createOarSplashPass } = await import('../../passes/oarSplashParticles');
    const { createWakeParticlesPass } = await import('../../passes/wakeParticles');
    const { createRainOverlayPass } = await import('../../passes/rainOverlay');
    const { createOarSplashState } = await import('../oarSplashParticles');
    const { createWakeState } = await import('../wakeParticles');
    const device = makeMockDevice();
    setSceneSampleCount(device, 4);
    const frameUniforms = device.createBuffer({ size: 272, usage: 0 });
    const format: GPUTextureFormat = 'rgba16float';
    await createOarSplashPass({ device, format, frameUniforms, state: createOarSplashState() });
    await createWakeParticlesPass({ device, format, frameUniforms, wakeState: createWakeState() });
    await createRainOverlayPass({ device, format, frameUniforms });
    const counts = device.__log.pipelineSampleCounts;
    expect(counts.length).toBeGreaterThanOrEqual(3);
    for (const c of counts) expect(c.count, c.label).toBe(4);
  });
});
