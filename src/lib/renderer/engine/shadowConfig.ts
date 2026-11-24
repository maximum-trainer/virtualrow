/**
 * Shadow configuration per performance tier (#559 D1-a / D3-a).
 *
 * Cascade count matches #495 Phase 1 (PR #500); the atlas sizes match the
 * three-side `CascadedShadowsConfig.mapSize` and stay inside the 2048 ×
 * 2048 limit SwiftShader supports in CI.
 */

export type PerformanceTier =
  | 'basic'
  | 'low'
  | 'medium'
  | 'high'
  | 'extra-high';

export interface ShadowTierConfig {
  cascades: number;
  atlasSize: number;
  /**
   * #727 FR2 — redraw the far cascades every 2nd / 4th frame rather than
   * every frame (`cascadeRefreshInterval`). Off at extra-high.
   */
  farCascadeCadence: boolean;
}

const TIERS: Record<PerformanceTier, ShadowTierConfig> = {
  basic: { cascades: 2, atlasSize: 512, farCascadeCadence: true },
  low: { cascades: 2, atlasSize: 1024, farCascadeCadence: true },
  medium: { cascades: 3, atlasSize: 1024, farCascadeCadence: true },
  high: { cascades: 3, atlasSize: 2048, farCascadeCadence: true },
  'extra-high': { cascades: 4, atlasSize: 2048, farCascadeCadence: false },
};

export const DEFAULT_TIER: PerformanceTier = 'medium';

export const shadowConfigFor = (tier: string | undefined): ShadowTierConfig => {
  if (tier && tier in TIERS) {
    return TIERS[tier as PerformanceTier];
  }
  return TIERS[DEFAULT_TIER];
};

export const KNOWN_TIERS: readonly PerformanceTier[] = [
  'basic',
  'low',
  'medium',
  'high',
  'extra-high',
];
