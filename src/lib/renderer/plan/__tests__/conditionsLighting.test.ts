// #730 VP-12 — the rower's Conditions choice (Dawn / Midday / Golden hour /
// Overcast / Dusk) mapped onto the engine's frame lighting. Pure: the scene
// writes the result into uniforms, the shaders only read numbers.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_LIGHTING,
  ENGINE_DEFAULT_SUN_DIR,
  conditionsToFrameLighting,
  isLightingConditions,
} from '../conditionsLighting';
import { CONDITIONS, type Conditions } from '../../../../components/rower3d/conditions';

const len = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);
const sameDir = (a: readonly number[], b: readonly number[]): number => {
  const la = len(a);
  const lb = len(b);
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
};
const meanSky = (l: ReturnType<typeof conditionsToFrameLighting>): number =>
  (l.skyZenith[0] + l.skyZenith[1] + l.skyZenith[2] + l.skyHorizonCool[0] + l.skyHorizonCool[1] + l.skyHorizonCool[2]) / 6;

describe('conditionsToFrameLighting (#730 FR2)', () => {
  it('reproduces today\'s frame when no conditions are passed (FR6)', () => {
    const l = conditionsToFrameLighting(undefined);
    expect(l).toEqual(DEFAULT_FRAME_LIGHTING);
    expect(Array.from(l.sunDir)).toEqual(Array.from(ENGINE_DEFAULT_SUN_DIR));
    expect(Array.from(ENGINE_DEFAULT_SUN_DIR)).toEqual([0.3, 0.8, 0.5]);
    // Every multiplier the shaders apply is exactly the identity, so the
    // shader maths is bit-for-bit what it was before conditions existed.
    expect(l.sun).toEqual([1, 1, 1]);
    expect(l.ambient).toEqual([1, 1, 1]);
    expect(l.cloudTint).toEqual([1, 1, 1]);
    expect(l.waterTint).toEqual([1, 1, 1]);
    expect(l.fogTint).toEqual([1, 1, 1]);
    expect(l.skyZenith).toEqual([0.32, 0.52, 0.86]);
    expect(l.skyHorizonCool).toEqual([0.7, 0.8, 0.92]);
    expect(l.skyHorizonWarm).toEqual([0.98, 0.8, 0.55]);
    expect(l.sunDiscColour).toEqual([1, 0.95, 0.85]);
    expect(l.sunDisc).toBe(1);
    expect(l.shadowStrength).toBe(1);
    expect(l.cloudThresholdShift).toBe(0);
    expect(l.cloudAlpha).toBe(0.85);
    expect(l.waterSpecular).toBe(0);
    expect(l.exposureBias).toBe(0);
    expect(l.fogDensityScale).toBe(1);
  });

  it('treats Midday as the engine default, so the shipped baselines stay valid', () => {
    expect({ ...conditionsToFrameLighting('midday'), name: 'default' }).toEqual(DEFAULT_FRAME_LIGHTING);
    expect(conditionsToFrameLighting('midday').name).toBe('midday');
  });

  it('ignores an unknown value and falls back to the default', () => {
    expect(conditionsToFrameLighting('noon' as unknown as Conditions)).toEqual(DEFAULT_FRAME_LIGHTING);
    expect(isLightingConditions('noon')).toBe(false);
    for (const c of CONDITIONS) expect(isLightingConditions(c)).toBe(true);
  });

  it.each(['dawn', 'golden', 'overcast', 'dusk'] as const)('%s differs from Midday', (c) => {
    const l = conditionsToFrameLighting(c);
    const m = conditionsToFrameLighting('midday');
    expect(l.name).toBe(c);
    expect(sameDir(l.sunDir, m.sunDir)).toBeLessThan(0.99);
    expect(l.sun).not.toEqual(m.sun);
    expect(l.fogTint).not.toEqual(m.fogTint);
  });

  it('ports the legacy sun elevations (themeConfig presets)', () => {
    expect(conditionsToFrameLighting('dawn').sunElevationDeg).toBe(8);
    expect(conditionsToFrameLighting('golden').sunElevationDeg).toBe(12);
    expect(conditionsToFrameLighting('overcast').sunElevationDeg).toBe(40);
    expect(conditionsToFrameLighting('dusk').sunElevationDeg).toBe(4);
    // Midday keeps the engine's tuned sun, which sits within 1.5° of the
    // legacy 55°.
    expect(conditionsToFrameLighting('midday').sunElevationDeg).toBeCloseTo(53.9, 1);
  });

  it('derives the sun direction from the elevation it reports (FR3: shadows use the same sun)', () => {
    for (const c of CONDITIONS) {
      const l = conditionsToFrameLighting(c);
      const elev = (Math.asin(l.sunDir[1] / len(l.sunDir)) * 180) / Math.PI;
      expect(elev).toBeCloseTo(l.sunElevationDeg, 4);
    }
  });

  it('keeps the legacy order of the sun across the sky (dawn east of midday, dusk west)', () => {
    const az = (c: Conditions): number => conditionsToFrameLighting(c).sunAzimuthDeg;
    expect(az('dawn')).toBeLessThan(az('midday'));
    expect(az('midday')).toBeLessThan(az('golden'));
    expect(az('golden')).toBeLessThan(az('dusk'));
  });

  it('warms the sun at the low-sun presets and dims it below Midday', () => {
    for (const c of ['dawn', 'golden', 'dusk'] as const) {
      const l = conditionsToFrameLighting(c);
      expect(l.sun[0]).toBeGreaterThan(l.sun[2]);
      expect(l.sun[1]).toBeGreaterThan(l.sun[2]);
      expect(l.sun[0]).toBeLessThanOrEqual(1);
    }
  });

  it('gives a dusk sky that is darker than the midday sky', () => {
    expect(meanSky(conditionsToFrameLighting('dusk'))).toBeLessThan(meanSky(conditionsToFrameLighting('midday')));
  });

  it('lifts exposure for the dim presets so the scene stays readable', () => {
    expect(conditionsToFrameLighting('dusk').exposureBias).toBeGreaterThan(0);
    expect(conditionsToFrameLighting('overcast').exposureBias).toBeGreaterThan(0);
    expect(conditionsToFrameLighting('dusk').exposureBias).toBeLessThanOrEqual(0.5);
  });

  it('thickens the fog where the legacy preset pulls it in', () => {
    expect(conditionsToFrameLighting('overcast').fogDensityScale).toBeCloseTo(2, 6);
    expect(conditionsToFrameLighting('dawn').fogDensityScale).toBeGreaterThan(1);
  });

  it('adds a low-sun glint on the water, never at Midday or under cloud', () => {
    expect(conditionsToFrameLighting('golden').waterSpecular).toBeGreaterThan(0);
    expect(conditionsToFrameLighting('dusk').waterSpecular).toBeGreaterThan(conditionsToFrameLighting('golden').waterSpecular);
    expect(conditionsToFrameLighting('overcast').waterSpecular).toBe(0);
  });
});

