/**
 * #734 VP-16 FR1 — the water surface's wave trains, the single source for
 * the WGSL snippet (`WATER_SURFACE_WGSL` in `engine/shaderSnippets.ts`) and
 * the CPU mirror the unit tests measure.
 *
 * The old surface was `sin(x) * cos(z)` at two fixed scales: a product of
 * an x-sinusoid and a z-sinusoid is a checkerboard by construction. Here
 * twelve trains run along directions a golden angle apart (no two collinear,
 * none on the x or z axis), with wavelengths spanning more than 1:8, plus
 * one short detail octave that fades out with distance before it can alias.
 * Each train moves at its deep-water phase speed, so they drift apart over
 * time instead of sliding as one rigid pattern. Twelve, not four: the
 * high-camera AC (#734) caps any one spectral peak at 8 % of the energy, and
 * each train is a pair of peaks, so the energy has to be spread thin.
 */

export interface WaveTrain {
  /** Direction of travel in the XZ plane, radians from +x. */
  angle: number;
  /** Metres crest to crest. */
  wavelength: number;
  /** Peak slope (amplitude x wavenumber): how strongly it tilts the normal. */
  slope: number;
  /** Phase offset, radians. */
  phase: number;
}

// The golden angle taken over a half turn, not a full one: a wave travelling
// at angle a and one at a + pi draw the same stripes, so it is the lines,
// not the arrows, that have to be spread.
const GOLDEN_ANGLE = (Math.PI * (Math.sqrt(5) - 1)) / 2;
const GRAVITY = 9.81;

const train = (i: number, wavelength: number, slope: number): WaveTrain => ({
  angle: 0.37 + i * GOLDEN_ANGLE,
  wavelength,
  slope,
  phase: (i * 1.618034) % (2 * Math.PI),
});

const TRAIN_COUNT = 12;
const LONGEST_M = 16;
const SHORTEST_M = 1.6;

/** Longest first, geometric from 16 m to 1.6 m: a span of 1:10. */
export const WATER_WAVE_TRAINS: readonly WaveTrain[] = Array.from({ length: TRAIN_COUNT }, (_, i) =>
  train(i, LONGEST_M * (SHORTEST_M / LONGEST_M) ** (i / (TRAIN_COUNT - 1)), 0.04),
);

/** The short detail octave, faded to nothing between `fadeStart` and `fadeEnd` metres. */
export const WATER_DETAIL_OCTAVE = {
  angle: 0.37 + TRAIN_COUNT * GOLDEN_ANGLE,
  wavelength: 0.55,
  slope: 0.05,
  phase: 0.9,
  fadeStart: 12,
  fadeEnd: 45,
} as const;

/** Deep-water angular frequency for a wavelength: w = sqrt(g k). */
export const angularFrequency = (wavelength: number): number => Math.sqrt(GRAVITY * ((2 * Math.PI) / wavelength));

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How much of the detail octave survives at a camera distance. */
export const detailWeight = (distance: number): number =>
  1 - smoothstep(WATER_DETAIL_OCTAVE.fadeStart, WATER_DETAIL_OCTAVE.fadeEnd, distance);

const addTrain = (
  acc: [number, number],
  w: { angle: number; wavelength: number; slope: number; phase: number },
  x: number,
  z: number,
  t: number,
  weight: number,
): void => {
  const k = (2 * Math.PI) / w.wavelength;
  const dx = Math.cos(w.angle);
  const dz = Math.sin(w.angle);
  const c = Math.cos(k * (dx * x + dz * z) - angularFrequency(w.wavelength) * t + w.phase) * w.slope * weight;
  acc[0] += c * dx;
  acc[1] += c * dz;
};

/**
 * The surface gradient (dh/dx, dh/dz) at a point — the CPU twin of
 * `waterSlope` in the WGSL. The normal is `normalize(-gx, 1, -gz)`.
 */
