// #691 — the synthetic placement generator reads OSM bridge crossings
// and emits a kit-matched bridge at each crossing's progress along the
// route. Each entry sits at the river centreline (`bankSide: 'centre'`)
// so the engine's span placement path picks it up.

import { describe, expect, it } from 'vitest';
import type { Crossing } from '../../utils/bridgeCrossings';
import {
  BRIDGE_MODEL_FOR_KIND,
  synthesisePlacementsForRoute,
} from '../syntheticPlacements';

describe('#691 synthesisePlacementsForRoute — bridges', () => {
  it('emits nothing when no crossings are supplied', () => {
    expect(synthesisePlacementsForRoute({ routeId: 'r' })).toEqual([]);
    expect(
      synthesisePlacementsForRoute({ routeId: 'r', crossings: [] }),
    ).toEqual([]);
  });

  it('emits one bridge placement per crossing', () => {
    const crossings: Crossing[] = [
      { progress: 0.1, kind: 'arch' },
      { progress: 0.4, kind: 'rail' },
      { progress: 0.7, kind: 'foot' },
    ];
    const out = synthesisePlacementsForRoute({ routeId: 'r', crossings });
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.modelId)).toEqual([
      'c01-bridge-arch-masonry',
      'c04-bridge-rail-girder',
      'c06-bridge-foot-suspension',
    ]);
  });

  it('every output sits at the river centreline', () => {
    const crossings: Crossing[] = [
      { progress: 0.2, kind: 'arch' },
      { progress: 0.5, kind: 'road' },
    ];
    const out = synthesisePlacementsForRoute({ routeId: 'r', crossings });
    expect(out.every((p) => p.bankSide === 'centre')).toBe(true);
    expect(out.every((p) => p.source === 'synthetic')).toBe(true);
    expect(out.every((p) => p.scale === 1)).toBe(true);
  });

  it('covers every BridgeKind in the model map', () => {
    const kinds = Object.keys(BRIDGE_MODEL_FOR_KIND) as (keyof typeof BRIDGE_MODEL_FOR_KIND)[];
    const crossings: Crossing[] = kinds.map((kind, i) => ({
      progress: (i + 0.5) / kinds.length,
      kind,
    }));
    const out = synthesisePlacementsForRoute({ routeId: 'r', crossings });
    expect(out).toHaveLength(kinds.length);
    // Each emitted modelId is the one the kind map names.
    for (let i = 0; i < kinds.length; i += 1) {
      expect(out[i].modelId).toBe(BRIDGE_MODEL_FOR_KIND[kinds[i]]);
    }
  });

  it('skips a crossing with an out-of-range progress value', () => {
    // Defensive — enrichment should never emit these, but if it ever
    // does the synthetic generator shouldn't emit a bridge for it.
    const crossings: Crossing[] = [
      { progress: -0.1, kind: 'arch' },
      { progress: 1.1, kind: 'road' },
      { progress: Number.NaN, kind: 'rail' },
      { progress: 0.5, kind: 'arch' },
    ];
    const out = synthesisePlacementsForRoute({ routeId: 'r', crossings });
    expect(out).toHaveLength(1);
    expect(out[0].progress).toBe(0.5);
  });

  it('preserves input order', () => {
    const crossings: Crossing[] = [
      { progress: 0.9, kind: 'arch' },
      { progress: 0.1, kind: 'road' },
      { progress: 0.5, kind: 'truss' },
    ];
    const out = synthesisePlacementsForRoute({ routeId: 'r', crossings });
    expect(out.map((p) => p.progress)).toEqual([0.9, 0.1, 0.5]);
  });
});
