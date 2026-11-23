// #734 VP-16 FR1/FR2 — the water's wave table and its CPU shading twin.
import { describe, expect, it } from 'vitest';
import { latticePeakShare as peakShare } from '../../engine/latticeSpectrum';
import {
  WATER_DETAIL_OCTAVE,
  WATER_WAVE_TRAINS,
  detailWeight,
  fresnel,
  waterColour,
  waterSlope,
  waterSlopeWgsl,
  type WaterShadeInput,
} from '../waterWaves';

const luma = (c: readonly number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const shade = (cam: readonly [number, number, number], x: number, z: number): Omit<WaterShadeInput, 'specular'> & { specular: number } => {
  const d = [cam[0] - x, cam[1], cam[2] - z];
  const l = Math.hypot(d[0], d[1], d[2]);
  return {
    toCamera: [d[0] / l, d[1] / l, d[2] / l],
    sunDir: [0.3, 0.8, -0.52],
    body: [0.05, 0.16, 0.2],
    horizon: [0.72, 0.8, 0.86],
    zenith: [0.3, 0.5, 0.82],
    specular: 1,
  };
};

/** Luma over a 32 m x 32 m patch of open water, seen from the high camera. */
const highCameraPatch = (colourAt: (x: number, z: number) => readonly number[]): number[][] => {
  const n = 64;
  const grid: number[][] = [];
  for (let j = 0; j < n; j += 1) {
    const row: number[] = [];
    for (let i = 0; i < n; i += 1) row.push(luma(colourAt(-16 + i * 0.5, -36 + j * 0.5)));
    grid.push(row);
  }
  return grid;
};

describe('water wave trains (#734 FR1)', () => {
  it('has at least four trains, none collinear with another or with an axis', () => {
    expect(WATER_WAVE_TRAINS.length).toBeGreaterThanOrEqual(4);
    const angles = [...WATER_WAVE_TRAINS.map((w) => w.angle), WATER_DETAIL_OCTAVE.angle];
    for (let a = 0; a < angles.length; a += 1) {
      expect(Math.abs(Math.sin(angles[a]))).toBeGreaterThan(0.05);
      expect(Math.abs(Math.cos(angles[a]))).toBeGreaterThan(0.05);
      for (let b = a + 1; b < angles.length; b += 1) {
        expect(Math.abs(Math.sin(angles[a] - angles[b]))).toBeGreaterThan(0.05);
      }
    }
  });

  it('spans wavelengths of at least 1:8, with a shorter detail octave', () => {
    const lengths = WATER_WAVE_TRAINS.map((w) => w.wavelength);
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeGreaterThanOrEqual(8);
    expect(WATER_DETAIL_OCTAVE.wavelength).toBeLessThan(Math.min(...lengths));
  });

  it('fades the detail octave out with distance', () => {
    expect(detailWeight(0)).toBe(1);
    expect(detailWeight(WATER_DETAIL_OCTAVE.fadeEnd)).toBe(0);
    const near = waterSlope(3, 4, 1, 0);
    const far = waterSlope(3, 4, 1, 1000);
    expect(near).not.toEqual(far);
  });

  it('moves the trains at different speeds, so the pattern does not slide rigidly', () => {
    // A rigid slide would make t=1 at (x, z) equal t=0 at one shifted point
    // for every sample; check two samples disagree on the shift.
    const at = (x: number, z: number, t: number) => waterSlope(x, z, t, 100);
    expect(at(0, 0, 1)).not.toEqual(at(0, 0, 0));
  });

  it('emits WGSL with one term per train plus the detail octave', () => {
    const wgsl = waterSlopeWgsl();
    expect(wgsl).toContain('fn waterSlope(p: vec2<f32>, t: f32, dist: f32) -> vec2<f32>');
    expect(wgsl.match(/let c = cos\(/g)).toHaveLength(WATER_WAVE_TRAINS.length + 1);
  });
});

describe('water shading (#734 FR2)', () => {
  it('reflects more at grazing angles (Fresnel)', () => {
    expect(fresnel(1)).toBeCloseTo(0.02, 5);
    expect(fresnel(0)).toBeCloseTo(1, 5);
    expect(fresnel(0.2)).toBeGreaterThan(fresnel(0.8));
  });

  it('turns toward the sky colour far from the camera and lights a sun lobe', () => {
    const cam = [0, 3, 0] as const;
    const near = waterColour([0, 0], { ...shade(cam, 0, -2), specular: 0 });
    const far = waterColour([0, 0], { ...shade(cam, 0, -200), specular: 0 });
    expect(luma(far)).toBeGreaterThan(luma(near) + 0.3);
    const facingSun = waterColour([0, 0], { ...shade(cam, 0, -2), sunDir: shade(cam, 0, -2).toCamera.map((v, i) => (i === 1 ? v : -v)) as unknown as WaterShadeInput['sunDir'] });
    expect(luma(facingSun)).toBeGreaterThan(luma(near) + 0.5);
  });
});

describe('Scenario: no lattice (#734 AC1, CPU twin)', () => {
  const cam = [0, 12, 8] as const;

  it('catches the old checkerboard (the metric is sharp enough)', () => {
    const old = (x: number, z: number) => {
      const ripple = 0.5 + 0.5 * Math.sin(x * 0.6) * Math.cos(z * 0.5);
      const secondary = 0.5 + 0.5 * Math.sin(x * 0.11) * Math.cos(z * 0.09);
      const t = Math.min(1, Math.max(0, ripple * 0.85 + secondary * 0.3 - 0.15));
      return [0.07 + 0.15 * t, 0.22 + 0.3 * t, 0.36 + 0.22 * t];
    };
    expect(peakShare(highCameraPatch(old))).toBeGreaterThan(0.08);
  });

  it.each([0, 7.5, 31])('holds every non-DC peak under 8%% of the energy at t=%s s', (t) => {
    const grid = highCameraPatch((x, z) => {
      const s = shade(cam, x, z);
      const dist = Math.hypot(x - cam[0], z - cam[2]);
      return waterColour(waterSlope(x, z, t, dist), { ...s, specular: 0 });
    });
    expect(peakShare(grid)).toBeLessThanOrEqual(0.08);
  });
});
