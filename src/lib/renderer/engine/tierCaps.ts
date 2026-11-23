/**
 * Per-tier feature gates for #566 P6. Keeps the tier → "draw X?" decisions
 * in one spot so a smoke page or the ride view can ask the same question
 * without re-reading tier strings in multiple files.
 *
 * Gates recommended on #566 D8:
 *   - buildings:      drawn on `low` and up (`basic` skips).
 *   - clouds:         drawn on `medium` and up (`basic` + `low` skip).
 *   - buildings cast: shadow-cast on `medium` and up (so `basic` + `low`
 *                     still *receive* via `sampleShadow`).
 */

import { DEFAULT_TIER, KNOWN_TIERS, type PerformanceTier } from './shadowConfig';
import type { AntialiasMode } from './msaa';

export interface BuildingTierCaps {
  drawBuildings: boolean;
  drawClouds: boolean;
  castBuildingShadows: boolean;
  /** #570 D9: `basic` draws an empty cockpit (hull only, no crew). */
  drawCrew: boolean;
  /** #570 D7-c: crew only casts a shadow on medium+. */
  castCharacterShadows: boolean;
  /**
   * #591-fu P1c: the solid flora stage registers its pools with the depth
   * stage so near-camera trees cast shadows on the bank. Billboards/sprites
   * don't cast — their depth would carve rectangles into the atlas.
   */
  castFloraShadows: boolean;
  /**
   * #591-fu P1c: GLB kit scenery (kit trees, buildings, structures,
   * finish-line furniture) registers with the depth stage too, so a tall
   * ship or a bridge drops a real shadow onto the bank.
   */
  castSceneryShadows: boolean;
  /** #573 D8 — post-processing gates. Bloom/tone/vignette/LUT are universal;
   *  SSAO is high+ only; DOF is extra-high only (and off behind a flag). */
  drawBloom: boolean;
  drawVignette: boolean;
  drawLut: boolean;
  drawSsao: boolean;
  /**
   * #731 VP-13 FR1 — the canvas backing store is its CSS size times
   * min(devicePixelRatio, maxPixelRatio), lowered (never cropped) to stay
   * under maxBackingPixels, and never below the CSS size for that reason.
   */
  maxPixelRatio: number;
  maxBackingPixels: number;
  /**
   * #731 FR3 — edge anti-aliasing: 4x MSAA on the scene colour and depth at
   * medium and up, FXAA after the composite on basic and low.
   */
  antialias: AntialiasMode;
  drawDof: boolean;
  /** #574 — auto-exposure (1×1 luminance render + composite divisor).
   *  On at `high` + `extra-high`; off below so a weaker GPU doesn't take
   *  the extra render pass per frame. */
  drawAutoExposure: boolean;
  /** #574 — subtle chromatic aberration in the composite pass: 3-tap radial
   *  colour-channel offset. #732: off at every tier by default (it read as
   *  colour fringing, not a lens feel); `__VIRTUALROW_CHROMATIC_ABERRATION`
   *  turns it on for review, at most 0.0012 UV and only outside the centre
   *  60% of the frame. */
  drawChromaticAberration: boolean;
  /** #574 — procedural rain overlay (screen-space streaks). Opt-in via
   *  `window.__VIRTUALROW_RAIN=true` even on tiers that allow it; the
   *  cap just says "the tier can afford the extra fullscreen draw".
   *  Off on `basic`; on from `low` upward. */
  drawRainOverlay: boolean;
  /** #571 — hull wake / foam billboards. Off on `basic` (CPU particle
   *  update is cheap but the extra draw costs an upload per frame); on
   *  for `low` and up so even a modest tier sees the trail. */
  drawWakeParticles: boolean;
  /** #571 — oar-blade splash puddles at the catch and finish of each
   *  stroke. Pairs with the hull wake pass. Off on `basic`, on from
   *  `low` upward — the sim is tiny (~16 particles per second). */
  drawOarSplash: boolean;
  /** #493 Phase 5 / FR9 / AC7 — per-tier polygon-water vertex cap.
   *  OSM lake rings can carry tens of thousands of vertices; this is
   *  the budget `simplifyRing` (polygonSimplify.ts) decimates each
   *  outer ring down to before the pass tessellates. Holes stay
   *  verbatim (islands are already small). Caps are generous: the
   *  cost is the ear-clip, not the GPU draw. */
  polygonWaterMaxVertices: number;
  /**
   * #712 FR6 / D6 — soft cap on the number of OSM / kit buildings drawn per
   * `~500m` route segment, so a `small-city` profile can't blow FR10 gpuMs on
   * lower tiers. Scales across tiers; LOD distance work (#497) still trims
   * far-field count on top of this. `0` turns per-segment building draw off
   * entirely (basic tier retains today's `drawBuildings: false` as the kill
   * switch).
   */
  maxBuildingsPerSegment: number;
  /**
   * #577 D2b — count of placeholder fleet boats drawn alongside the
   * player + ghost. `0` turns the fleet off (basic tier); higher tiers
   * carry a larger bow-and-stern pack. The engine's `fleet.ts` generates
   * this many deterministic positions per route; each draws through the
   * existing `boatPass` as an extra ghost-style instance.
   */
  fleetCount: number;
  /**
   * #577 D10a (scaled) — whether the fleet casts shadows in the
   * character-depth pass. `false` on low tier (fleet renders but no
   * shadow); `true` on medium / high / extra-high so the pack reads
   * with the same depth cues as the player + ghost. Ignored when
   * `fleetCount === 0` (no members to draw).
   */
  castFleetShadows: boolean;
}

const CAPS: Record<PerformanceTier, BuildingTierCaps> = {
  basic: {
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
    maxPixelRatio: 1.0,
    maxBackingPixels: 2_100_000,
    antialias: 'fxaa',
  },
  low: {
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
    maxPixelRatio: 1.0,
    maxBackingPixels: 2_100_000,
    antialias: 'fxaa',
  },
  medium: {
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
    maxPixelRatio: 1.5,
    maxBackingPixels: 2_100_000,
    antialias: 'msaa',
  },
  high: {
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
    maxPixelRatio: 2.0,
    maxBackingPixels: 3_700_000,
    antialias: 'msaa',
  },
  'extra-high': {
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
    maxPixelRatio: 2.0,
    maxBackingPixels: 8_300_000,
    antialias: 'msaa',
  },
};

export const tierCapsFor = (tier: string | undefined): BuildingTierCaps => {
  if (tier && (KNOWN_TIERS as readonly string[]).includes(tier)) {
    return CAPS[tier as PerformanceTier];
  }
  return CAPS[DEFAULT_TIER];
};

/**
 * #732: chromatic aberration is off at every tier; a reviewer turns it on
 * with `window.__VIRTUALROW_CHROMATIC_ABERRATION = true` before the ride starts.
 */
export const chromaticAberrationEnabled = (caps: Pick<BuildingTierCaps, 'drawChromaticAberration'>): boolean =>
  caps.drawChromaticAberration ||
  !!(globalThis as unknown as { window?: { __VIRTUALROW_CHROMATIC_ABERRATION?: boolean } }).window
    ?.__VIRTUALROW_CHROMATIC_ABERRATION;
