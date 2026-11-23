/**
 * The rower's Conditions choice mapped onto the engine's frame lighting
 * (#730 VP-12).
 *
 * The picker (`useConditions.svelte.ts`) resolves `auto` against the clock
 * and hands the engine one of the five legacy presets. Their numbers live in
 * `components/rower3d/conditions.ts`, applied over `SCENE_CONFIG`; this file
 * does not author a second set. It reads each preset *relative to Midday*:
 * a sun colour, ambient, fog colour or intensity becomes a ratio against
 * Midday's, and the shaders multiply their existing constants by it.
 *
 * That makes Midday the identity. Every multiplier is exactly 1, every shift
 * exactly 0, and the sun is the engine's own tuned `(0.3, 0.8, 0.5)` rather
 * than the legacy 55°/180° (it sits within 1.5° of that elevation). So a row
 * at Midday, and a row with no conditions at all (FR6), draws the frame the
 * shipped visual baselines were recorded from.
 *
 * Azimuths are carried over as offsets from Midday's: the engine's world has
 * no north, so what matters is that dawn rises on one side of the course and
 * dusk sets on the other, in the legacy order.
 */

import {
  CONDITIONS,
  applyConditions,
  type Conditions,
} from '../../../components/rower3d/conditions';
import { SCENE_CONFIG, type SceneConfig } from '../../../components/rower3d/themeConfig';
import type { Vec3 } from '../engine/postFxMath';

export type LightingConditions = Conditions;

export interface FrameLighting {
  /** The preset in force, or `default` when the shell passed none. */
  readonly name: Conditions | 'default';
  readonly sunElevationDeg: number;
  /** Degrees about +Y, measured as atan2(x, z) in engine world space. */
  readonly sunAzimuthDeg: number;
  /** Towards the sun. Not normalised for the default: it is today's literal. */
  readonly sunDir: Vec3;
  /** Direct-light multiplier: sun colour × intensity, relative to Midday. */
  readonly sun: Vec3;
  /** Hemisphere-ambient multiplier, relative to Midday. */
  readonly ambient: Vec3;
  readonly skyZenith: Vec3;
  /** The horizon away from the sun (the fog side). */
  readonly skyHorizonCool: Vec3;
  /** The horizon under the sun. */
  readonly skyHorizonWarm: Vec3;
  readonly sunDiscColour: Vec3;
  /** 1 draws the sun disc, 0 hides it (Overcast, FR4). */
  readonly sunDisc: number;
  /** 0..1 share of the sky under cloud. The legacy preset's cloud opacity. */
  readonly cloudCover: number;
  /** Subtracted from the cloud shader's density threshold: more cover. */
  readonly cloudThresholdShift: number;
  readonly cloudAlpha: number;
  readonly cloudTint: Vec3;
  /** Multiplier on the horizon colours, from the preset's fog colour. */
  readonly fogTint: Vec3;
  /** Multiplier on `frame.fog` density: the legacy `fogFar` read inversely. */
  readonly fogDensityScale: number;
  readonly waterTint: Vec3;
  /** Strength of the low-sun glint on the water. 0 at Midday. */
  readonly waterSpecular: number;
  /** 1 is today's shadow; lower lifts the shadowed side (Overcast, FR4). */
  readonly shadowStrength: number;
  /** Stops added before tone-mapping. */
  readonly exposureBias: number;
}

/** The sun `rideScene.ts` shipped with before conditions reached it. */
export const ENGINE_DEFAULT_SUN_DIR: Vec3 = [0.3, 0.8, 0.5];

const DEFAULT_ZENITH: Vec3 = [0.32, 0.52, 0.86];
const DEFAULT_HORIZON_COOL: Vec3 = [0.7, 0.8, 0.92];
const DEFAULT_HORIZON_WARM: Vec3 = [0.98, 0.8, 0.55];
const DEFAULT_SUN_DISC: Vec3 = [1, 0.95, 0.85];
const DEFAULT_CLOUD_ALPHA = 0.85;

/** Cloud cover at or above this is an overcast sky: no disc, soft shadows. */
const OVERCAST_COVER = 0.8;
const OVERCAST_SHADOW_STRENGTH = 0.35;
/** How far one unit of extra cover moves the cloud density threshold. */
const CLOUD_SHIFT_PER_COVER = 0.9;
const CLOUD_ALPHA_PER_COVER = 0.2;
/** How much of the cover-driven grey the zenith takes, at full overcast. */
const ZENITH_GREY_AT_FULL_COVER = 0.75;
const ZENITH_TINT_MAX = 1.2;
const WATER_SPECULAR_MAX = 0.6;
/** Stops of exposure per halving of the sun: a quarter-stop lift. */
const EXPOSURE_PER_SUN_HALVING = 0.25;

const deg = (rad: number): number => (rad * 180) / Math.PI;
const rad = (d: number): number => (d * Math.PI) / 180;

const DEFAULT_ELEVATION_DEG = deg(
  Math.atan2(ENGINE_DEFAULT_SUN_DIR[1], Math.hypot(ENGINE_DEFAULT_SUN_DIR[0], ENGINE_DEFAULT_SUN_DIR[2])),
);
const DEFAULT_AZIMUTH_DEG = deg(Math.atan2(ENGINE_DEFAULT_SUN_DIR[0], ENGINE_DEFAULT_SUN_DIR[2]));

