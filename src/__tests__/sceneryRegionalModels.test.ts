import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  REGIONAL_MODELS,
  resolveSceneryModels,
  collectSceneryPaths,
} from '../components/rower3d/sceneryAssets';
import type { SceneryRegion } from '../components/rower3d/sceneryRegion';

const ALL_REGIONS: SceneryRegion[] = ['gb', 'ce', 'it', 'nl', 'us'];

describe('REGIONAL_MODELS', () => {
  it('has a kit for every region the resolver can return', () => {
    expect(Object.keys(REGIONAL_MODELS).sort()).toEqual([...ALL_REGIONS].sort());
  });

  it('only names Tier D models', () => {
    const ids = ALL_REGIONS.flatMap((r) => [
      ...REGIONAL_MODELS[r].builtUp,
      ...REGIONAL_MODELS[r].rural,
      ...REGIONAL_MODELS[r].bankEdge,
    ]);

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^d-(gb|ce|it|nl|us)-\d{2}-/);
  });

  it('names models that exist on disk', () => {
    const missing = ALL_REGIONS
      .flatMap((r) => [...REGIONAL_MODELS[r].builtUp, ...REGIONAL_MODELS[r].rural, ...REGIONAL_MODELS[r].bankEdge])
      .filter((id) => !fs.existsSync(path.join(process.cwd(), 'public/assets/scenery/tier-d', `${id}.glb`)));

    expect(missing).toEqual([]);
  });
});

describe('resolveSceneryModels with a region', () => {
  it('dresses a built-up bank in that region’s buildings', () => {
    const gb = resolveSceneryModels('residential', 'river', [], 'gb');

    expect(gb.buildings).toContain('d-gb-01-terrace-brick');
    expect(gb.buildings).toContain('d-gb-03-riverside-pub');
  });

  it('uses the rural kit on farmland, not the town one', () => {
    const nl = resolveSceneryModels('farmland', 'canal', [], 'nl');

    expect(nl.buildings).toContain('d-nl-02-polder-windmill');
    expect(nl.buildings).not.toContain('d-nl-01-gabled-canal-house');
  });

  it('leaves wild stretches unbuilt', () => {
    expect(resolveSceneryModels('forest', 'river', [], 'gb').buildings).toEqual([]);
    expect(resolveSceneryModels('wetland', 'river', [], 'nl').buildings).toEqual([]);
  });

  it('adds a regional bank edge where the kit has one', () => {
    expect(resolveSceneryModels('wetland', 'canal', [], 'nl').bankEdge).toContain(
      'd-nl-06-reed-bank-edge',
    );
  });

  it('falls back to the generic kit when the region is unknown', () => {
    const generic = resolveSceneryModels('residential', 'river', []);

    expect(generic.buildings).toEqual([]);
    expect(generic.bankEdge.every((id) => !id.startsWith('d-'))).toBe(true);
  });

  it('includes regional buildings in the paths to preload', () => {
    const paths = collectSceneryPaths(resolveSceneryModels('residential', 'river', [], 'it'));

    expect(paths).toContain('/assets/scenery/tier-d/d-it-01-po-palazzo.glb');
  });

  // #712 FR5 phase 2c — the new biome profiles join the regional kit.
  it('village picks the regional rural kit (cottages / barns / parish churches)', () => {
    const gb = resolveSceneryModels('village', 'river', [], 'gb');
    expect(gb.buildings).toContain('d-gb-04-stone-cottage');
    expect(gb.buildings).toContain('d-gb-05-stone-barn');
    expect(gb.buildings).not.toContain('d-gb-01-terrace-brick');
  });

  it('town picks the regional built-up kit', () => {
    const gb = resolveSceneryModels('town', 'river', [], 'gb');
    expect(gb.buildings).toContain('d-gb-01-terrace-brick');
    expect(gb.buildings).toContain('d-gb-03-riverside-pub');
  });

  it('small-city picks the regional built-up kit too', () => {
    const it = resolveSceneryModels('small-city', 'river', [], 'it');
    expect(it.buildings).toContain('d-it-01-po-palazzo');
    expect(it.buildings).toContain('d-it-02-castello-valentino');
  });

  // #712 FR5 phase 2c slice 2 — the D4 minimum-kit gap meshes authored in
  // `scripts/build_scenery.py` join their region's kit (small shop → GB
  // built-up, mid-rise office → US built-up, orchard tree row → IT rural).
  it('includes the slice 2c-2 small shop in the GB built-up kit', () => {
    const gb = resolveSceneryModels('town', 'river', [], 'gb');
    expect(gb.buildings).toContain('d-gb-07-small-shop');
  });

  it('includes the slice 2c-2 mid-rise office in the US built-up kit', () => {
    const us = resolveSceneryModels('small-city', 'river', [], 'us');
    expect(us.buildings).toContain('d-us-07-mid-rise-office');
  });

  it('includes the slice 2c-2 orchard tree row in the IT rural kit', () => {
    const it = resolveSceneryModels('farmland', 'river', [], 'it');
    expect(it.buildings).toContain('d-it-04-orchard-tree-row');
  });

  it('parkland / orchard / scrub / woodland / forest-* stay unbuilt (open or wild)', () => {
    for (const profile of [
      'parkland',
      'orchard',
      'scrub',
      'woodland',
      'forest-medium',
      'forest-high',
    ] as const) {
      expect(resolveSceneryModels(profile, 'river', [], 'gb').buildings).toEqual([]);
    }
  });
});
