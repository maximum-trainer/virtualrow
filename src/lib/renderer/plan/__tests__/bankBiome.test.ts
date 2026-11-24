// #725 VP-07 FR5 — the bank's ground cover follows the scenery profile.
import { describe, expect, it } from 'vitest';
import {
  BANK_BIOME_SLOTS,
  BANK_BIOME_TINT,
  BANK_BIOME_WEIGHTS,
  bankBiomeFor,
  bankBiomeWgsl,
  writeBiomeWeights,
  type BankBiome,
} from '../bankBiome';
import { WILLOWBROOK_SCENERY_TRACK } from '../../../../components/rower3d/sceneryTrack';
import type { SceneryProfile } from '../../../services/routeEnrichmentService';

/** Chromaticity (r, g, b over their sum): hue and saturation, not brightness. */
const chroma = ([r, g, b]: readonly [number, number, number]) => {
  const s = r + g + b;
  return [r / s, g / s, b / s];
};
const chromaDistance = (a: BankBiome, b: BankBiome) => {
  const [x, y] = [chroma(BANK_BIOME_TINT[a]), chroma(BANK_BIOME_TINT[b])];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

describe('bank biome (#725 FR5)', () => {
  it('maps the issue\'s five looks, plus the woodland floor, from the profiles', () => {
    expect(bankBiomeFor('farmland')).toBe('fields');
    expect(bankBiomeFor('scrub')).toBe('scrub');
    expect(bankBiomeFor('village')).toBe('green');
    expect(bankBiomeFor('residential')).toBe('green');
    expect(bankBiomeFor('wetland')).toBe('marsh');
    expect(bankBiomeFor('orchard')).toBe('meadow');
    expect(bankBiomeFor('forest')).toBe('woodland');
    // No land-use data keeps the patchwork the bank drew before.
    expect(bankBiomeFor('fallback')).toBe('fields');
  });

  it('no two looks share one colour', () => {
    const all = Object.keys(BANK_BIOME_TINT) as BankBiome[];
    for (const a of all) for (const b of all) {
      if (a < b) expect(chromaDistance(a, b), `${a} vs ${b}`).toBeGreaterThan(0.02);
    }
  });

  it('adjacent Willowbrook bands differ in ground colour', () => {
    const bands = WILLOWBROOK_SCENERY_TRACK.bands.map((b) => bankBiomeFor(b.profile));
    for (let i = 1; i < bands.length; i++) {
      expect(chromaDistance(bands[i - 1], bands[i]), `${bands[i - 1]} vs ${bands[i]}`).toBeGreaterThanOrEqual(0.04);
    }
  });

  it('weights a point by its own band and blends across a boundary', () => {
    const at = (t: number): SceneryProfile => (t < 0.5 ? 'farmland' : 'wetland');
    const out = new Float32Array(BANK_BIOME_WEIGHTS);
    const slot = (b: BankBiome) => BANK_BIOME_SLOTS.indexOf(b as (typeof BANK_BIOME_SLOTS)[number]);
    writeBiomeWeights(at, 0.2, 0.01, out);
    expect(out[slot('fields')]).toBeCloseTo(1);
    expect(out[slot('marsh')]).toBe(0);
    writeBiomeWeights(at, 0.5, 0.01, out);
    expect(out[slot('fields')]).toBeGreaterThan(0.2);
    expect(out[slot('marsh')]).toBeGreaterThan(0.2);
    expect(out[slot('fields')] + out[slot('marsh')]).toBeCloseTo(1);
    // Meadow is the remainder: an orchard bank weighs nothing.
    writeBiomeWeights(() => 'orchard', 0.5, 0.01, out);
    expect([...out].every((w) => w === 0)).toBe(true);
  });

  it('hands the shader the same tints', () => {
    const wgsl = bankBiomeWgsl();
    expect(wgsl).toContain('const BIOME_TINT_MEADOW: vec3<f32> = vec3<f32>(1.080, 1.060, 0.780);');
    for (const b of BANK_BIOME_SLOTS) expect(wgsl).toContain(`const BIOME_TINT_${b.toUpperCase()}:`);
  });
});
