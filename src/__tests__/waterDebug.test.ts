import { describe, expect, it } from 'vitest';
import { createWaterDebugPass } from '../lib/renderer/passes/waterDebug';

/**
 * The pass itself is GPU-bound (createRenderPipeline, writeBuffer, etc.)
 * so its render path is exercised on the T4 runner. What we can lock from
 * jsdom is that the pass skips itself when the input is empty — the
 * frame-graph level then drops it, which keeps the overlay free when the
 * flag is on but nothing has been detected yet.
 */
describe('createWaterDebugPass', () => {
  it('returns null for an empty debug input (no mesh → no pass)', () => {
    const stubDevice = {} as unknown as GPUDevice;
    const stubBuffer = {} as unknown as GPUBuffer;
    const pass = createWaterDebugPass({
      device: stubDevice,
      format: 'bgra8unorm',
      frameUniforms: stubBuffer,
      input: { shorelines: [], islands: [], onLandSamples: [] },
    });
    expect(pass).toBeNull();
  });
});
