/**
 * The scull GLB's primitives placed for each boat that rows it (#728 VP-10
 * FR1; the path #713 D1a/D3a extends to the fleet).
 *
 * The player's scull is drawn as one `sceneryMeshPass` mesh per GLB
 * primitive. Every other boat drawn from the same GLB (the race ghost
 * today) is a further instance of those same primitives: same hull, same
 * oars, same crew, posed by the same `scullPartTransform` / oar-pivot
 * swing, so the ghost rows exactly the way the player does.
 */

import { mat4, mat4FromRotationY, mat4Identity, mat4Multiply, type Mat4 } from '../math/mat4';
import { scullPartTransform, type CrewStrokePose } from './crewStroke';

export interface ScullPrimitive {
  /** World matrix of the primitive's node in the GLB (scull space). */
  readonly nodeWorld: Mat4;
  /** `LeftOar` / `RightOar` for an oar part, which swings about `pivotWorld`. */
  readonly group?: string;
  readonly pivotWorld?: Mat4;
  /** GLB node name, for the crew-part pose. */
  readonly nodeName?: string;
}

export interface ScullPose {
  /** The boat's placement: translation × heading. */
  readonly boatTrs: Mat4;
  /** Oar sweep, radians (from `oarSweep`). */
  readonly sweep: number;
  readonly stroke: CrewStrokePose;
}

const scratch = { swing: mat4(), toPivot: mat4(), fromPivot: mat4(), rot: mat4(), tmp: mat4() };

/** One primitive's world matrix for a boat in `pose`, written into `out`. */
export const scullPrimitiveTransform = (out: Mat4, prim: ScullPrimitive, pose: ScullPose): Mat4 => {
  const k = scratch;
  if (prim.group && prim.pivotWorld) {
    const sign = prim.group === 'RightOar' ? -1 : 1;
    mat4FromRotationY(k.rot, pose.sweep * sign);
    const px = prim.pivotWorld[12];
    const py = prim.pivotWorld[13];
    const pz = prim.pivotWorld[14];
    mat4Identity(k.toPivot);
    k.toPivot[12] = -px;
    k.toPivot[13] = -py;
    k.toPivot[14] = -pz;
    mat4Identity(k.fromPivot);
    k.fromPivot[12] = px;
    k.fromPivot[13] = py;
    k.fromPivot[14] = pz;
    mat4Multiply(k.tmp, k.toPivot, prim.nodeWorld);
    mat4Multiply(k.swing, k.rot, k.tmp);
    mat4Multiply(k.tmp, k.fromPivot, k.swing);
    return mat4Multiply(out, pose.boatTrs, k.tmp);
  }
  const part = scullPartTransform(prim.nodeName, pose.stroke);
  if (part) {
    mat4Multiply(k.tmp, part, prim.nodeWorld);
    return mat4Multiply(out, pose.boatTrs, k.tmp);
  }
  return mat4Multiply(out, pose.boatTrs, prim.nodeWorld);
};

/** A boat's placement matrix: at `world`, turned `heading` about +Y. */
export const scullBoatTrs = (out: Mat4, world: ArrayLike<number>, heading: number): Mat4 => {
  const rot = scratch.rot;
  const trans = scratch.tmp;
  mat4FromRotationY(rot, heading);
  mat4Identity(trans);
  trans[12] = world[0];
  trans[13] = world[1];
  trans[14] = world[2];
  return mat4Multiply(out, trans, rot);
};
