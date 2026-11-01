/**
 * Engine crew-palette slot contract (#578 AC4 / D7-a).
 *
 * Pins the engine's palette slot set to the React path's
 * `SLOT_NODE_PATTERNS`. The GLB generator in `scripts/build_crew.py`
 * authors every clothing / hair / hat primitive against these node
 * names; renaming or removing one has to land in both the generator and
 * the engine or the picker UI silently stops reaching the engine.
 *
 * This test deliberately does NOT reach into the engine's device code —
 * it reads the plan-layer slot map alone so it runs in jsdom without a
 * GPU adapter.
 */

import { describe, expect, it } from 'vitest';
import { CREW_SLOT_PATTERNS, type CrewSlot } from '../lib/renderer/plan/crewPalette';

// Mirror constant from `src/components/rower3d/rowerAppearance.ts`
// SLOT_NODE_PATTERNS. Repeated here as a plain data literal so the
// contract test depends on nothing but the React path's regex shape.
// A pattern change on either side forces an edit here and on the engine.
const REACT_SLOT_PATTERNS: Record<CrewSlot, RegExp> = {
  top: /^(Torso_Spine|Torso_Shoulders)_part$/,
  shorts: /^(Left|Right)Thigh_part$/,
  shoes: /^(Left|Right)Foot_part$/,
  hair: /^Hair(_(Short|Long|Buzz|Bun))?(_[A-Za-z]+)?_part$/,
  hat: /^Hat_(Cap|Visor|Beanie)(_[A-Za-z]+)?_part$/,
};

describe('engine crew-palette slot contract (#578 AC4)', () => {
  it('exposes exactly the five slots the picker UI exposes', () => {
    expect(Object.keys(CREW_SLOT_PATTERNS).sort()).toEqual([
      'hair',
      'hat',
      'shoes',
      'shorts',
      'top',
    ]);
  });

  it('matches every node name the React path recolours', () => {
    // Sample a representative name per slot pattern. If the generator
    // renames one of these, both the React and engine regexes have to
    // follow — this test fails until they do.
    const sampleNames: Record<CrewSlot, readonly string[]> = {
      top: ['Torso_Spine_part', 'Torso_Shoulders_part'],
      shorts: ['LeftThigh_part', 'RightThigh_part'],
      shoes: ['LeftFoot_part', 'RightFoot_part'],
      hair: [
        'Hair_part',
        'Hair_Short_part',
        'Hair_Long_Strands_part',
        'Hair_Bun_Band_part',
      ],
      hat: ['Hat_Cap_part', 'Hat_Visor_Brim_part', 'Hat_Beanie_part'],
    };
    for (const slot of Object.keys(sampleNames) as CrewSlot[]) {
      for (const name of sampleNames[slot]) {
        expect(CREW_SLOT_PATTERNS[slot].test(name)).toBe(true);
        // And the React regex still matches it too.
        expect(REACT_SLOT_PATTERNS[slot].test(name)).toBe(true);
      }
    }
  });

  it('does not classify the hull, oars or the head as a picker slot', () => {
    const outside = ['HullBody', 'LeftOar', 'RightOar', 'Head_part', 'Rigger_part'];
    for (const name of outside) {
      for (const slot of Object.keys(CREW_SLOT_PATTERNS) as CrewSlot[]) {
        expect(CREW_SLOT_PATTERNS[slot].test(name)).toBe(false);
      }
    }
  });

  it('is identical to the React path pattern (source strings match)', () => {
    for (const slot of Object.keys(CREW_SLOT_PATTERNS) as CrewSlot[]) {
      expect(CREW_SLOT_PATTERNS[slot].source).toBe(REACT_SLOT_PATTERNS[slot].source);
    }
  });
});
