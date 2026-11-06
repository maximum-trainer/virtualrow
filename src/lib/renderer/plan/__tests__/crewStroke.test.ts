import { describe, expect, it } from 'vitest';
import {
  CREW_RIGS,
  OAR_RIG,
  catchSweep,
  crewPartTransform,
  crewStrokePose,
  finishSweep,
  gripPoint,
  oarSweep,
  type Vec3,
} from '../crewStroke';

/**
 * #672 follow-up: the rower rows. The rig drives the seat, legs, body and arms
 * from the oar's sweep, so the hands stay on the handles through the stroke.
 */

const CREWS = ['male', 'female'] as const;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const apply = (m: Float32Array, p: Vec3): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const isIdentity = (m: Float32Array) =>
  Array.from(m).every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-4);

/** One full stroke, sampled. */
const sweeps = (crew: (typeof CREWS)[number]) =>
  Array.from({ length: 41 }, (_, i) => oarSweep(crew, i / 40, 1));

describe('crew stroke rig', () => {
  it.each(CREWS)('%s: the oar sweeps between the catch and the finish', (crew) => {
    const all = sweeps(crew);
    expect(Math.min(...all)).toBeCloseTo(Math.min(catchSweep(crew), finishSweep(crew)), 5);
    expect(Math.max(...all)).toBeCloseTo(Math.max(catchSweep(crew), finishSweep(crew)), 5);
    // At the catch the handle is out over the feet; at the finish it is at the body.
    expect(gripPoint(crew, 'left', catchSweep(crew))[2]).toBeGreaterThan(
      gripPoint(crew, 'left', finishSweep(crew))[2] + 0.4,
    );
  });

  it.each(CREWS)('%s: an idle oar rests between the two ends', (crew) => {
    const idle = oarSweep(crew, 0.3, 0);
    expect(idle).toBeCloseTo((catchSweep(crew) + finishSweep(crew)) / 2, 5);
  });

  it.each(CREWS)('%s: at the catch the body and legs are in the authored pose', (crew) => {
    // The arms are not: the oarlock now sits at real height, above where the
    // authored catch holds the fists, so they lift to the handle.
    const pose = crewStrokePose(crew, catchSweep(crew));
    for (const name of ['Torso_Spine', 'Head', 'LeftThigh', 'RightKnee', 'LeftShin', 'Seat_Pan']) {
      expect(isIdentity(crewPartTransform(name, pose)!), name).toBe(true);
    }
  });

  it.each(CREWS)('%s: the grip at the catch is the authored hand', (crew) => {
    const rig = CREW_RIGS[crew];
    const left = gripPoint(crew, 'left', catchSweep(crew));
    expect(left[0]).toBeCloseTo(rig.left.hand[0], 4);
    expect(left[2]).toBeCloseTo(rig.left.hand[2], 4);
  });

  it.each(CREWS)('%s: the hands stay on the handles through the whole stroke', (crew) => {
    for (const sweep of sweeps(crew)) {
      const pose = crewStrokePose(crew, sweep);
      for (const side of ['left', 'right'] as const) {
        expect(dist(pose[side].grip, gripPoint(crew, side, sweep)), `${side} at ${sweep}`).toBeLessThan(0.01);
      }
    }
  });

  it.each(CREWS)('%s: bones keep their length and the feet stay in the stretcher', (crew) => {
    const rig = CREW_RIGS[crew];
    for (const sweep of sweeps(crew)) {
      const pose = crewStrokePose(crew, sweep);
      for (const side of ['left', 'right'] as const) {
        const r = rig[side];
        const p = pose[side];
        expect(dist(p.shoulder, p.elbow)).toBeCloseTo(dist(r.shoulder, r.elbow), 4);
        expect(dist(p.elbow, p.grip)).toBeCloseTo(dist(r.elbow, r.hand), 4);
        expect(dist(p.hip, p.knee)).toBeCloseTo(dist(r.hip, r.knee), 4);
        expect(dist(p.knee, r.ankle)).toBeCloseTo(dist(r.knee, r.ankle), 4);
        // Each limb part carries its own joints to the posed ones.
        expect(dist(apply(crewPartTransform(side === 'left' ? 'LeftArm_Upper' : 'RightArm_Upper', pose)!, r.elbow), p.elbow)).toBeLessThan(1e-4);
        expect(dist(apply(crewPartTransform(side === 'left' ? 'LeftHand' : 'RightHand', pose)!, r.hand), p.grip)).toBeLessThan(1e-4);
        expect(dist(apply(crewPartTransform(side === 'left' ? 'LeftShin' : 'RightShin', pose)!, r.ankle), r.ankle)).toBeLessThan(1e-4);
      }
    }
  });

  it.each(CREWS)('%s: the legs drive the seat back and the body swings past upright', (crew) => {
    const rig = CREW_RIGS[crew];
    const finish = crewStrokePose(crew, finishSweep(crew));
    // The authored catch is a half-slide catch, so the seat travel is short.
    expect(finish.slide).toBeGreaterThan(0.04);
    expect(finish.leanDeg).toBeLessThan(0);
    expect(finish.leanDeg).toBeGreaterThan(-30);
    // The seat pan moves with the pelvis.
    const seat = apply(crewPartTransform('Seat_Pan', finish)!, rig.pelvis);
    expect(rig.pelvis[2] - seat[2]).toBeCloseTo(finish.slide, 5);
  });

  it.each(CREWS)('%s: the hands never pass behind the chest', (crew) => {
    for (const sweep of sweeps(crew)) {
      const pose = crewStrokePose(crew, sweep);
      // The chest front sits ~0.12 m ahead of the spine line at shoulder height.
      const chestZ = pose.left.shoulder[2] + 0.06;
      expect(pose.left.grip[2], `at ${sweep}`).toBeGreaterThan(chestZ);
    }
  });

  it.each(CREWS)('%s: the hands ride over the knees, not through them', (crew) => {
    for (const sweep of sweeps(crew)) {
      const pose = crewStrokePose(crew, sweep);
      const { grip: wrist, knee } = pose.left;
      if (Math.abs(wrist[2] - knee[2]) < 0.1) {
        // Knee cap (~6 cm) plus the fist (~4 cm) between their centres.
        expect(wrist[1] - knee[1], `at ${sweep}`).toBeGreaterThan(0.1);
      }
    }
  });

  it('leaves the feet, the hull and the oars to their own transforms', () => {
    const pose = crewStrokePose('male', finishSweep('male'));
    for (const name of ['LeftFoot', 'RightFoot_Sole', 'Hull', 'LeftOar_Shaft', 'Seat_RailF', undefined]) {
      expect(crewPartTransform(name, pose), String(name)).toBeUndefined();
    }
  });

  it('carries the head, hair and hat with the torso', () => {
    const pose = crewStrokePose('female', finishSweep('female'));
    const torso = crewPartTransform('Torso_Spine', pose)!;
    for (const name of ['Neck', 'Head', 'Head_Eyes', 'Hair_Long_Tail', 'Hat_Cap_Brim', 'Torso_Stripe']) {
      expect(Array.from(crewPartTransform(name, pose)!), name).toEqual(Array.from(torso));
    }
  });

  it('knows where the oar pivots', () => {
    expect(OAR_RIG.gate).toEqual([0.8, 0.34, 0.5]);
    expect(OAR_RIG.droopDeg).toBe(10);
  });
});