describe('Overcast (#730 FR4)', () => {
  const o = conditionsToFrameLighting('overcast');

  it('draws no sun disc', () => {
    expect(o.sunDisc).toBe(0);
  });

  it('has at least 0.8 cloud cover, with the cloud band thickened to match', () => {
    expect(o.cloudCover).toBeGreaterThanOrEqual(0.8);
    expect(o.cloudThresholdShift).toBeGreaterThan(0.3);
    expect(o.cloudAlpha).toBeGreaterThan(0.85);
    expect(o.cloudAlpha).toBeLessThanOrEqual(1);
  });

  it('softens the shadows', () => {
    expect(o.shadowStrength).toBeGreaterThan(0);
    expect(o.shadowStrength).toBeLessThan(0.5);
  });

  it('greys the zenith', () => {
    const z = o.skyZenith;
    const m = conditionsToFrameLighting('midday').skyZenith;
    expect(z[2] - z[0]).toBeLessThan(m[2] - m[0]);
  });

  it('every other preset keeps the sun disc and full shadows', () => {
    for (const c of ['dawn', 'midday', 'golden', 'dusk'] as const) {
      const l = conditionsToFrameLighting(c);
      expect(l.sunDisc).toBe(1);
      expect(l.shadowStrength).toBe(1);
      expect(l.cloudCover).toBeLessThan(0.8);
    }
  });
});
