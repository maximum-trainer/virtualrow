import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import manifest from '../../public/assets/scenery/manifest.json';

// #727 VP-09 FR4 — every heavy kit model ships an LOD1 at <= 35% of its
// triangles, emitted by `npm run build:assets` and listed in the manifest.

const PUBLIC = path.resolve(__dirname, '../../public');
type Entry = { path: string; bytes: number; triangles: number; lod1?: { path: string; bytes: number; triangles: number } };
const models = (manifest as unknown as { models: Record<string, Entry> }).models;
const scenery = Object.entries(models).filter(([, m]) => m.path.startsWith('assets/scenery/'));

/** Models the simplifier could not take to 35% inside a 2% bounds drift. */
const NO_LOD1 = new Set(['g11-water-tower-masonry']);

describe('scenery LOD1 (#727 FR4)', () => {
  it('lists an LOD1 for every scenery model above 1,500 triangles', () => {
    const missing = scenery
      .filter(([id, m]) => m.triangles > 1500 && !m.lod1 && !NO_LOD1.has(id))
      .map(([id]) => id);
    expect(missing).toEqual([]);
    expect(scenery.filter(([, m]) => m.lod1).length).toBeGreaterThanOrEqual(45);
  });

  it('keeps each LOD1 at no more than 35% of its model\'s triangles', () => {
    for (const [id, m] of scenery) {
      if (!m.lod1) continue;
      expect(m.lod1.triangles, id).toBeLessThanOrEqual(0.35 * m.triangles);
      expect(m.lod1.triangles, id).toBeGreaterThan(0);
    }
  });

  it('ships the file each entry names, beside its model, at the size listed', () => {
    for (const [id, m] of scenery) {
      if (!m.lod1) continue;
      expect(m.lod1.path, id).toBe(m.path.replace(/\.glb$/, '.lod1.glb'));
      expect(fs.statSync(path.join(PUBLIC, m.lod1.path)).size, id).toBe(m.lod1.bytes);
    }
  });

  it('never lists an LOD1 file as a model of its own, and leaves boats alone', () => {
    expect(Object.keys(models).filter((id) => id.endsWith('.lod1'))).toEqual([]);
    expect(Object.values(models).filter((m) => m.path.startsWith('assets/boat/') && m.lod1)).toEqual([]);
  });

  it('wires LOD emission into build:assets between compression and the manifest', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.scripts['build:assets']).toMatch(/compress-scenery\.mjs.*build-scenery-lod\.mjs.*generate-scenery-manifest\.mjs/);
  });
});
