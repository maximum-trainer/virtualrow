import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AO_MAX_DARKENING,
  CA_MAX_OFFSET_UV,
  EXPOSURE_ADAPT_TAU_S,
  EXPOSURE_CLAMP_EV,
  EXPOSURE_KEY,
  adaptLogLuminance,
  applyAmbientOcclusion,
  autoExposureScale,
  bilateralDepthWeight,
  chromaticAberrationScale,
  meteringWeight,
} from '../postFxMath';
import { tierCapsFor } from '../tierCaps';

// #732 VP-14: `high` must not look worse than `medium`.

describe('chromatic aberration (FR1)', () => {
  it('is off by default at every tier', () => {
    for (const tier of ['basic', 'low', 'medium', 'high', 'extra-high'] as const) {
      expect(tierCapsFor(tier).drawChromaticAberration, tier).toBe(false);
    }
  });

  it('is at most 0.0012 UV and leaves the centre 60% of the frame untouched', () => {
    expect(CA_MAX_OFFSET_UV).toBeLessThanOrEqual(0.0012);
    // 60% of the centre-to-corner radius, along the diagonal.
    const edge = 0.5 + (0.6 * 0.5);
    expect(chromaticAberrationScale([0.5, 0.5])).toBe(0);
    expect(chromaticAberrationScale([edge - 1e-3, edge - 1e-3])).toBe(0);
    expect(chromaticAberrationScale([1, 1])).toBeCloseTo(1, 6);
    // Rises with the square of the distance past the clear zone.
    const mid = 0.5 + 0.8 * 0.5;
    expect(chromaticAberrationScale([mid, mid])).toBeCloseTo(0.25, 6);
  });
});

describe('auto-exposure (FR2)', () => {
  it('stays within ±0.7 EV of the authored exposure', () => {
    const limit = Math.pow(2, EXPOSURE_CLAMP_EV);
    expect(autoExposureScale(100)).toBeCloseTo(1 / limit, 6);
    expect(autoExposureScale(1e-6)).toBeCloseTo(limit, 6);
    expect(autoExposureScale(EXPOSURE_KEY)).toBeCloseTo(1, 6);
  });

  it('keys on the authored daylight level, the same number as the shader (#732)', () => {
    const wgsl = readFileSync(resolve(__dirname, '../../passes/composite.wgsl'), 'utf8');
    const key = Number(/const EXPOSURE_KEY: f32 = ([0-9.]+);/.exec(wgsl)?.[1]);
    expect(key).toBe(EXPOSURE_KEY);
    expect(EXPOSURE_KEY).toBe(0.3);
  });

  it('adapts over at least 1.5 s', () => {
    let log = 0;
    for (let t = 0; t < 1.5; t += 1 / 60) log = adaptLogLuminance(log, 1, 1 / 60);
    expect(log).toBeLessThan(0.95);
    expect(log).toBeGreaterThan(0.8);
    expect(EXPOSURE_ADAPT_TAU_S * 3).toBeGreaterThanOrEqual(1.5);
    expect(adaptLogLuminance(Number.NaN, -2, 1 / 60)).toBe(-2);
  });

  it('meters the lower 60% of the frame, weighted to the centre', () => {
    expect(meteringWeight([0.5, 0.2])).toBe(0);
    expect(meteringWeight([0.5, 0.39])).toBe(0);
    expect(meteringWeight([0.5, 0.7])).toBeGreaterThan(meteringWeight([0.05, 0.7]));
    expect(meteringWeight([0.5, 0.7])).toBeGreaterThan(meteringWeight([0.5, 0.98]));
  });
});

describe('SSAO (FR3)', () => {
  it('darkens by at most 35% and never brightens', () => {
    expect(applyAmbientOcclusion(0)).toBeCloseTo(1 - AO_MAX_DARKENING, 6);
    expect(applyAmbientOcclusion(0.9)).toBe(0.9);
    expect(applyAmbientOcclusion(1.4)).toBe(1);
  });

  it('blurs across similar depths, not across a depth edge', () => {
    expect(bilateralDepthWeight(20, 20)).toBe(1);
    expect(bilateralDepthWeight(20, 20.5)).toBeGreaterThan(0.9);
    expect(bilateralDepthWeight(20, 200)).toBeLessThan(1e-6);
  });
});
