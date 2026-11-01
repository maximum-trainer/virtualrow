import { describe, it, expect } from 'vitest';
import {
  TOP_PALETTE,
  SHORTS_PALETTE,
  SHOES_PALETTE,
  HAIR_PALETTE,
  resolveAppearanceColors,
} from '../components/rower3d/rowerAppearance';

/**
 * #588 FR1 — this file no longer imports `three`. Pre-#625 it also exercised a
 * `applyAppearance(root, …)` function that walked a `THREE.Object3D` and
 * recoloured its materials in place; the WebGPU engine took over at the
 * cutover and the three.js path went with the rest of the React scene, so
 * those scene-mutation tests retired with the function. The engine's own
 * palette path is covered end-to-end by
 * `src/__tests__/engineCrewPaletteContract.test.ts`.
 */

describe('resolveAppearanceColors', () => {
  it('maps slot ids to hex values', () => {
    expect(
      resolveAppearanceColors({
        top: 'red',
        shorts: 'navy',
        shoes: 'silver',
        hair: 'blond',
        hairstyle: 'long',
        hat: 'cap',
        hatColor: 'red',
      }),
    ).toEqual({
      top: '#C8102E',
      shorts: '#1E3A5F',
      shoes: '#C8CCD0',
      hair: '#D7B378',
      hairstyle: 'long',
      hat: 'cap',
      hatColor: '#C8102E',
    });
  });

  it('falls back to the palette default for an unknown id', () => {
    expect(
      resolveAppearanceColors({
        top: 'nope',
        shorts: 'nope',
        shoes: 'nope',
        hair: 'nope',
        hairstyle: 'short',
        hat: 'none',
        hatColor: 'nope',
      }),
    ).toEqual({
      top: TOP_PALETTE[0].hex,
      shorts: SHORTS_PALETTE[0].hex,
      shoes: SHOES_PALETTE[0].hex,
      hair: HAIR_PALETTE[0].hex,
      hairstyle: 'short',
      hat: 'none',
      hatColor: '#1A1A1A',
    });
  });

  it('resolves match-top to the current top colour', () => {
    expect(
      resolveAppearanceColors({
        top: 'yellow',
        shorts: 'navy',
        shoes: 'black',
        hair: 'black',
        hairstyle: 'short',
        hat: 'cap',
        hatColor: 'match-top',
      }).hatColor,
    ).toBe('#F2C53C');
  });
});
