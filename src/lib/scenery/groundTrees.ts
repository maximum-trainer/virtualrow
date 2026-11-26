/**
 * #886 FR4 — bank-strip kit trees land on the kit landforms placed over
 * them.
 *
 * `computePlacements` writes bank-strip tree instances at the 1-D route
 * profile's elevation. When `planHorizonRelief` later drops a landform
 * whose mesh covers the same (x, z), the tree sits inside the hill —
 * parts stick out above the dome, parts disappear into it. This helper
 * is the post-plan lift: for every scenery group whose id is a kit tree,
 * each instance's `y` is raised to `max(y, landformSurfaceAt(x, z))`,
 * so a tree that falls over a kit hill stands on it.
 *
 * Pure. Works on whatever subset of groups the caller hands it, so the
 * bank + structure pass and the woodland pass can both run through it.
 * Groups without any instance to lift are returned unchanged (same
 * reference) so React / Svelte memoisation downstream is not forced to
 * re-mount scenery when there is no relief.
 */
import { landformSurfaceAt, type ReliefPlacement } from './horizonRelief';
import type { SceneryModelId } from '../../components/rower3d/sceneryAssets';

export interface SceneryInstance {
  position: [number, number, number];
  rotationY: number;
  scale: number;
}

export interface SceneryGlbGroup {
  id: SceneryModelId;
  instances: SceneryInstance[];
}

export const liftTreesOverLandforms = (
  groups: readonly SceneryGlbGroup[],
  reliefPlacements: readonly ReliefPlacement[],
  treeIds: ReadonlySet<SceneryModelId>,
): SceneryGlbGroup[] => {
  if (reliefPlacements.length === 0 || treeIds.size === 0) return groups.slice();
  return groups.map((group) => {
    if (!treeIds.has(group.id)) return group;
    let changed = false;
    const instances = group.instances.map((inst) => {
      const [x, y, z] = inst.position;
      const lift = landformSurfaceAt(reliefPlacements, x, z);
      if (lift <= y) return inst;
      changed = true;
      return { ...inst, position: [x, lift, z] as [number, number, number] };
    });
    return changed ? { id: group.id, instances } : group;
  });
};