export const waterSlope = (x: number, z: number, t: number, distance = 0): [number, number] => {
  const acc: [number, number] = [0, 0];
  for (const w of WATER_WAVE_TRAINS) addTrain(acc, w, x, z, t, 1);
  const d = detailWeight(distance);
  if (d > 0) addTrain(acc, WATER_DETAIL_OCTAVE, x, z, t, d);
  return acc;
};

const f = (n: number): string => {
  const s = n.toFixed(6);
  return s.includes('.') ? s : `${s}.0`;
};

const trainWgsl = (w: { angle: number; wavelength: number; slope: number; phase: number }, weight: string): string => {
  const k = (2 * Math.PI) / w.wavelength;
  const dx = Math.cos(w.angle);
  const dz = Math.sin(w.angle);
  return `  {
    let c = cos(${f(k)} * (${f(dx)} * p.x + ${f(dz)} * p.y) - ${f(angularFrequency(w.wavelength))} * t + ${f(w.phase)}) * ${f(w.slope)} * ${weight};
    g = g + vec2<f32>(${f(dx)}, ${f(dz)}) * c;
  }`;
};

/**
 * WGSL for `waterSlope(p: vec2<f32>, t: f32, dist: f32) -> vec2<f32>`,
 * unrolled from the tables above so the shader and the mirror cannot drift.
 */
export const waterSlopeWgsl = (): string => `
fn waterSlope(p: vec2<f32>, t: f32, dist: f32) -> vec2<f32> {
  var g = vec2<f32>(0.0, 0.0);
${WATER_WAVE_TRAINS.map((w) => trainWgsl(w, '1.0')).join('\n')}
  let detail = 1.0 - smoothstep(${f(WATER_DETAIL_OCTAVE.fadeStart)}, ${f(WATER_DETAIL_OCTAVE.fadeEnd)}, dist);
  if (detail > 0.0) {
${trainWgsl(WATER_DETAIL_OCTAVE, 'detail')}
  }
  return g;
}
`;

/** Schlick's Fresnel for water (F0 = 0.02): the share of light reflected. */
export const WATER_F0 = 0.02;
/** Blinn-Phong exponent of the sun lobe on the water. */
export const WATER_SPECULAR_POWER = 180;
export const fresnel = (cosTheta: number): number =>
  WATER_F0 + (1 - WATER_F0) * Math.pow(1 - Math.min(1, Math.max(0, cosTheta)), 5);

type V3 = readonly [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface WaterShadeInput {
  /** Unit vector from the surface point to the camera. */
  toCamera: V3;
  /** Unit vector toward the sun. */
  sunDir: V3;
  body: V3;
  horizon: V3;
  zenith: V3;
  /** Sun lobe strength; 0 under cloud. */
  specular: number;
}

/**
 * CPU twin of the fragment shading in `water.wgsl` (#734 FR2): the body
 * colour mixed toward the sky the surface reflects by Fresnel, plus a sun
 * lobe. Used by the lattice test to measure what the camera would see.
 */
export const waterColour = (slope: readonly [number, number], s: WaterShadeInput): V3 => {
  const n = norm([-slope[0], 1, -slope[1]]);
  const v = s.toCamera;
  const nv = dot(n, v);
  const r: V3 = [2 * nv * n[0] - v[0], 2 * nv * n[1] - v[1], 2 * nv * n[2] - v[2]];
  const e = Math.sqrt(Math.max(0, r[1]));
  const sky: V3 = [0, 1, 2].map((i) => s.horizon[i] + (s.zenith[i] - s.horizon[i]) * e) as unknown as V3;
  const fr = fresnel(nv);
  const h = norm([v[0] + s.sunDir[0], v[1] + s.sunDir[1], v[2] + s.sunDir[2]]);
  const lobe = Math.pow(Math.max(0, dot(n, h)), WATER_SPECULAR_POWER) * s.specular;
  return [0, 1, 2].map((i) => s.body[i] + (sky[i] - s.body[i]) * fr + lobe) as unknown as V3;
};
