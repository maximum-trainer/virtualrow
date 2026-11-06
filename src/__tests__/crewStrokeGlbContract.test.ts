import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseGlbJson, readGlbWorldBounds } from '../lib/utils/glbBounds';
import { CREW_RIGS, OAR_RIG, type Vec3 } from '../lib/renderer/plan/crewStroke';

/**
 * #672 follow-up: the stroke rig in `crewStroke.ts` hardcodes the joints from
 * `scripts/crew_body.py` and the oar rigging from `scripts/build_crew.py`.
 * This checks those numbers against the GLBs we ship, so a regenerate that
 * moves a joint or the gate fails here instead of tearing a limb off mid-row.
 */

const GLB = { male: 'scull-male.glb', female: 'scull-female.glb' } as const;
const boat = (file: string) => fs.readFileSync(path.join(process.cwd(), 'public/assets/boat', file));

/** True when `p` lies in the named node's world box grown by `pad` metres. */
const near = (glb: Buffer, node: string, p: Vec3, pad: number): boolean => {
  const b = readGlbWorldBounds(glb, (n) => n === node);
  if (!b) return false;
  return [0, 1, 2].every((i) => p[i] >= b.min[i] - pad && p[i] <= b.max[i] + pad);
};

interface Node {
  name?: string;
  translation?: number[];
  rotation?: number[];
}

describe('crew stroke rig matches the GLBs', () => {
  it.each(Object.keys(GLB) as (keyof typeof GLB)[])('%s: the joints sit where the parts meet', (crew) => {
    const glb = boat(GLB[crew]);
    for (const [side, prefix] of [['left', 'Left'], ['right', 'Right']] as const) {
      const j = CREW_RIGS[crew][side];
      expect(near(glb, `${prefix}Arm_Upper`, j.shoulder, 0.03), `${side} shoulder`).toBe(true);
      expect(near(glb, `${prefix}Arm_Upper`, j.elbow, 0.03), `${side} elbow / upper`).toBe(true);
      expect(near(glb, `${prefix}Arm_Fore`, j.elbow, 0.03), `${side} elbow / fore`).toBe(true);
      // The grip is the centre of the fist, inside the hand.
      expect(near(glb, `${prefix}Hand`, j.hand, 0), `${side} grip / hand`).toBe(true);
      expect(near(glb, `${prefix}Thigh`, j.hip, 0.05), `${side} hip`).toBe(true);
      expect(near(glb, `${prefix}Knee`, j.knee, 0.01), `${side} knee`).toBe(true);
      expect(near(glb, `${prefix}Shin`, j.ankle, 0.03), `${side} ankle`).toBe(true);
    }
  });

  it.each(Object.values(GLB))('%s: the oars pivot and droop where the rig expects', (file) => {
    const nodes = (parseGlbJson(boat(file)) as { nodes?: Node[] }).nodes ?? [];
    for (const [name, sx] of [['LeftOar', -1], ['RightOar', 1]] as const) {
      const n = nodes.find((x) => x.name === name)!;
      expect(n.translation![0]).toBeCloseTo(sx * OAR_RIG.gate[0], 4);
      expect(n.translation![1]).toBeCloseTo(OAR_RIG.gate[1], 4);
      expect(n.translation![2]).toBeCloseTo(OAR_RIG.gate[2], 4);
      // A rotation about Z only: the droop.
      const [qx, qy, qz, qw] = n.rotation!;
      expect(Math.abs(qx) + Math.abs(qy)).toBeLessThan(1e-6);
      const deg = (2 * Math.atan2(qz, qw) * 180) / Math.PI;
      // The left outboard end (-X) drops for +Z, the right (+X) for -Z.
      expect(deg).toBeCloseTo(-sx * OAR_RIG.droopDeg, 3);
    }
  });
});
