import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import rawManifest from '../../public/assets/scenery/manifest.json';
import type { SceneryManifest, SceneryManifestEntry } from '../lib/utils/sceneryManifest';

// #890 NFR3/AC7, AC11 and #891 AC2-AC4: the kit's shape, size caps and licences
// are enforced here rather than by review, so a regenerate or a dropped-in
// third-party model cannot quietly break them.

const ROOT = path.resolve(__dirname, '../..');
const PUBLIC = path.join(ROOT, 'public');
const manifest = rawManifest as unknown as SceneryManifest;

/** #890 D5-a, the HD rower cap (#672 D4-a). */
const LOD0_CAP_BYTES = 450 * 1024;
const LOD1_CAP_BYTES = 150 * 1024;

const GLB_ROOTS = ['assets/scenery', 'assets/boat'];

const glbsOnDisk = (): string[] =>
  GLB_ROOTS.flatMap((dir) =>
    fs
      .readdirSync(path.join(PUBLIC, dir), { recursive: true })
      .map((entry) => path.join(dir, entry.toString()).split(path.sep).join('/'))
      .filter((entry) => entry.endsWith('.glb')),
  ).sort();

const entries = Object.entries(manifest.models);
const scenery = entries.filter(([, m]) => m.path.startsWith('assets/scenery/'));

const isCount = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0;

const shapeProblems = (id: string, m: SceneryManifestEntry): string[] => {
  const problems: string[] = [];
  if (!/^assets\/(scenery|boat)\/[a-z0-9/-]+\.glb$/.test(m.path)) problems.push(`${id}: path ${m.path}`);
  if (path.posix.basename(m.path, '.glb') !== id) problems.push(`${id}: id is not the file name`);
  if (!isCount(m.bytes)) problems.push(`${id}: bytes`);
  if (!isCount(m.triangles)) problems.push(`${id}: triangles`);
  if (typeof m.compressed !== 'boolean') problems.push(`${id}: compressed`);
  if (m.lod1) {
    if (m.lod1.path !== m.path.replace(/\.glb$/, '.lod1.glb')) problems.push(`${id}: lod1 path`);
    if (!isCount(m.lod1.bytes) || !isCount(m.lod1.triangles)) problems.push(`${id}: lod1 counts`);
  }
  return problems;
};

describe('scenery manifest shape (#891 AC4)', () => {
  it('gives every entry a well-formed path, id, size and triangle count', () => {
    expect(entries.flatMap(([id, m]) => shapeProblems(id, m))).toEqual([]);
  });

  it('totals the LOD0 bytes of every model', () => {
    expect(manifest.totalBytes).toBe(entries.reduce((sum, [, m]) => sum + m.bytes, 0));
  });

  it('lists exactly the GLBs on disk, at their size on disk', () => {
    const listed = entries.flatMap(([, m]) => (m.lod1 ? [m.path, m.lod1.path] : [m.path])).sort();
    expect(listed).toEqual(glbsOnDisk());
    for (const [id, m] of entries) {
      expect(fs.statSync(path.join(PUBLIC, m.path)).size, id).toBe(m.bytes);
    }
  });
});

describe('scenery size caps (#890 NFR3 / AC7, #891 AC2)', () => {
  it('keeps every scenery LOD0 within 450 KB', () => {
    const over = scenery.filter(([, m]) => m.bytes > LOD0_CAP_BYTES).map(([id, m]) => `${id} ${m.bytes}`);
    expect(over).toEqual([]);
  });

  it('keeps every scenery LOD1 within 150 KB', () => {
    const over = scenery
      .filter(([, m]) => m.lod1 && m.lod1.bytes > LOD1_CAP_BYTES)
      .map(([id, m]) => `${id} ${m.lod1?.bytes}`);
    expect(over).toEqual([]);
  });
});

/** Backticked `public/...` paths in the table rows of LICENSES.md. */
const licensedPaths = (markdown: string): { path: string; thirdParty: boolean }[] => {
  const thirdPartyAt = markdown.indexOf('## Third party');
  const rows: { path: string; thirdParty: boolean }[] = [];
  for (const match of markdown.matchAll(/^\|\s*`(public\/[^`]+)`/gm)) {
    rows.push({ path: match[1], thirdParty: thirdPartyAt >= 0 && (match.index ?? 0) > thirdPartyAt });
  }
  return rows;
};

describe('asset licences (#890 AC11, #891 AC3)', () => {
  const rows = licensedPaths(fs.readFileSync(path.join(ROOT, 'LICENSES.md'), 'utf8'));

  it('reads own-work and third-party rows from the file', () => {
    expect(rows.filter((r) => !r.thirdParty).length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.thirdParty).length).toBeGreaterThan(0);
  });

  it('covers every shipped GLB with a licence row', () => {
    const uncovered = glbsOnDisk().filter((glb) => !rows.some((r) => `public/${glb}`.startsWith(r.path)));
    expect(uncovered).toEqual([]);
  });

  it('names only paths that exist', () => {
    expect(rows.filter((r) => !fs.existsSync(path.join(ROOT, r.path))).map((r) => r.path)).toEqual([]);
  });

  it('parses a third-party row only from below its heading', () => {
    const sample = '| `public/a/` | x |\n## Third party\n| `public/b/` | y |\n';
    expect(licensedPaths(sample)).toEqual([
      { path: 'public/a/', thirdParty: false },
      { path: 'public/b/', thirdParty: true },
    ]);
  });
});
