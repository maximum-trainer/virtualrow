/**
 * #623 Phase 1 — the `keepsKitTrees` placement gate.
 *
 * Pre-#623 only `high` and `extra-high` emitted tier-E GLB trees; the
 * procedural `floraSolidPool` filled the near-field on basic/low/medium.
 * With the procedural pool retired, every tier that draws trees now
 * resolves kit-tree species, and `keepsKitTrees` returns `true` on
 * every tier.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  keepsKitTrees,
  type PerformanceMode,
} from '../lib/scenery/sceneryPlacement';

describe('keepsKitTrees (#623 Phase 1)', () => {
  it('returns true on every supported tier', () => {
    for (const t of ['basic', 'low', 'medium', 'high', 'extra-high'] as const satisfies readonly PerformanceMode[]) {
      expect(keepsKitTrees(t)).toBe(true);
    }
  });
});

describe('budgetFor still thins basic/low (#623 Phase 1 density)', () => {
  it('monotonically increases from basic → extra-high', () => {
    const b = budgetFor('basic');
    const l = budgetFor('low');
    const m = budgetFor('medium');
    const h = budgetFor('high');
    const x = budgetFor('extra-high');
    expect(b).toBeLessThan(l);
    expect(l).toBeLessThan(m);
    expect(m).toBeLessThan(h);
    expect(h).toBeLessThanOrEqual(x);
    expect(b).toBeGreaterThan(0);
    expect(x).toBe(1);
  });
});
