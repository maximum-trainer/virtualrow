/**
 * #737 VP-19 FR2 — assemble `__ROWER3D_RENDER_STATS` for one frame.
 *
 * Every field is this frame's own count except the explicitly named
 * `total*` ones, which accumulate since the scene was built. `groups`
 * breaks the frame down by what drew it; `scene` is the lit groups
 * together (kit meshes, sprite trees, buildings), `shadows` the cascades.
 * Top-level `triangles` / `instances` are everything submitted (scene +
 * shadows). Top-level `draws` stays the count of passes that ran, as the
 * legacy harness (`drawCalls`) has always read it.
 */

import type { PerformanceMode } from '../../../components/rower3d/constants';
import type { RenderStats } from '../renderStats';
import type { FramePacingSummary } from './framePacing';
import type { Rower3DRenderGroup, Rower3DRenderGroups, Rower3DRenderStats } from './telemetry';

/** Two crossed quads per sprite tree (`scenery.wgsl`). */
export const SPRITE_TRIANGLES_PER_INSTANCE = 4;

export interface FrameRenderInputs {
  /** Passes that ran this frame (the legacy `draws`). */
  passes: number;
  sceneryDispatch: number;
  sceneryMesh: Rower3DRenderGroup;
  /** Sprite pass: one indirect draw per pool; `drawn` read back from the cull, −1 before the first read. */
  sprites: { draws: number; pools: ReadonlyArray<{ drawn: number }> };
  buildings: { drawn: number; triangles: number };
  shadows: Rower3DRenderGroup;
  shadowAtlasBytes: number;
}

const group = (): Rower3DRenderGroup => ({ draws: 0, instances: 0, triangles: 0 });

export const emptyRenderGroups = (): Rower3DRenderGroups => ({
  scene: group(),
  sceneryMesh: group(),
  sprites: group(),
  buildings: group(),
  shadows: group(),
});

const set = (dst: Rower3DRenderGroup, draws: number, instances: number, triangles: number): void => {
  dst.draws = draws;
  dst.instances = instances;
  dst.triangles = triangles;
};

export const assembleRenderStats = (
  stats: Omit<Rower3DRenderStats, 'drawCalls'>,
  input: FrameRenderInputs,
): void => {
  const g = stats.groups;
  set(g.sceneryMesh, input.sceneryMesh.draws, input.sceneryMesh.instances, input.sceneryMesh.triangles);

  let spriteInstances = 0;
  for (const p of input.sprites.pools) if (p.drawn > 0) spriteInstances += p.drawn;
  set(g.sprites, input.sprites.draws, spriteInstances, spriteInstances * SPRITE_TRIANGLES_PER_INSTANCE);

  set(g.buildings, input.buildings.drawn > 0 ? 1 : 0, input.buildings.drawn, input.buildings.triangles);
  set(g.shadows, input.shadows.draws, input.shadows.instances, input.shadows.triangles);
  set(
    g.scene,
    g.sceneryMesh.draws + g.sprites.draws + g.buildings.draws,
    g.sceneryMesh.instances + g.sprites.instances + g.buildings.instances,
    g.sceneryMesh.triangles + g.sprites.triangles + g.buildings.triangles,
  );

  stats.draws = input.passes;
  stats.triangles = g.scene.triangles + g.shadows.triangles;
  stats.instances = g.scene.instances + g.shadows.instances;
  stats.sceneryDispatch = input.sceneryDispatch;
  stats.sceneryDraws = g.sprites.draws + g.sceneryMesh.draws;
  stats.sceneryTriangles = g.sprites.triangles + g.sceneryMesh.triangles;
  stats.totalSceneryDispatch += stats.sceneryDispatch;
  stats.totalSceneryDraws += stats.sceneryDraws;
  stats.totalSceneryTriangles += stats.sceneryTriangles;
  stats.shadowDraws = g.shadows.draws;
  stats.shadowTriangles = g.shadows.triangles;
  stats.shadowAtlasBytes = input.shadowAtlasBytes;
};

/* -------------------------------------------------------- debug panel --- */

const TIERS: readonly PerformanceMode[] = ['basic', 'low', 'medium', 'high', 'extra-high'];

/** A panel sample to update in place each frame (the panel polls it). */
export const emptyPanelStats = (): RenderStats => ({
  backend: 'webgpu',
  performanceMode: 'medium',
  drawing: 'webgpu',
  drawCalls: 0,
  triangles: 0,
  sampledAt: 0,
});

export interface PanelStatsInput {
  stats: Omit<Rower3DRenderStats, 'drawCalls'>;
  pacing: FramePacingSummary;
  tier: string | undefined;
  /** Passes that ran this frame outside the grouped ones (sky, water, bank, boat, …): one draw each. */
  otherPasses: number;
  now: number;
}

/**
 * #737 FR3 — the debug panel's frame cost (`renderStats` seam): real draw
 * calls and triangles, and fps / p95 from the frame-pacing window, so its
 * `overBudget` flag holds the frame to `RENDER_BUDGET[tier].p95Ms`.
 */
export const writePanelStats = (out: RenderStats, input: PanelStatsInput): void => {
  const g = input.stats.groups;
  out.backend = 'webgpu';
  out.drawing = 'webgpu';
  out.performanceMode = (TIERS as readonly string[]).includes(input.tier ?? '')
    ? (input.tier as PerformanceMode)
    : 'medium';
  out.drawCalls = input.otherPasses + g.scene.draws + g.shadows.draws;
  out.triangles = input.stats.triangles;
  const measured = input.pacing.samples > 0 && input.pacing.p50 > 0;
  out.fps = measured ? 1000 / input.pacing.p50 : undefined;
  out.p95Ms = measured ? input.pacing.p95 : undefined;
  out.sampledAt = input.now;
};
