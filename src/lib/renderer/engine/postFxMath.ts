/**
 * P8 of #542 — pure-TS mirrors of the composite shader's math so the ACs can
 * be asserted without a GPU readback (AC2–AC5 of #573). The WGSL in
 * `src/lib/renderer/passes/composite.wgsl` is the source of truth; this file
 * is the parallel CPU implementation. The pair is kept in step by
 * `postFxMath.test.ts`.
 */

export type Vec3 = readonly [number, number, number];

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * ACES Filmic tone-map (D3-a of #573). The Narkowicz approximation of the
 * ACES RRT+ODT pipeline: cheap, maps `[0, +∞)` into `[0, 1]`, keeps a shoulder.
 */
export const acesFilmic = (x: Vec3): Vec3 => {
  const map = (v: number): number => {
    const a = 2.51;
    const b = 0.03;
    const c = 2.43;
    const d = 0.59;
    const e = 0.14;
    return clamp01((v * (a * v + b)) / (v * (c * v + d) + e));
  };
  return [map(x[0]), map(x[1]), map(x[2])];
};

export const luminance = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Bright-pass threshold used by `bloomDown.wgsl` on the first downsample
 * (D2-a). Pixels at or above the knee contribute to the bloom pyramid; below
 * it the contribution tapers smoothly to zero.
 */
export const brightPass = (c: Vec3, threshold = 1.0, knee = 0.5): Vec3 => {
  const l = luminance(c);
  const soft = Math.max(0, l - threshold + knee);
  const w = Math.min(soft * soft / (4 * knee + 1e-5), l);
  const k = l > 0 ? w / l : 0;
  return [c[0] * k, c[1] * k, c[2] * k];
};

/**
 * 32×32×32 LUT sampled as a 1024×32 2D texture (D4-a). The LUT lives on a row
 * with 32 slices side-by-side; slice `b` lives at `[b*32, b*32 + 32)` in u.
 * Trilinear across (u, v, b-slice).
 */
export interface Lut3D {
  /** Row-major RGBA8, 1024×32 pixels. */
  pixels: Uint8ClampedArray;
  /** Must be 32 for the current packing. */
  size: number;
}

export const sampleLut = (lut: Lut3D, rgb: Vec3): Vec3 => {
  const n = lut.size;
  const x = clamp01(rgb[0]) * (n - 1);
  const y = clamp01(rgb[1]) * (n - 1);
  const z = clamp01(rgb[2]) * (n - 1);
  const zL = Math.floor(z);
  const zH = Math.min(n - 1, zL + 1);
  const tz = z - zL;
  const sampleSlice = (zi: number): Vec3 => {
    const xL = Math.floor(x);
    const xH = Math.min(n - 1, xL + 1);
    const yL = Math.floor(y);
    const yH = Math.min(n - 1, yL + 1);
    const tx = x - xL;
    const ty = y - yL;
    const fetch = (xi: number, yi: number): Vec3 => {
      const px = zi * n + xi; // slice offset
      const py = yi;
      const i = (py * (n * n) + px) * 4;
      return [lut.pixels[i] / 255, lut.pixels[i + 1] / 255, lut.pixels[i + 2] / 255];
    };
    const a = fetch(xL, yL);
    const b = fetch(xH, yL);
    const c = fetch(xL, yH);
    const d = fetch(xH, yH);
    const r = (va: number, vb: number, vc: number, vd: number): number =>
      va * (1 - tx) * (1 - ty) + vb * tx * (1 - ty) + vc * (1 - tx) * ty + vd * tx * ty;
    return [r(a[0], b[0], c[0], d[0]), r(a[1], b[1], c[1], d[1]), r(a[2], b[2], c[2], d[2])];
  };
  const lo = sampleSlice(zL);
  const hi = sampleSlice(zH);
  return [
    lo[0] * (1 - tz) + hi[0] * tz,
    lo[1] * (1 - tz) + hi[1] * tz,
    lo[2] * (1 - tz) + hi[2] * tz,
  ];
};

/**
 * Build a neutral (identity) 32×32×32 LUT packed as 1024×32 RGBA8. A sample
 * at colour `(r, g, b)` returns `(r, g, b)` to within 1/255.
 */
export const buildNeutralLutPixels = (size = 32): Uint8ClampedArray => {
  const w = size * size;
  const h = size;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let b = 0; b < size; b += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * w + b * size + x) * 4;
        px[i] = Math.round((x / (size - 1)) * 255);
        px[i + 1] = Math.round((y / (size - 1)) * 255);
        px[i + 2] = Math.round((b / (size - 1)) * 255);
        px[i + 3] = 255;
      }
    }
  }
  return px;
};

/**
 * Analytic radial vignette (D5-a). `uv` is the fragment's UV in [0, 1]².
 * `strength` 0 is no vignette; 1 fully darkens the corners.
 */
