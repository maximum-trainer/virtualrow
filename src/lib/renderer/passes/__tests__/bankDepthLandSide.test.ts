// #755 FR4 — the bank's shadow caster follows the lit bank onto one side.
import { describe, expect, it } from 'vitest';
import { createBankDepthPipeline } from '../bankDepth';
import { makeMockDevice } from '../../__tests__/_mockWebGPU';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';

describe('bankDepth landSide (#755 FR4)', () => {
  it('casts from one bank strip on a coastal course', async () => {
    const curve = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -300)], false);
    const device = makeMockDevice() as unknown as GPUDevice;
    const both = await createBankDepthPipeline(device, { curve, footprint: null });
    const left = await createBankDepthPipeline(device, { curve, footprint: null, landSide: 'left' });
    expect(both.indexCount).toBeGreaterThan(0);
    expect(left.indexCount).toBe(both.indexCount / 2);
  });
});
