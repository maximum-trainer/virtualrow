import { describe, expect, it } from 'vitest';
import manifest from '../../../../public/assets/scenery/manifest.json';
import { SCENERY_FOOTPRINTS } from '../sceneryFootprints.generated';

// sceneryFootprints.generated.ts is written by scripts/generate-scenery-manifest.mjs.
// If someone rebuilds the manifest but forgets to regenerate the table, sync
// placement code would read stale radii. This pins the two together (#723).
describe('sceneryFootprints.generated mirrors manifest.json', () => {
  const models = (manifest as { models: Record<string, { footprint?: unknown }> }).models;

  it('has one entry for every manifest model that carries a footprint', () => {
    const withFootprint = Object.keys(models).filter((id) => models[id].footprint).sort();
    expect(Object.keys(SCENERY_FOOTPRINTS).sort()).toEqual(withFootprint);
  });

  it('copies each footprint verbatim', () => {
    for (const [id, footprint] of Object.entries(SCENERY_FOOTPRINTS)) {
      expect(footprint, id).toEqual(models[id].footprint);
    }
  });
});