export const vignette = (uv: readonly [number, number], strength = 0.4): number => {
  const dx = uv[0] - 0.5;
  const dy = uv[1] - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy) * Math.SQRT2;
  const falloff = 1 - r * r * strength;
  return Math.max(0, falloff);
};

/**
 * Full composite: scene colour + bloom (additive) → LUT → vignette → ACES.
 * Returns the final linear-after-tone-map RGB; the sRGB encode is the
 * swap-chain's job (sky uses `rgba16float` scene, swap uses `*srgb`).
 */
export const composite = (
  scene: Vec3,
  bloom: Vec3,
  lut: Lut3D,
  uv: readonly [number, number],
  opts: { bloomStrength?: number; vignetteStrength?: number } = {},
): Vec3 => {
  const bs = opts.bloomStrength ?? 0.08;
  const vs = opts.vignetteStrength ?? 0.4;
  const added: Vec3 = [scene[0] + bloom[0] * bs, scene[1] + bloom[1] * bs, scene[2] + bloom[2] * bs];
  const graded = sampleLut(lut, added);
  const v = vignette(uv, vs);
  const dimmed: Vec3 = [graded[0] * v, graded[1] * v, graded[2] * v];
  return acesFilmic(dimmed);
};

/**
 * GTAO-lite kernel for AC5 (D6-a). Returns the AO term in `[0, 1]` where 1 is
 * no occlusion. The real shader samples depth with 8 taps; the CPU mirror
 * takes 8 depth samples by callback so a unit test can set up a synthetic
 * ground-plane scene.
 */
export const gtaoLite = (
  sampleDepth: (dx: number, dy: number) => number,
  centerDepth: number,
  radius = 1.0,
): number => {
  // 8 taps around a half-circle; the sign of `dx` determines the horizon
  // bracket. This is a drastically simplified GTAO — enough to produce a
  // darker-than-1 result at building/ground creases.
  const taps: Array<[number, number]> = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    taps.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  let occlusion = 0;
  for (const [dx, dy] of taps) {
    const sd = sampleDepth(dx, dy);
    // Closer-than-centre pixels along the horizon cast occlusion.
    if (sd < centerDepth) occlusion += (centerDepth - sd) / radius;
  }
  const ao = 1 - occlusion / taps.length;
  return clamp01(ao);
};

// --- #732 VP-14: post-fx that must not make `high` worse than `medium`. ---

/** FR1 — the most chromatic aberration may shift a channel, UV at the corner. */
export const CA_MAX_OFFSET_UV = 0.0012;
/** FR1 — share of the frame radius (centre to corner) left untouched. */
export const CA_CLEAR_RADIUS = 0.6;

/**
 * FR1 — how much of `CA_MAX_OFFSET_UV` applies at a fragment, 0..1. `uv` is
 * in [0, 1]²; the radius is normalised so the corner is 1. Zero inside the
 * centre 60%, then rising with the square of the distance past it.
 * Mirrors `caScale` in `composite.wgsl`.
 */
export const chromaticAberrationScale = (uv: readonly [number, number]): number => {
  const dx = uv[0] - 0.5;
  const dy = uv[1] - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy) * Math.SQRT2;
  const t = Math.max(0, (r - CA_CLEAR_RADIUS) / (1 - CA_CLEAR_RADIUS));
  return Math.min(1, t * t);
};

/** FR2 — auto-exposure may move the authored exposure by at most this many stops. */
export const EXPOSURE_CLAMP_EV = 0.7;
/** FR2 — time constant of the exposure's adaptation; 95% after ~3τ = 1.8 s. */
export const EXPOSURE_ADAPT_TAU_S = 0.6;
/** FR2 — the metered region starts this far down the frame (the sky above is excluded). */
export const EXPOSURE_METER_TOP = 0.4;

/**
 * FR2 — the metered luminance that leaves the authored exposure alone: what
 * the authored daylight scene meters at. Mirrors `EXPOSURE_KEY` in
 * `composite.wgsl`. Middle grey (0.18) left high 29% darker than medium.
 */
export const EXPOSURE_KEY = 0.3;

/**
 * FR2 — the multiplier auto-exposure applies for a metered average
 * luminance: `EXPOSURE_KEY` over it, clamped to ±0.7 EV.
 * Mirrors the composite shader.
 */
export const autoExposureScale = (avgLum: number): number => {
  const lum = Math.max(avgLum, 1e-4);
  const limit = Math.pow(2, EXPOSURE_CLAMP_EV);
  return Math.min(limit, Math.max(1 / limit, EXPOSURE_KEY / lum));
};

/**
 * FR2 — the metered log-luminance after `dt` seconds of adapting from
 * `previous` towards `measured`. A non-finite `previous` (the first frame)
 * takes the measurement as-is. Mirrors `luminance.wgsl`.
 */
