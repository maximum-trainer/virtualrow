import { describe, expect, it } from 'vitest';
import { chromaticAberrationEnabled, tierCapsFor } from '../tierCaps';

// Full-shape expected caps for each tier so a new flag is caught in one
// place rather than drifting between the implementation and the test.
const basic = {
  drawBuildings: false,
  drawClouds: false,
  castBuildingShadows: false,
  drawCrew: false,
  castCharacterShadows: false,
  castFloraShadows: false,
  castSceneryShadows: false,
  drawBloom: true,
  drawVignette: true,
  drawLut: true,
  drawSsao: false,
  drawDof: false,
  drawAutoExposure: false,
  drawChromaticAberration: false,
  drawRainOverlay: false,
  drawWakeParticles: false,
  drawOarSplash: false,
  polygonWaterMaxVertices: 256,
  maxBuildingsPerSegment: 0,
  fleetCount: 0,
  castFleetShadows: false,
};
const low = {
  drawBuildings: true,
  drawClouds: false,
  castBuildingShadows: false,
  drawCrew: true,
  castCharacterShadows: false,
  castFloraShadows: false,
  castSceneryShadows: false,
  drawBloom: true,
  drawVignette: true,
  drawLut: true,
  drawSsao: false,
  drawDof: false,
  drawAutoExposure: false,
  drawChromaticAberration: false,
  drawRainOverlay: true,
  drawWakeParticles: true,
  drawOarSplash: true,
  polygonWaterMaxVertices: 512,
  maxBuildingsPerSegment: 8,
  fleetCount: 2,
  castFleetShadows: false,
};
const medium = {
  drawBuildings: true,
  drawClouds: true,
  castBuildingShadows: true,
  drawCrew: true,
  castCharacterShadows: true,
  castFloraShadows: true,
  castSceneryShadows: true,
  drawBloom: true,
  drawVignette: true,
  drawLut: true,
  drawSsao: false,
  drawDof: false,
  drawAutoExposure: false,
  drawChromaticAberration: false,
  drawRainOverlay: true,
  drawWakeParticles: true,
  drawOarSplash: true,
  polygonWaterMaxVertices: 1024,
  maxBuildingsPerSegment: 16,
  fleetCount: 4,
  castFleetShadows: true,
};
const high = {
  drawBuildings: true,
  drawClouds: true,
  castBuildingShadows: true,
  drawCrew: true,
  castCharacterShadows: true,
  castFloraShadows: true,
  castSceneryShadows: true,
  drawBloom: true,
  drawVignette: true,
  drawLut: true,
  drawSsao: true,
  drawDof: false,
  drawAutoExposure: true,
  drawChromaticAberration: false,
  drawRainOverlay: true,
  drawWakeParticles: true,
  drawOarSplash: true,
  polygonWaterMaxVertices: 2048,
  maxBuildingsPerSegment: 32,
  fleetCount: 6,
  castFleetShadows: true,
};
const extraHigh = {
  drawBuildings: true,
  drawClouds: true,
  castBuildingShadows: true,
  drawCrew: true,
  castCharacterShadows: true,
  castFloraShadows: true,
  castSceneryShadows: true,
  drawBloom: true,
  drawVignette: true,
  drawLut: true,
  drawSsao: true,
  drawDof: true,
  drawAutoExposure: true,
  drawChromaticAberration: false,
  drawRainOverlay: true,
  drawWakeParticles: true,
  drawOarSplash: true,
  polygonWaterMaxVertices: 4096,
  maxBuildingsPerSegment: 64,
  fleetCount: 8,
  castFleetShadows: true,
};

describe('tierCaps (P6 D8 + P7 D9 + P8 D8)', () => {
  it('basic: no buildings, no clouds, no crew; bloom/vignette/LUT universal', () => {
    expect(tierCapsFor('basic')).toEqual(basic);
  });

  it('low: buildings + crew; no SSAO/DOF', () => {
    expect(tierCapsFor('low')).toEqual(low);
  });

  it('medium: all shadow casts; no SSAO/DOF', () => {
    expect(tierCapsFor('medium')).toEqual(medium);
  });

  it('high: SSAO on; DOF still off', () => {
    expect(tierCapsFor('high')).toEqual(high);
  });

  it('extra-high: SSAO + DOF on', () => {
    expect(tierCapsFor('extra-high')).toEqual(extraHigh);
  });

  it('an unknown tier string falls back to the default (medium) caps', () => {
    expect(tierCapsFor('fancy')).toEqual(tierCapsFor('medium'));
  });

  it('undefined falls back to the default caps', () => {
    expect(tierCapsFor(undefined)).toEqual(tierCapsFor('medium'));
  });

  it('rain overlay is off on basic, available from low upward (#574)', () => {
    expect(tierCapsFor('basic').drawRainOverlay).toBe(false);
    for (const t of ['low', 'medium', 'high', 'extra-high'] as const) {
      expect(tierCapsFor(t).drawRainOverlay, t).toBe(true);
    }
  });

  it('oar splash is off on basic but on from low upward (#571)', () => {
    expect(tierCapsFor('basic').drawOarSplash).toBe(false);
    for (const t of ['low', 'medium', 'high', 'extra-high'] as const) {
      expect(tierCapsFor(t).drawOarSplash, t).toBe(true);
    }
  });

  it('flora + scenery shadow casts turn on at medium and stay on above (#591-fu P1c)', () => {
    for (const t of ['basic', 'low'] as const) {
      expect(tierCapsFor(t).castFloraShadows, t).toBe(false);
      expect(tierCapsFor(t).castSceneryShadows, t).toBe(false);
    }
    for (const t of ['medium', 'high', 'extra-high'] as const) {
      expect(tierCapsFor(t).castFloraShadows, t).toBe(true);
      expect(tierCapsFor(t).castSceneryShadows, t).toBe(true);
    }
  });

  it('auto-exposure turns on at high and stays on above (#574)', () => {
    for (const t of ['basic', 'low', 'medium'] as const) {
      expect(tierCapsFor(t).drawAutoExposure, t).toBe(false);
    }
    for (const t of ['high', 'extra-high'] as const) {
      expect(tierCapsFor(t).drawAutoExposure, t).toBe(true);
    }
  });

  it('chromatic aberration is off at every tier by default (#732)', () => {
    for (const t of ['basic', 'low', 'medium', 'high', 'extra-high'] as const) {
      expect(tierCapsFor(t).drawChromaticAberration, t).toBe(false);
      expect(chromaticAberrationEnabled(tierCapsFor(t)), t).toBe(false);
    }
  });

  it('__VIRTUALROW_CHROMATIC_ABERRATION turns it on for review (#732)', () => {
    const w = globalThis as unknown as { window: { __VIRTUALROW_CHROMATIC_ABERRATION?: boolean } };
    w.window.__VIRTUALROW_CHROMATIC_ABERRATION = true;
    try {
      expect(chromaticAberrationEnabled(tierCapsFor('high'))).toBe(true);
    } finally {
      delete w.window.__VIRTUALROW_CHROMATIC_ABERRATION;
    }
  });

  it('wake particles are off on basic but on from low upward (#571)', () => {
    expect(tierCapsFor('basic').drawWakeParticles).toBe(false);
    for (const t of ['low', 'medium', 'high', 'extra-high'] as const) {
      expect(tierCapsFor(t).drawWakeParticles, t).toBe(true);
    }
  });
});
