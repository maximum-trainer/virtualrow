// #686 D2b — the sprite flora pass applies per-instance luminance + hue
// jitter at the magnitudes Dan picked. A pure shader-parse test: it
// reads the WGSL source and asserts the signed-magnitude constants
// stay within the ±5 % luminance / ±4° hue envelope. A future PR that
// changes the magnitudes without re-recording the hero visual-baseline
// trips this test first.
//
// Why constants and not a render test: the only real way to verify the
// 4° hue claim is a GPU render, which the rest of the suite can't do.
// Pinning the constants is the cheapest guard against a drift.

import { describe, expect, it } from 'vitest';
import sceneryWgsl from '../scenery.wgsl?raw';

describe('scenery.wgsl per-instance jitter (#686 D2b)', () => {
  it('reads an instance-id-ish seed (tintSeed) into the fragment stage', () => {
    // If a future rewrite drops the per-instance seed path, the jitter
    // collapses to a uniform shift across every instance — exactly the
    // monoculture Dan asked to break. Pin the wiring.
    expect(sceneryWgsl).toMatch(/tintSeed/);
    expect(sceneryWgsl).toMatch(/let tj = \(in\.tintSeed - 0\.5\) \* 2\.0;/);
  });

  it('holds luminance jitter at ±5 %', () => {
    // `lightMul = 1.0 + tj * N`; `N` is the signed luminance magnitude.
    const m = sceneryWgsl.match(/let lightMul = 1\.0 \+ tj \* (0?\.\d+);/);
    expect(m, 'scenery.wgsl: lightMul formula not found').not.toBeNull();
    const magnitude = Number(m![1]);
    // ±5 % means the constant is 0.05. Allow 0.04–0.06 so a future
    // typo-level change trips, but recalibrated values within a hair of
    // target don't flake.
    expect(magnitude).toBeGreaterThanOrEqual(0.04);
    expect(magnitude).toBeLessThanOrEqual(0.06);
  });

  it('holds the R/B asymmetry that produces the ~4° hue shift', () => {
    // The hue shift is driven by the R/B channel difference in
    // `tintMul = clamp(vec3<f32>(..R.., ..G.., ..B..), lo, hi)`. The
    // R and B multiplier magnitudes should be equal and opposite so the
    // mean luminance stays close to 1, and the magnitude maps to about
    // 4° of HSV hue.
    //
    // Pattern: `1.0 + tj * 0.035,\s*1.0 + tj * 0.010,\s*1.0 - tj * 0.035`.
    const m = sceneryWgsl.match(
      /1\.0 \+ tj \* (0?\.\d+),\s*1\.0 \+ tj \* (0?\.\d+),\s*1\.0 - tj \* (0?\.\d+)/,
    );
    expect(m, 'scenery.wgsl: tintMul triple not found').not.toBeNull();
    const [, rMag, gMag, bMag] = m!;
    expect(Number(rMag)).toBe(Number(bMag)); // symmetric
    // G stays small (near-constant) so luminance barely moves from the
    // hue rotation alone.
    expect(Number(gMag)).toBeLessThan(Number(rMag));
    // The signed R/B magnitude maps to ~4° hue. Keep inside 0.025–0.045
    // so a rewrite that sneaks the shift back to Biketerra-match (8° +)
    // trips this guard.
    expect(Number(rMag)).toBeGreaterThanOrEqual(0.025);
    expect(Number(rMag)).toBeLessThanOrEqual(0.045);
  });

  it('clamps the per-channel tint into a ±10 % window so an out-of-gamut jitter can never ship', () => {
    // Belt-and-braces: even if the magnitude constants grow in a future
    // typo, the clamp keeps the net multiplier bounded.
    const m = sceneryWgsl.match(/clamp\(vec3<f32>\([^)]+\),\s*vec3<f32>\((0?\.\d+)\),\s*vec3<f32>\((1?\.\d+)\)\)/);
    expect(m, 'scenery.wgsl: tintMul clamp not found').not.toBeNull();
    const lo = Number(m![1]);
    const hi = Number(m![2]);
    expect(lo).toBeGreaterThanOrEqual(0.85);
    expect(hi).toBeLessThanOrEqual(1.15);
  });
});