const hex = (s: string): Vec3 => {
  const n = parseInt(s.replace('#', ''), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
};
const div = (a: Vec3, b: Vec3): Vec3 => [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const ONE: Vec3 = [1, 1, 1];

export const isLightingConditions = (value: unknown): value is Conditions =>
  typeof value === 'string' && (CONDITIONS as readonly string[]).includes(value);

const MIDDAY: SceneConfig = applyConditions(SCENE_CONFIG, 'midday');

const build = (name: Conditions): FrameLighting => {
  const p = applyConditions(SCENE_CONFIG, name);
  const m = MIDDAY;

  const intensity = p.lighting.sunIntensity / m.lighting.sunIntensity;
  const sunTint = div(hex(p.lighting.sunColor), hex(m.lighting.sunColor));
  const ambient = scale(
    div(hex(p.lighting.ambientColor), hex(m.lighting.ambientColor)),
    p.lighting.ambientIntensity / m.lighting.ambientIntensity,
  );
  const fogTint = div(hex(p.atmosphere.fogColor), hex(m.atmosphere.fogColor));

  const cover = p.clouds.opacity;
  const extraCover = cover - m.clouds.opacity;
  const overcast = cover >= OVERCAST_COVER;

  const isMidday = name === 'midday';
  const sunElevationDeg = isMidday ? DEFAULT_ELEVATION_DEG : p.lighting.sunElevation;
  const sunAzimuthDeg = isMidday
    ? DEFAULT_AZIMUTH_DEG
    : DEFAULT_AZIMUTH_DEG + (p.lighting.sunAzimuth - m.lighting.sunAzimuth);
  const sunDir: Vec3 = isMidday
    ? [...ENGINE_DEFAULT_SUN_DIR]
    : [
        Math.cos(rad(sunElevationDeg)) * Math.sin(rad(sunAzimuthDeg)),
        Math.sin(rad(sunElevationDeg)),
        Math.cos(rad(sunElevationDeg)) * Math.cos(rad(sunAzimuthDeg)),
      ];

  // An overcast sky goes grey overhead; a dim world takes the zenith with it.
  const grey = clamp((extraCover / (OVERCAST_COVER + 0.1 - m.clouds.opacity)) * ZENITH_GREY_AT_FULL_COVER, 0, ZENITH_GREY_AT_FULL_COVER);
  const zenithLum = 0.2126 * DEFAULT_ZENITH[0] + 0.7152 * DEFAULT_ZENITH[1] + 0.0722 * DEFAULT_ZENITH[2];
  const greyedZenith = lerp3(DEFAULT_ZENITH, [zenithLum, zenithLum, zenithLum], grey);
  const zenithTint: Vec3 = [
    Math.min(ambient[0], ZENITH_TINT_MAX),
    Math.min(ambient[1], ZENITH_TINT_MAX),
    Math.min(ambient[2], ZENITH_TINT_MAX),
  ];

  const lowSun = clamp((m.lighting.sunElevation - p.lighting.sunElevation) / m.lighting.sunElevation, 0, 1);

  return {
    name,
    sunElevationDeg,
    sunAzimuthDeg,
    sunDir,
    sun: scale(sunTint, intensity),
    ambient,
    skyZenith: mul(greyedZenith, zenithTint),
    skyHorizonCool: mul(DEFAULT_HORIZON_COOL, fogTint),
    skyHorizonWarm: mul(DEFAULT_HORIZON_WARM, sunTint),
    sunDiscColour: mul(DEFAULT_SUN_DISC, sunTint),
    sunDisc: overcast ? 0 : 1,
    cloudCover: cover,
    cloudThresholdShift: extraCover * CLOUD_SHIFT_PER_COVER,
    cloudAlpha: Math.min(1, DEFAULT_CLOUD_ALPHA + extraCover * CLOUD_ALPHA_PER_COVER),
    cloudTint: scale(lerp3(ONE, sunTint, 0.6), lerp(1, intensity, 0.5)),
    fogTint,
    fogDensityScale: m.atmosphere.fogFar / p.atmosphere.fogFar,
    waterTint: mul(lerp3(ONE, fogTint, 0.5), lerp3(ONE, ambient, 0.5)),
    waterSpecular: overcast ? 0 : lowSun * WATER_SPECULAR_MAX,
    shadowStrength: overcast ? OVERCAST_SHADOW_STRENGTH : 1,
    // `0 -` keeps Midday at +0 rather than -0.
    exposureBias: 0 - EXPOSURE_PER_SUN_HALVING * Math.log2(intensity),
  };
};

const TABLE: Record<Conditions, FrameLighting> = Object.fromEntries(
  CONDITIONS.map((c) => [c, build(c)]),
) as Record<Conditions, FrameLighting>;

/** What the engine draws when the shell passes no conditions (FR6). */
export const DEFAULT_FRAME_LIGHTING: FrameLighting = { ...TABLE.midday, name: 'default' };

export const conditionsToFrameLighting = (conditions: Conditions | undefined): FrameLighting =>
  isLightingConditions(conditions) ? TABLE[conditions] : DEFAULT_FRAME_LIGHTING;
