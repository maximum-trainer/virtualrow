/**
 * Absolute `gpuMs` caps per tier (#588 FR10, D9-b), shared by
 * `webgpu-perf-budget.spec.ts` and `webgpu-scenery-kit-budgets.spec.ts`
 * (#885 FR5). Chosen with headroom over the T4 baseline so a
 * non-regression PR never trips; a cap that regularly fails is a cap that
 * gets ignored. A real regression pushes gpuMs by double digits (see #549's
 * 272 B → 256 B replica in the issue scenarios), well above the headroom.
 *
 * To update after a deliberate pass-tree change: run the perf-budget spec
 * against the GPU runner, read the recorded medians from its annotations,
 * and bump the cap by one notch — never silently retire a failure.
 */
export const GPU_MS_BUDGET: Record<'basic' | 'medium' | 'extra-high', number> = {
  basic: 6,
  medium: 12,
  'extra-high': 24,
};

export const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