export const adaptLogLuminance = (previous: number, measured: number, dt: number): number => {
  if (!Number.isFinite(previous)) return measured;
  const k = 1 - Math.exp(-Math.max(0, dt) / EXPOSURE_ADAPT_TAU_S);
  return previous + (measured - previous) * k;
};

/**
 * FR2 — weight of a metering tap at `uv`: nothing above
 * `EXPOSURE_METER_TOP` (sky), and centre-weighted across the rest.
 * Mirrors `luminance.wgsl`.
 */
export const meteringWeight = (uv: readonly [number, number]): number => {
  if (uv[1] < EXPOSURE_METER_TOP) return 0;
  const dx = (uv[0] - 0.5) * 2;
  const dy = ((uv[1] - EXPOSURE_METER_TOP) / (1 - EXPOSURE_METER_TOP) - 0.5) * 2;
  return Math.max(0.1, 1 - 0.5 * (dx * dx + dy * dy));
};

/** FR3 — SSAO may darken a pixel by at most this share. */
export const AO_MAX_DARKENING = 0.35;

/** FR3 — the factor the composite multiplies by for an AO term in [0, 1]. */
export const applyAmbientOcclusion = (ao: number): number =>
  Math.max(1 - AO_MAX_DARKENING, clamp01(ao));

/** FR3 — relative depth difference at which a blur tap's weight falls to ~60%. */
export const BILATERAL_DEPTH_SIGMA = 0.1;

/**
 * FR3 — weight of a neighbour in the depth-aware (bilateral) AO blur: a
 * tap across a depth edge counts for almost nothing, so occlusion does not
 * bleed from a near object onto the sky or water behind it. Depths are
 * linear metres. Mirrors `ssaoBlur.wgsl`.
 */
export const bilateralDepthWeight = (centreDepthM: number, tapDepthM: number): number => {
  const rel = Math.abs(tapDepthM - centreDepthM) / Math.max(centreDepthM, 1e-3);
  return Math.exp(-(rel * rel) / (2 * BILATERAL_DEPTH_SIGMA * BILATERAL_DEPTH_SIGMA));
};

/**
 * #731 FR3 — CPU twin of `fxaa.wgsl` for one pixel. `img(x, y)` returns the
 * colour at integer pixel (x, y), clamped at the edges; fractional taps are
 * bilinear, as the GPU's linear sampler gives them.
 */
export const fxaa = (img: (x: number, y: number) => Vec3, x: number, y: number): Vec3 => {
  const REDUCE_MIN = 1 / 128;
  const REDUCE_MUL = 1 / 8;
  const SPAN_MAX = 8;
  const EDGE_MIN = 0.0312;
  const EDGE_REL = 0.125;
  const tap = (fx: number, fy: number): Vec3 => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = img(x0, y0);
    const b = img(x0 + 1, y0);
    const c = img(x0, y0 + 1);
    const d = img(x0 + 1, y0 + 1);
    const mix = (i: number): number =>
      a[i] * (1 - tx) * (1 - ty) + b[i] * tx * (1 - ty) + c[i] * (1 - tx) * ty + d[i] * tx * ty;
    return [mix(0), mix(1), mix(2)];
  };
  const luma = (c: Vec3): number => Math.sqrt(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
  const rgbM = img(x, y);
  const lM = luma(rgbM);
  const lNW = luma(img(x - 1, y - 1));
  const lNE = luma(img(x + 1, y - 1));
  const lSW = luma(img(x - 1, y + 1));
  const lSE = luma(img(x + 1, y + 1));
  const lMin = Math.min(lM, lNW, lNE, lSW, lSE);
  const lMax = Math.max(lM, lNW, lNE, lSW, lSE);
  if (lMax - lMin < Math.max(EDGE_MIN, lMax * EDGE_REL)) return rgbM;
  let dx = -((lNW + lNE) - (lSW + lSE));
  let dy = (lNW + lSW) - (lNE + lSE);
  const reduce = Math.max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  const rcpMin = 1 / (Math.min(Math.abs(dx), Math.abs(dy)) + reduce);
  dx = Math.max(-SPAN_MAX, Math.min(SPAN_MAX, dx * rcpMin));
  dy = Math.max(-SPAN_MAX, Math.min(SPAN_MAX, dy * rcpMin));
  const at = (t: number): Vec3 => tap(x + dx * t, y + dy * t);
  const p = at(1 / 3 - 0.5);
  const q = at(2 / 3 - 0.5);
  const rgbA: Vec3 = [0.5 * (p[0] + q[0]), 0.5 * (p[1] + q[1]), 0.5 * (p[2] + q[2])];
  const r = at(-0.5);
  const s = at(0.5);
  const rgbB: Vec3 = [0, 1, 2].map((i) => rgbA[i] * 0.5 + 0.25 * (r[i] + s[i])) as unknown as Vec3;
  const lB = luma(rgbB);
  return lB < lMin || lB > lMax ? rgbA : rgbB;
};
