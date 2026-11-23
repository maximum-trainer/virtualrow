// #734 AC1 — the "no lattice" metric.
import { describe, expect, it } from 'vitest';
import { latticePeakShare } from '../latticeSpectrum';

const grid = (n: number, f: (x: number, y: number) => number) =>
  Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => f(x, y)));

describe('latticePeakShare', () => {
  it('is 0 for a flat or empty patch', () => {
    expect(latticePeakShare(grid(16, () => 0.4))).toBe(0);
    expect(latticePeakShare([])).toBe(0);
  });

  it('ignores a smooth brightening with distance (row by row)', () => {
    expect(latticePeakShare(grid(32, (_x, y) => 0.2 + y * 0.01))).toBeLessThan(1e-6);
  });

  it('puts a checkerboard well over 8% in one bin', () => {
    expect(latticePeakShare(grid(32, (x, y) => Math.sin(x * 0.8) * Math.cos(y * 0.8)))).toBeGreaterThan(0.08);
  });

  it('keeps noise under 8%', () => {
    let s = 7;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    expect(latticePeakShare(grid(32, () => rand()))).toBeLessThan(0.08);
  });
});
