import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readGlbWorldBounds } from '../lib/utils/glbBounds';

/**
 * #721 VP-03 — a sculler sits with their back to the bow. The scene's bow is
 * +Z (the boat travels along local +Z; the wake trails from -Z), so in the
 * shipped GLBs the feet, stretcher and gates must sit sternward (-Z) of the
 * seat and the rower must face -Z.
 */

const boat = (file: string) => fs.readFileSync(path.join(process.cwd(), 'public/assets/boat', file));
const centreZ = (file: string, node: string): number => {
  const b = readGlbWorldBounds(boat(file), (n) => n === node);
  expect(b, `${file}: ${node}`).toBeTruthy();
  return (b!.min[2] + b!.max[2]) / 2;
};

describe('the sculler faces the stern (#721 FR1)', () => {
  it.each(['scull.glb', 'scull-male.glb', 'scull-female.glb'])(
    '%s: the foot stretcher and gates sit sternward of the seat',
    (file) => {
      const seat = centreZ(file, 'Seat_Pan');
      expect(centreZ(file, 'FootStretcher')).toBeLessThan(seat);
      expect(centreZ(file, 'LeftGate')).toBeLessThan(seat);
      expect(centreZ(file, 'RightGate')).toBeLessThan(seat);
    },
  );

  it.each(['scull-male.glb', 'scull-female.glb'])('%s: feet, knees and hands are sternward of the seat', (file) => {
    const seat = centreZ(file, 'Seat_Pan');
    for (const node of ['LeftFoot', 'RightKnee', 'RightHand']) {
      expect(centreZ(file, node), node).toBeLessThan(seat);
    }
  });

});
