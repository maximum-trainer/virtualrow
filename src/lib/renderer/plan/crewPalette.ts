/**
 * Per-athlete rower appearance applied by the WebGPU engine (#578 FR2).
 *
 * The React path overrode each named GLB primitive's material at runtime
 * (`rowerAppearance.ts applyAppearance`). The WebGPU engine draws the crew
 * sculls through `sceneryMeshPass`, which uses one per-vertex colour buffer
 * per primitive — no shared `MeshStandardMaterial` to swap. The equivalent
 * here is to **rewrite the colour buffer** for the primitive(s) whose GLB
 * node name matches a slot, with the slot's chosen RGB applied to the
 * authored base colour.
 *
 * Everything in this module is pure and GPU-free so it can be unit-tested
 * without a device. The actual GPU write lives in `rideScene.ts` through
 * the new `sceneryMeshPass.writeColors(id, colors)` seam.
 *
 * ### Shared contract with React (#578 AC4 / NFR4)
 *
 * The slot classifier mirrors `SLOT_NODE_PATTERNS` in
 * `src/components/rower3d/rowerAppearance.ts` exactly. A new node name on
 * the generator side has to land in both; the engine contract test
 * (`engineCrewPaletteContract.test.ts`) walks every pattern and asserts the
 * classifier recognises it.
 */

import {
  resolveAppearanceColors,
  type AppearanceSlot,
  type HairstyleId,
  type HatId,
} from '../../../components/rower3d/rowerAppearance';
import type { RowerAppearancePreference } from '../../services/rowerAppearanceService';

/** The five slots the picker UI exposes (`rowerAppearance.AppearanceSlot`). */
export type CrewSlot = AppearanceSlot;

/** One RGBA tuple per slot — the engine's wire format. Alpha stays `1`. */
export interface CrewPalette {
  readonly top: readonly [number, number, number, number];
  readonly shorts: readonly [number, number, number, number];
  readonly shoes: readonly [number, number, number, number];
  readonly hair: readonly [number, number, number, number];
  readonly hat: readonly [number, number, number, number];
  /** Which `Hair_<Style>` sibling is drawn (#672). Absent means `'short'`. */
  readonly hairstyle?: HairstyleId;
  /** Which `Hat_<Style>` sibling is drawn; `'none'` or absent draws none (#672). */
  readonly hatStyle?: HatId;
}

/**
 * The pre-#578 baked look — matches `scripts/build_crew.py`'s palette
 * (navy unisuit, white stripe, dark hair, black shoes). The baseline for
 * a cold-start / guest row that never touched the picker.
 */
export const DEFAULT_CREW_PALETTE: CrewPalette = {
  top: [0.118, 0.227, 0.373, 1.0], // #1E3A5F navy
  shorts: [0.118, 0.227, 0.373, 1.0], // #1E3A5F navy
  shoes: [0.165, 0.165, 0.157, 1.0], // #2A2A28 black
  hair: [0.165, 0.137, 0.125, 1.0], // #2A2320 black (hair)
  hat: [0.102, 0.102, 0.102, 1.0], // #1A1A1A black
  hairstyle: 'short',
  hatStyle: 'none',
};

/**
 * The engine-side mirror of `SLOT_NODE_PATTERNS` from
 * `src/components/rower3d/rowerAppearance.ts`. Kept here so the engine does
 * not reach into a React component module at render time, and so a
 * contract test can walk the two sets side by side.
 */
export const CREW_SLOT_PATTERNS: Record<CrewSlot, RegExp> = {
  top: /^(Torso_Spine|Torso_Shoulders)_part$/,
  shorts: /^(Left|Right)Thigh_part$/,
  shoes: /^(Left|Right)Foot_part$/,
  hair: /^Hair(_(Short|Long|Buzz|Bun))?(_[A-Za-z]+)?_part$/,
  hat: /^Hat_(Cap|Visor|Beanie)(_[A-Za-z]+)?_part$/,
};

/**
 * Return the slot the given GLB node name belongs to, or `undefined` for
 * nodes that are not a recoloured part (the scull hull, the oar, …).
 */
export const classifyCrewSlot = (nodeName: string): CrewSlot | undefined => {
  for (const slot of Object.keys(CREW_SLOT_PATTERNS) as CrewSlot[]) {
    if (CREW_SLOT_PATTERNS[slot].test(nodeName)) return slot;
  }
  return undefined;
};

