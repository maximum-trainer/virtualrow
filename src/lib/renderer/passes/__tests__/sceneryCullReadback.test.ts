// #737 VP-19 FR4 — the cull's indirect args can be copied out, so telemetry
// can read how many instances each pool kept.
import { describe, expect, it } from 'vitest';
import { makeMockDevice } from '../../__tests__/_mockWebGPU';
import { createSceneryCuller } from '../sceneryCull';
import { createInstancePool } from '../../plan/instancePools';

describe('sceneryCull indirect args (#737 FR4)', () => {
  it('creates each pool\'s indirect buffer as a copy source', async () => {
    const device = makeMockDevice();
    const usages: Record<string, number> = {};
    const realCreate = device.createBuffer.bind(device);
    device.createBuffer = ((desc: GPUBufferDescriptor) => {
      if (desc.label) usages[desc.label] = desc.usage;
      return realCreate(desc);
    }) as typeof device.createBuffer;
    const pool = createInstancePool(device, {
      kind: 'foliage',
      speciesIndex: 2,
      chunkIndex: 0,
      positions: new Float32Array([0, 0, 0]),
      bounds: { cx: 0, cy: 0, cz: 0, radius: 1 },
    });
    const culler = await createSceneryCuller(device);
    culler.attach(pool, { indexCount: 6, baseVertex: 0, firstIndex: 0 });
    const usage = usages['cull-indirect:foliage:2'];
    expect(usage & GPUBufferUsage.INDIRECT).toBeTruthy();
    expect(usage & GPUBufferUsage.COPY_SRC).toBeTruthy();
  });
});
