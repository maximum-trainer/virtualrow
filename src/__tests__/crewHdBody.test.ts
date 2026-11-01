import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseGlbJson, readGlbWorldBounds } from '../lib/utils/glbBounds';

/**
 * #672 — the crew is the high-definition llm-cad rower (`scripts/crew_body.py`),
 * not the box-and-ellipsoid placeholder it replaced.
 *
 * These pin what makes it "HD" so a regenerate cannot quietly fall back to
 * primitives: the anatomy nodes exist, the body carries a real triangle budget,
 * male and female differ in build, and the whole thing still fits the 450 KB
 * per-gender cap (D4-a).
 */

const CREWED = ['scull-male.glb', 'scull-female.glb'] as const;
const boat = (file: string) => fs.readFileSync(path.join(process.cwd(), 'public/assets/boat', file));

interface GltfNode {
  name?: string;
  mesh?: number;
}
interface GltfJson {
  nodes?: GltfNode[];
  meshes?: { primitives: { indices?: number }[] }[];
  accessors?: { count: number }[];
}

const BODY_PART =
  /^(Torso_|Neck|Head|(Left|Right)(Arm_|Hand|Thigh|Knee|Shin|Foot))/;

const bodyTriangles = (file: string): number => {
  const json = parseGlbJson(boat(file)) as GltfJson;
  let total = 0;
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined || !node.name || !BODY_PART.test(node.name)) continue;
    for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
      if (prim.indices === undefined) continue;
      total += Math.floor((json.accessors?.[prim.indices]?.count ?? 0) / 3);
    }
  }
  return total;
};

describe('HD rower (#672)', () => {
  it.each(CREWED)('%s carries the full anatomy, not a placeholder', (file) => {
    const names = new Set(
      ((parseGlbJson(boat(file)) as GltfJson).nodes ?? []).map((n) => n.name).filter(Boolean),
    );
    for (const name of [
      'Neck',
      'Head',
      'Head_Eyes',
      'Torso_Stripe',
      'LeftArm_Upper',
      'RightArm_Fore',
      'LeftHand',
      'RightHand',
      'LeftKnee',
      'RightShin',
      'LeftFoot',
      'RightFoot_Sole',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it.each(CREWED)('%s spends a real triangle budget on the body', (file) => {
    // The placeholder body was a few hundred triangles of boxes; the HD body
    // is tens of thousands even after the kit's meshopt simplification.
    expect(bodyTriangles(file)).toBeGreaterThan(15_000);
  });

  it.each(CREWED)('%s reaches past the knees to the handles at the catch', (file) => {
    const hand = readGlbWorldBounds(boat(file), (n) => n === 'RightHand');
    const knee = readGlbWorldBounds(boat(file), (n) => n === 'RightKnee');
    expect(hand!.max[2]).toBeGreaterThan(knee!.max[2]);
  });

  it('builds the male broader across the shoulders than the female (AC3)', () => {
    const width = (file: string) =>
      readGlbWorldBounds(boat(file), (n) => n === 'Torso_Shoulders')!.x;
    expect(width('scull-male.glb') / width('scull-female.glb')).toBeGreaterThanOrEqual(1.05);
  });

  it.each(CREWED)('%s fits the 450 KB per-gender cap (D4-a)', (file) => {
    expect(fs.statSync(path.join(process.cwd(), 'public/assets/boat', file)).size).toBeLessThanOrEqual(
      450 * 1024,
    );
  });
});
