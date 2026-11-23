import { beforeAll, describe, expect, it } from 'vitest';
import { makeMockDevice } from '../../__tests__/_mockWebGPU';
import { createOarSplashState } from '../../engine/oarSplashParticles';
import { createWakeState } from '../../engine/wakeParticles';
import { createOarSplashPass } from '../oarSplashParticles';
import { createSceneryDepthPipeline } from '../sceneryDepth';
import { createWakeParticlesPass } from '../wakeParticles';

/**
 * #803 — the passes compile their pipelines with createRenderPipelineAsync,
 * and a pass only resolves once its compile has finished. This covers
 * the passes that have no test of their own (oarSplashParticles,
 * sceneryDepth, wakeParticles).
 */

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage ??= {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
    VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
  };
});

/** A mock device whose async compiles stay pending until `release()`. */
const makeAsyncDevice = () => {
  const device = makeMockDevice();
  const asyncLabels: string[] = [];
  const pending: Array<() => void> = [];
  (device as unknown as { createRenderPipelineAsync: unknown }).createRenderPipelineAsync = (
    desc: GPURenderPipelineDescriptor,
  ) => {
    asyncLabels.push((desc.label ?? '') as string);
    return new Promise<GPURenderPipeline>((resolve) => {
      pending.push(() => resolve(device.createRenderPipeline(desc)));
    });
  };
  const release = () => pending.splice(0).forEach((r) => r());
  return { device, asyncLabels, release };
};

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  return done;
};

const frameUniforms = {} as GPUBuffer;

describe.each([
  ['oarSplashParticles', 'oar-splash', (device: GPUDevice) =>
    createOarSplashPass({ device, format: 'bgra8unorm', frameUniforms, state: createOarSplashState() })],
  ['wakeParticles', 'wake', (device: GPUDevice) =>
    createWakeParticlesPass({ device, format: 'bgra8unorm', frameUniforms, wakeState: createWakeState() })],
  ['sceneryDepth', 'sceneryDepth', (device: GPUDevice) => createSceneryDepthPipeline(device)],
] as const)('%s pass (#803)', (_name, label, create) => {
  it('compiles its pipeline through createRenderPipelineAsync', async () => {
    const { device, asyncLabels, release } = makeAsyncDevice();
    const created: Promise<unknown> = create(device as unknown as GPUDevice);
    release();
    await created;
    expect(asyncLabels).toContain(label);
  });

  it('resolves only once the async compile has finished', async () => {
    const { device, release } = makeAsyncDevice();
    const created: Promise<unknown> = create(device as unknown as GPUDevice);
    expect(await settled(created)).toBe(false);
    release();
    expect(await settled(created)).toBe(true);
  });
});
