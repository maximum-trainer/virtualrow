/**
 * #725 VP-07 FR5 — the bank's ground cover follows the scenery profile, so
 * the authored biome bands read as different land and not as one flat green:
 * meadow, crop fields, dry scrub, a mown village green, reed marsh and a
 * woodland floor.
 *
 * The bank strips carry the mix as a per-vertex weight vector (averaged over
 * a stretch of bank, so a band boundary is a ~100 m blend rather than a line),
 * and the ground plane beyond them takes the mix at the boat. `bank.wgsl`
 * draws each look; the base tints live here so a test can hold adjacent bands
 * apart and the shader reads the same numbers ({@link bankBiomeWgsl}).
 */
import type { SceneryProfile } from '../../services/routeEnrichmentService';

export type BankBiome = 'meadow' | 'fields' | 'scrub' | 'green' | 'marsh' | 'woodland';

/**
 * The weighted biomes, in vector order. Meadow is the remainder (1 minus the
 * sum), so five weights describe all six.
 */
export const BANK_BIOME_SLOTS: readonly Exclude<BankBiome, 'meadow'>[] = ['fields', 'scrub', 'green', 'marsh', 'woodland'];
export const BANK_BIOME_WEIGHTS = BANK_BIOME_SLOTS.length;

const BIOME_OF: Record<SceneryProfile, BankBiome> = {
  forest: 'woodland',
  'forest-medium': 'woodland',
  'forest-high': 'woodland',
  woodland: 'woodland',
  farmland: 'fields',
  // No land-use data: the patchwork the bank drew before #725 FR5.
  fallback: 'fields',
  orchard: 'meadow',
  parkland: 'green',
  residential: 'green',
  village: 'green',
  town: 'green',
  commercial: 'green',
  'small-city': 'green',
  scrub: 'scrub',
  beach: 'scrub',
  wetland: 'marsh',
};

export const bankBiomeFor = (profile: SceneryProfile): BankBiome => BIOME_OF[profile] ?? 'fields';

/**
 * Linear-space multiplier each biome puts on the bank's grass albedo, before
 * its own pattern (stripes, blotches, pools) and the low-frequency noise.
 */
export const BANK_BIOME_TINT: Readonly<Record<BankBiome, readonly [number, number, number]>> = {
  meadow: [1.08, 1.06, 0.78],
  fields: [1.06, 1.02, 0.86],
  scrub: [1.42, 1.12, 0.66],
  green: [0.72, 1.18, 0.62],
  marsh: [0.62, 0.86, 0.80],
  woodland: [0.58, 0.66, 0.46],
};

/** Metres of bank either side of a point that its biome mix averages over. */
export const BIOME_BLEND_METRES = 50;
const BLEND_SAMPLES = 5;

/**
 * Writes the five biome weights at `progress` into `out[offset..offset+5]`,
 * averaged over `±windowProgress` so neighbouring bands blend. Allocation-free:
 * the ground plane calls it every frame.
 */
export const writeBiomeWeights = (
  profileAt: (progress: number) => SceneryProfile,
  progress: number,
  windowProgress: number,
  out: Float32Array,
  offset = 0,
): void => {
  for (let k = 0; k < BANK_BIOME_WEIGHTS; k++) out[offset + k] = 0;
  for (let s = 0; s < BLEND_SAMPLES; s++) {
    const f = (s / (BLEND_SAMPLES - 1)) * 2 - 1;
    const t = Math.max(0, Math.min(1, progress + f * windowProgress));
    const slot = BANK_BIOME_SLOTS.indexOf(bankBiomeFor(profileAt(t)) as Exclude<BankBiome, 'meadow'>);
    if (slot >= 0) out[offset + slot] += 1 / BLEND_SAMPLES;
  }
};

/** The tints as WGSL constants, in slot order, for `bank.wgsl`. */
export const bankBiomeWgsl = (): string => {
  const v = (b: BankBiome) => {
    const [r, g, bl] = BANK_BIOME_TINT[b];
    return `vec3<f32>(${r.toFixed(3)}, ${g.toFixed(3)}, ${bl.toFixed(3)})`;
  };
  return [
    `const BIOME_TINT_MEADOW: vec3<f32> = ${v('meadow')};`,
    ...BANK_BIOME_SLOTS.map((b) => `const BIOME_TINT_${b.toUpperCase()}: vec3<f32> = ${v(b)};`),
    '',
  ].join('\n');
};
