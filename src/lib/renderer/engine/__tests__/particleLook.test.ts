// #722 VP-04 — shared look of the wake + oar-splash particles: the
// near-camera fade (FR5) and the pre-exposed foam colour (FR6). Both
// WGSL passes mirror these constants; the mirror is checked here too.

import { describe, expect, it } from 'vitest';
import {
  FOAM_MAX_LUMINANCE,
  PARTICLE_NEAR_FADE_END_METRES,
  PARTICLE_NEAR_FADE_START_METRES,
  foamColour,
  particleNearCameraFade,
} from '../particleLook';
import { luminance } from '../postFxMath';
import { wgslConst } from './wgslConst';

describe('particleNearCameraFade (#722 FR5)', () => {
  it('is fully transparent within 1.5 m of the camera', () => {
    expect(particleNearCameraFade(0)).toBe(0);
    expect(particleNearCameraFade(1)).toBe(0);
    expect(particleNearCameraFade(1.5)).toBe(0);
  });

  it('is fully opaque past the fade end and monotonic in between', () => {
    expect(particleNearCameraFade(PARTICLE_NEAR_FADE_END_METRES)).toBe(1);
    expect(particleNearCameraFade(50)).toBe(1);
    let prev = 0;
    for (let d = PARTICLE_NEAR_FADE_START_METRES; d <= PARTICLE_NEAR_FADE_END_METRES; d += 0.1) {
      const f = particleNearCameraFade(d);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it.each(['wakeParticles.wgsl', 'oarSplashParticles.wgsl'])('%s mirrors the fade distances', (file) => {
    expect(wgslConst(file, 'NEAR_FADE_START')).toBe(PARTICLE_NEAR_FADE_START_METRES);
    expect(wgslConst(file, 'NEAR_FADE_END')).toBe(PARTICLE_NEAR_FADE_END_METRES);
  });
});

describe('foamColour (#722 FR6)', () => {
  it('stays at or below the foam luminance cap for any sun height', () => {
    for (let sunY = -1; sunY <= 1; sunY += 0.05) {
      expect(luminance(foamColour(sunY))).toBeLessThanOrEqual(FOAM_MAX_LUMINANCE + 1e-6);
    }
  });

  it('keeps the cap at or below 1.0 so bloom never treats foam as a light', () => {
    expect(FOAM_MAX_LUMINANCE).toBeLessThanOrEqual(1);
  });

  it.each(['wakeParticles.wgsl', 'oarSplashParticles.wgsl'])('%s mirrors the foam colour', (file) => {
    const [r, g, b] = foamColour(0);
    expect(wgslConst(file, 'FOAM_R')).toBe(r);
    expect(wgslConst(file, 'FOAM_G')).toBe(g);
    expect(wgslConst(file, 'FOAM_B')).toBe(b);
    expect(wgslConst(file, 'FOAM_SUN_WARM')).toBeCloseTo(foamColour(1)[0] - r, 6);
  });
});
