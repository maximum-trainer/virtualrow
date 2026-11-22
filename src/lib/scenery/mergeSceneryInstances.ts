/**
 * Concatenates per-model instance lists from every source the scene
 * draws (#723 FR5). The engine composes placements from three places:
 *
 *   - course furniture (`placeFurniture`): lane buoys, distance posts,
 *     the finish tower, hand-authored `ROUTE_EXTRAS`, synthetic
 *     bridges.
 *   - route GLB groups (`sceneryGlbList`): per-route generated
 *     placements from `composePlacementsForRoute` (tier-r llm-cad
 *     + synthetic + hand-authored).
 *   - synthetic scatter / bank / building placements
 *     (`computePlacements`): the walk-the-route schedule.
 *
 * Before this landed, `sceneryInstanceMats.set(id, mats)` replaced the
 * list for a model id whenever a later source wrote to it, so the
 * course furniture's finish tower vanished the moment a route GLB
 * group for `a06` came in. The merge concatenates instead, and caps
 * the result at `maxInstances` (the sceneryMesh pass's pool budget,
 * 1024 slots today).
 */

import type { Mat4 } from '../renderer/math/mat4';

export type InstanceMats = Map<string, Mat4[]>;

export interface MergeOpts {
  /** Per-model hard cap; defaults to no cap. */
  maxInstances?: number;
}

/**
 * Concatenate several per-model instance maps into one, in the order
 * their entries were passed. The first source wins on ordering (its
 * instances appear first in the output), which matters for stable
 * streaming: a late source can't push an already-loaded instance
 * past the per-model cap.
 */
export const mergeSceneryInstances = (
  sources: ReadonlyArray<ReadonlyMap<string, ReadonlyArray<Mat4>>>,
  opts: MergeOpts = {},
): InstanceMats => {
  const out = new Map<string, Mat4[]>();
  for (const source of sources) {
    for (const [id, mats] of source) {
      let bucket = out.get(id);
      if (!bucket) {
        bucket = [];
        out.set(id, bucket);
      }
      for (const mat of mats) bucket.push(mat);
    }
  }
  if (opts.maxInstances !== undefined && opts.maxInstances >= 0) {
    for (const [id, bucket] of out) {
      if (bucket.length > opts.maxInstances) {
        out.set(id, bucket.slice(0, opts.maxInstances));
      }
    }
  }
  return out;
};
