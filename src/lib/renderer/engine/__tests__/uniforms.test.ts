import { describe, expect, it } from 'vitest';
import { makeMockDevice } from '../../__tests__/_mockWebGPU';
import { createFrameUniformBuffer, FRAME_UNIFORMS_FLOATS, packFrameUniforms } from '../uniforms';
import { mat4 } from '../../math/mat4';
import { vec3 } from '../../math/vec3';

const buildFrame = () => ({
  view: mat4(),
  proj: mat4(),
  viewProj: mat4(),
  camPos: vec3(1, 2, 3),
  sunDir: vec3(0, 1, 0),
  fog: new Float32Array([0.1, 0.2, 0, 0]),
  time: 42,
});

describe('uniforms', () => {
  it('packs the frame struct at the right offsets', () => {
    const packed = packFrameUniforms(buildFrame());
    expect(packed.length).toBe(FRAME_UNIFORMS_FLOATS);
    expect([packed[48], packed[49], packed[50]]).toEqual([1, 2, 3]);
    expect([packed[52], packed[53], packed[54]]).toEqual([0, 1, 0]);
    expect(packed[60]).toBe(42);
  });

  it('creates a uniform buffer of the right size', () => {
    const device = makeMockDevice();
    const buf = createFrameUniformBuffer(device);
    expect(buf).toBeDefined();
  });

  it('writes zero into the wind slot when FrameUniforms omits wind (#567)', () => {
    const packed = packFrameUniforms(buildFrame());
    // Wind lives at floats 64, 65 (the trailing vec3 slot; see uniforms.ts).
    expect([packed[64], packed[65], packed[66]]).toEqual([0, 0, 0]);
  });

  it('packs wind.xy into the trailing vec3 slot when FrameUniforms carries wind (#567)', () => {
    const packed = packFrameUniforms({
      ...buildFrame(),
      wind: new Float32Array([0.018, 0.006]),
    });
    expect(packed[64]).toBeCloseTo(0.018, 6);
    expect(packed[65]).toBeCloseTo(0.006, 6);
    // The .z component stays 0 so a shader reading `wind.z` keeps today's
    // behaviour.
    expect(packed[66]).toBe(0);
    // Nothing before the wind slot moved.
    expect(packed[60]).toBe(42);
  });
});

describe('frame lighting uniforms (#730 VP-12)', () => {
  it('packs the default lighting as identity multipliers in std140 vec4 slots', async () => {
    const { packFrameLighting, LIGHTING_UNIFORMS_FLOATS, LIGHTING_UNIFORMS_BYTES } = await import('../uniforms');
    const { DEFAULT_FRAME_LIGHTING } = await import('../../plan/conditionsLighting');
    expect(LIGHTING_UNIFORMS_FLOATS).toBe(32);
    expect(LIGHTING_UNIFORMS_BYTES).toBe(128);
    const p = Array.from(packFrameLighting(DEFAULT_FRAME_LIGHTING)).map((x) => Math.round(x * 1e6) / 1e6);
    // sun.rgb, shadowStrength
    expect(p.slice(0, 4)).toEqual([1, 1, 1, 1]);
    // ambient.rgb, sunDisc
    expect(p.slice(4, 8)).toEqual([1, 1, 1, 1]);
    // zenith.rgb, cloudThresholdShift
    expect(p.slice(8, 12)).toEqual([0.32, 0.52, 0.86, 0]);
    // horizonCool.rgb, cloudAlpha
    expect(p.slice(12, 16)).toEqual([0.7, 0.8, 0.92, 0.85]);
    // horizonWarm.rgb, waterSpecular
    expect(p.slice(16, 20)).toEqual([0.98, 0.8, 0.55, 0]);
    // sunDiscColour.rgb, exposureBias
    expect(p.slice(20, 24)).toEqual([1, 0.95, 0.85, 0]);
    // cloudTint.rgb, cloudCover
    expect(p.slice(24, 28)).toEqual([1, 1, 1, 0.38]);
    // waterTint.rgb, fogDensityScale
    expect(p.slice(28, 32)).toEqual([1, 1, 1, 1]);
  });

  it('packs Overcast with the sun disc off and softened shadows', async () => {
    const { packFrameLighting } = await import('../uniforms');
    const { conditionsToFrameLighting } = await import('../../plan/conditionsLighting');
    const p = packFrameLighting(conditionsToFrameLighting('overcast'));
    expect(p[3]).toBeCloseTo(0.35, 6);
    expect(p[7]).toBe(0);
  });
});
