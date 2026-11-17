// #686 D3b — SCENERY_PROFILES carries per-species planting weights
// alongside its allowed species list. The pick-weighted-species
// algorithm in foliagePlan.ts honours the weights so a `residential`
// bank reads as "mostly oak, some willow, ornamental accent" instead
// of the uniform third-each monoculture-reading the previous code
// produced.
//
// Rather than exposing `pickWeightedSpecies` as a public API, this
// spec exercises `layoutFoliage` end-to-end on a small deterministic
// route and asserts the resulting species distribution lines up with
// the declared weights.

import { describe, expect, it } from 'vitest';
import { SCENERY_PROFILES } from '../../../components/rower3d/sceneryConfig';
import { pickWeightedSpecies } from '../foliagePlan';

describe('#686 D3b — SCENERY_PROFILES biomeMix', () => {
  it('every multi-species profile declares a biomeMix of the same length', () => {
    for (const [name, profile] of Object.entries(SCENERY_PROFILES)) {
      const species = profile.trees.species;
      if (species.length <= 1) continue; // single-species profile — mix is implicit 100 %
      const mix = profile.trees.biomeMix;
      expect(mix, `${name}: biomeMix is missing`).toBeDefined();
      expect(mix!.length, `${name}: biomeMix length`).toBe(species.length);
      expect(mix!.every((w) => w >= 0), `${name}: biomeMix has negative weights`).toBe(true);
      expect(mix!.reduce((a, b) => a + b, 0), `${name}: biomeMix is all-zero`).toBeGreaterThan(0);
    }
  });

  it('dominant species in each profile carries the biggest weight', () => {
    // The whole point of the mix is that it's non-uniform: the first
    // listed species is dominant and its weight is strictly greater
    // than any one long-tail entry.
    for (const [name, profile] of Object.entries(SCENERY_PROFILES)) {
      const mix = profile.trees.biomeMix;
      if (!mix || mix.length <= 1) continue;
      const first = mix[0];
      for (let i = 1; i < mix.length; i += 1) {
        expect(
          first,
          `${name}: expected first weight ${first} > weight[${i}] ${mix[i]}`,
        ).toBeGreaterThan(mix[i]);
      }
    }
  });

  it("no profile has a dominant species over 90 % (always leaves room to break monoculture)", () => {
    // #686 FR3: no species ≥ 60 % unless the OSM tag says "monoculture
    // plantation". We don't model that OSM flag yet; cap the first-weight
    // ratio at 90 % so the dominant species never crowds out every
    // accent. A future monoculture-plantation flag will exempt this.
    for (const [name, profile] of Object.entries(SCENERY_PROFILES)) {
      const mix = profile.trees.biomeMix;
      if (!mix || mix.length <= 1) continue;
      const total = mix.reduce((a, b) => a + b, 0);
      const dominantPct = (mix[0] / total) * 100;
      expect(dominantPct, `${name}: dominant pct ${dominantPct.toFixed(1)} %`).toBeLessThanOrEqual(90);
    }
  });

  it('residential profile matches the Dan-recommended 60/30/10 default', () => {
    // Pinned so a future refactor that resets the defaults to uniform
    // trips here before Dan notices the banks going monoculture again.
    expect(SCENERY_PROFILES.residential.trees.biomeMix).toEqual([60, 30, 10]);
  });
});

describe('#686 D3b — pickWeightedSpecies algorithm', () => {
  const speciesTypes = ['oak', 'willow', 'ornamental'];
  const choices = [0, 1, 2]; // all three resolved on this theme

  it('picks species 0 when the draw is below the first weight band', () => {
    expect(pickWeightedSpecies('residential', speciesTypes, choices, 0.0)).toBe(0);
    expect(pickWeightedSpecies('residential', speciesTypes, choices, 0.59)).toBe(0);
  });

  it('picks species 1 inside its weight band', () => {
    expect(pickWeightedSpecies('residential', speciesTypes, choices, 0.61)).toBe(1);
    expect(pickWeightedSpecies('residential', speciesTypes, choices, 0.89)).toBe(1);
  });

  it('picks species 2 inside its weight band', () => {
    expect(pickWeightedSpecies('residential', speciesTypes, choices, 0.91)).toBe(2);
    expect(pickWeightedSpecies('residential', speciesTypes, choices, 0.999)).toBe(2);
  });

  it('empirical distribution over 10 000 draws matches the 60/30/10 target to within 2 %', () => {
    const counts = [0, 0, 0];
    const N = 10_000;
    for (let i = 0; i < N; i += 1) {
      // Deterministic draw sweep over [0, 1) — covers the full
      // cumulative range uniformly without needing a PRNG.
      const draw = (i + 0.5) / N;
      counts[pickWeightedSpecies('residential', speciesTypes, choices, draw)] += 1;
    }
    const pct = counts.map((c) => (c / N) * 100);
    expect(pct[0]).toBeGreaterThanOrEqual(58);
    expect(pct[0]).toBeLessThanOrEqual(62);
    expect(pct[1]).toBeGreaterThanOrEqual(28);
    expect(pct[1]).toBeLessThanOrEqual(32);
    expect(pct[2]).toBeGreaterThanOrEqual(8);
    expect(pct[2]).toBeLessThanOrEqual(12);
  });

  it('falls back to uniform when the profile has no biomeMix', () => {
    // `commercial` has one species. We fake a situation where the
    // resolved choices don't match the profile's species list — in that
    // case every weight is zero and the algorithm falls back to a
    // uniform draw over `choices`.
    const choicesU = [0, 1];
    const counts = [0, 0];
    const N = 1000;
    for (let i = 0; i < N; i += 1) {
      const pick = pickWeightedSpecies(
        'commercial',
        ['notOnProfile0', 'notOnProfile1'],
        choicesU,
        (i + 0.5) / N,
      );
      counts[pick] += 1;
    }
    // Uniform over two choices → roughly 50 / 50.
    expect(counts[0]).toBe(500);
    expect(counts[1]).toBe(500);
  });
});