/** Clamp a float to `[0, 1]`. */
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Convert a `#RRGGBB` (or `#RGB`) hex to a `[r, g, b, 1]` RGBA tuple with
 * channels in `[0, 1]`. Unparseable input falls back to pure white — the
 * sanitiser upstream (`rowerAppearanceService.sanitizeAppearance`) means
 * only a developer-mode malformed override would ever land here, so we
 * degrade rather than throw.
 */
export const hexToRgba = (hex: string): [number, number, number, number] => {
  const trimmed = hex.trim().replace(/^#/, '');
  const expanded =
    trimmed.length === 3
      ? trimmed
          .split('')
          .map((c) => c + c)
          .join('')
      : trimmed;
  if (expanded.length !== 6 || !/^[0-9a-f]{6}$/i.test(expanded)) {
    return [1, 1, 1, 1];
  }
  const r = parseInt(expanded.slice(0, 2), 16) / 255;
  const g = parseInt(expanded.slice(2, 4), 16) / 255;
  const b = parseInt(expanded.slice(4, 6), 16) / 255;
  return [clamp01(r), clamp01(g), clamp01(b), 1];
};

/**
 * Build a tinted vertex-colour buffer for one primitive.
 *
 * `authoredColors` is the per-vertex RGBA the GLB shipped with (length =
 * `vertexCount * 4`). The slot's chosen colour **replaces** the RGB on
 * every vertex, keeping alpha from the authored buffer so transparent
 * parts (hat brim, hair wisps) stay transparent. Matching the React
 * side's `MeshStandardMaterial.color.set` behaviour — the picker is a
 * flat recolour, not a multiplicative tint.
 */
export const tintPrimitiveColors = (
  authoredColors: Float32Array,
  slot: CrewSlot,
  palette: CrewPalette,
): Float32Array => {
  const tint = palette[slot];
  const out = new Float32Array(authoredColors.length);
  for (let i = 0; i < authoredColors.length; i += 4) {
    out[i] = tint[0];
    out[i + 1] = tint[1];
    out[i + 2] = tint[2];
    out[i + 3] = authoredColors[i + 3] ?? 1;
  }
  return out;
};

/**
 * Build a flat-colour vertex buffer for a primitive that had only a scalar
 * `baseColor` (no per-vertex array). Mirrors the fallback path in
 * `sceneryMeshPass.register`, so callers can rebuild the exact same buffer
 * off-GPU when they decide to tint.
 */
/**
 * Build the engine's `CrewPalette` from the stored shell preference.
 *
 * The React path shares one source of truth (`resolveAppearanceColors`)
 * for the hex-id → `#RRGGBB` lookup; this just converts that to the
 * engine's RGBA tuples. Keeping the hex table in one place means a
 * palette edit in `rowerAppearance.ts` reaches the engine without a
 * second edit here.
 */
export const paletteFromPreference = (
  preference: RowerAppearancePreference,
): CrewPalette => {
  const colors = resolveAppearanceColors(preference);
  return {
    top: hexToRgba(colors.top),
    shorts: hexToRgba(colors.shorts),
    shoes: hexToRgba(colors.shoes),
    hair: hexToRgba(colors.hair),
    hat: hexToRgba(colors.hatColor),
    hairstyle: preference.hairstyle,
    hatStyle: preference.hat,
  };
};

const HAIR_NODE = /^Hair_(Short|Long|Buzz|Bun)(_|$)/;
const HAT_NODE = /^Hat_(Cap|Visor|Beanie)(_|$)/;

/**
 * Whether a crew GLB primitive is drawn under this palette (#672).
 *
 * The GLB carries every hairstyle and hat as siblings; exactly one hairstyle
 * and at most one hat are shown. Everything else (body, boat, unnamed
 * primitives) is always drawn.
 */
export const isCrewNodeVisible = (nodeName: string | undefined, palette: CrewPalette): boolean => {
  if (!nodeName) return true;
  const hair = HAIR_NODE.exec(nodeName);
  if (hair) return hair[1].toLowerCase() === (palette.hairstyle ?? 'short');
  const hat = HAT_NODE.exec(nodeName);
  if (hat) return hat[1].toLowerCase() === (palette.hatStyle ?? 'none');
  return true;
};

export const flatPrimitiveColors = (
  vertexCount: number,
  slot: CrewSlot,
  palette: CrewPalette,
): Float32Array => {
  const tint = palette[slot];
  const out = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v += 1) {
    out[v * 4] = tint[0];
    out[v * 4 + 1] = tint[1];
    out[v * 4 + 2] = tint[2];
    out[v * 4 + 3] = 1;
  }
  return out;
};
