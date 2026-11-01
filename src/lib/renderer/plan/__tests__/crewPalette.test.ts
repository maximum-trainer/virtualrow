/**
 * Vitest for the engine-side crew-palette plan module (#578 FR2).
 *
 * The engine reads this to decide which primitive is a picker slot and
 * to build a tinted vertex-colour buffer. Pure maths; no GPU; no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyCrewSlot,
  CREW_SLOT_PATTERNS,
  DEFAULT_CREW_PALETTE,
  flatPrimitiveColors,
  hexToRgba,
  paletteFromPreference,
  tintPrimitiveColors,
  type CrewPalette,
} from '../crewPalette';
import { DEFAULT_ROWER_APPEARANCE } from '../../../services/rowerAppearanceService';

describe('crewPalette classifyCrewSlot', () => {
  it('matches top and shorts on the authored node names', () => {
    expect(classifyCrewSlot('Torso_Spine_part')).toBe('top');
    expect(classifyCrewSlot('Torso_Shoulders_part')).toBe('top');
    expect(classifyCrewSlot('LeftThigh_part')).toBe('shorts');
    expect(classifyCrewSlot('RightThigh_part')).toBe('shorts');
  });

  it('matches shoes left and right', () => {
    expect(classifyCrewSlot('LeftFoot_part')).toBe('shoes');
    expect(classifyCrewSlot('RightFoot_part')).toBe('shoes');
  });

  it('matches Phase 1 Hair_part and Phase 2 hairstyle siblings', () => {
    expect(classifyCrewSlot('Hair_part')).toBe('hair');
    expect(classifyCrewSlot('Hair_Short_part')).toBe('hair');
    expect(classifyCrewSlot('Hair_Long_Strands_part')).toBe('hair');
    expect(classifyCrewSlot('Hair_Bun_Band_part')).toBe('hair');
  });

  it('matches the three Phase 2 hat variants', () => {
    expect(classifyCrewSlot('Hat_Cap_part')).toBe('hat');
    expect(classifyCrewSlot('Hat_Visor_Brim_part')).toBe('hat');
    expect(classifyCrewSlot('Hat_Beanie_part')).toBe('hat');
  });

  it('returns undefined for nodes outside the picker', () => {
    expect(classifyCrewSlot('HullBody')).toBeUndefined();
    expect(classifyCrewSlot('LeftOar')).toBeUndefined();
    expect(classifyCrewSlot('Head_part')).toBeUndefined();
    expect(classifyCrewSlot('')).toBeUndefined();
  });
});

describe('crewPalette hexToRgba', () => {
  it('parses a 6-digit hex into channels in [0, 1]', () => {
    const [r, g, b, a] = hexToRgba('#1E3A5F');
    expect(r).toBeCloseTo(30 / 255, 5);
    expect(g).toBeCloseTo(58 / 255, 5);
    expect(b).toBeCloseTo(95 / 255, 5);
    expect(a).toBe(1);
  });

  it('expands a 3-digit hex', () => {
    const [r, g, b] = hexToRgba('#f00');
    expect(r).toBe(1);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('falls back to white on malformed input (sanitiser upstream)', () => {
    expect(Array.from(hexToRgba('nope'))).toEqual([1, 1, 1, 1]);
    expect(Array.from(hexToRgba('#zzzzzz'))).toEqual([1, 1, 1, 1]);
    expect(Array.from(hexToRgba('#1E3A'))).toEqual([1, 1, 1, 1]);
  });
});

describe('crewPalette tintPrimitiveColors', () => {
  const palette: CrewPalette = {
    ...DEFAULT_CREW_PALETTE,
    top: [1, 0, 0, 1],
  };

  it('replaces every vertex RGB with the slot colour, preserving alpha', () => {
    const authored = new Float32Array([
      0.2, 0.3, 0.4, 0.5, // vertex 0
      0.6, 0.7, 0.8, 0.9, // vertex 1
    ]);
    const out = tintPrimitiveColors(authored, 'top', palette);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(0.5, 5); // alpha preserved (Float32 ok)
    expect(out[4]).toBe(1);
    expect(out[5]).toBe(0);
    expect(out[6]).toBe(0);
    expect(out[7]).toBeCloseTo(0.9, 5);
  });

  it('does not mutate the input buffer', () => {
    const authored = new Float32Array([0.2, 0.3, 0.4, 1]);
    const snapshot = Array.from(authored);
    tintPrimitiveColors(authored, 'top', palette);
    expect(Array.from(authored)).toEqual(snapshot);
  });
});

describe('crewPalette flatPrimitiveColors', () => {
  it('fills every vertex with the slot RGB and alpha=1', () => {
    const palette: CrewPalette = { ...DEFAULT_CREW_PALETTE, hair: [0.5, 0.25, 0.125, 1] };
    const out = flatPrimitiveColors(2, 'hair', palette);
    expect(out.length).toBe(8);
    expect(Array.from(out)).toEqual([0.5, 0.25, 0.125, 1, 0.5, 0.25, 0.125, 1]);
  });
});

describe('crewPalette paletteFromPreference', () => {
  it('builds a palette from the cold-start default preference', () => {
    const palette = paletteFromPreference(DEFAULT_ROWER_APPEARANCE);
    // The default is navy top; red brick / sage / etc. shouldn't appear.
    expect(palette.top[0]).toBeLessThan(0.5);
    expect(palette.top[2]).toBeGreaterThan(palette.top[0]); // blue dominant
    expect(palette.top[3]).toBe(1);
  });

  it('tracks a changed top colour', () => {
    const red = paletteFromPreference({ ...DEFAULT_ROWER_APPEARANCE, top: 'red' });
    expect(red.top[0]).toBeGreaterThan(0.7);
    expect(red.top[1]).toBeLessThan(0.3);
    expect(red.top[2]).toBeLessThan(0.3);
  });
});

describe('crewPalette CREW_SLOT_PATTERNS', () => {
  it('mirrors every key the React path recoloured', () => {
    // The React SLOT_NODE_PATTERNS in rowerAppearance.ts has exactly these
    // five keys; a build that renames one has to land in both.
    expect(Object.keys(CREW_SLOT_PATTERNS).sort()).toEqual([
      'hair',
      'hat',
      'shoes',
      'shorts',
      'top',
    ]);
  });
});
