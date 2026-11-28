import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GEOMETRY_ALLOWLIST,
  GEOMETRY_ROLES,
  makesGeometry,
  sceneObjectViolations,
} from '../lib/renderer/sceneObjectRule';

/**
 * #890 FR9 / FR10, AC13 / AC14 — the engine scene-object rule (#623, CLAUDE.md)
 * enforced by a check instead of by review. Every renderer file that issues a
 * draw call or builds an index buffer is on a committed list that says why it
 * may; a new one fails `npm run verify` until it is drawn through
 * `sceneryMeshPass` or classified here.
 */

const ROOT = path.resolve(__dirname, '../..');
const SCANNED = ['src/lib/renderer/passes', 'src/lib/renderer/plan', 'src/lib/renderer/engine'];

const rendererSources = () =>
  SCANNED.flatMap((dir) =>
    readdirSync(path.join(ROOT, dir))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .map((name) => {
        const file = `${dir}/${name}`;
        return { file, text: readFileSync(path.join(ROOT, file), 'utf8') };
      }),
  );

describe('scene-object rule guard (#890 FR9, AC13)', () => {
  it('finds every renderer file that draws or builds index buffers on the allowlist', () => {
    expect(sceneObjectViolations(rendererSources())).toEqual([]);
  });

  it('fails a new pass file that starts drawing, naming the rule', () => {
    const violations = sceneObjectViolations([
      { file: 'src/lib/renderer/passes/hedgerow.ts', text: 'pass.drawIndexed(indexCount, instances);' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('src/lib/renderer/passes/hedgerow.ts');
    expect(violations[0]).toContain('sceneryMeshPass');
  });

  it('fails a new plan file that synthesises triangles', () => {
    const text = 'const indices = new Uint32Array(count * 6);';
    expect(sceneObjectViolations([{ file: 'src/lib/renderer/plan/haystack.ts', text }])).toHaveLength(1);
  });

  it('passes the same draw once the file is on the allowlist', () => {
    const listed = GEOMETRY_ALLOWLIST[0].file;
    expect(sceneObjectViolations([{ file: listed, text: 'pass.draw(3);' }])).toEqual([]);
  });

  it('recognises each draw call and index-buffer form, and ignores files with none', () => {
    for (const text of [
      'pass.draw(3)',
      'rp.drawIndexed(n)',
      'p.drawIndirect(buf, 0)',
      'p.drawIndexedIndirect(buf, 0)',
      'const i = new Uint16Array(6)',
      'const i = new Uint32Array(6)',
    ]) {
      expect(makesGeometry(text), text).toBe(true);
    }
    expect(makesGeometry('const m = new Float32Array(16); queue.writeBuffer(b, 0, m);')).toBe(false);
  });
});

describe('scene-object allowlist hygiene (#890 FR10, AC14)', () => {
  const files = GEOMETRY_ALLOWLIST.map((entry) => entry.file);

  it('is sorted and has no duplicates', () => {
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
  });

  it('names only files that exist', () => {
    for (const file of files) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
  });

  it('gives every entry a known role and a reason', () => {
    for (const entry of GEOMETRY_ALLOWLIST) {
      expect(GEOMETRY_ROLES, entry.file).toContain(entry.role);
      expect(entry.reason.trim().length, entry.file).toBeGreaterThan(10);
    }
  });

  it('lists no file that no longer draws or builds geometry', () => {
    const stale = GEOMETRY_ALLOWLIST.filter(
      (entry) => !makesGeometry(readFileSync(path.join(ROOT, entry.file), 'utf8')),
    ).map((entry) => entry.file);
    expect(stale).toEqual([]);
  });

  it('carries the FR10 exceptions by file', () => {
    const exceptions = GEOMETRY_ALLOWLIST.filter((entry) => entry.role === 'exception').map((entry) => entry.file);
    for (const name of ['bankStrip', 'waterStrip', 'ringBankStrip', 'lakeShore', 'islandLand', 'waterPolygon', 'boatMesh']) {
      expect(exceptions.some((file) => file.endsWith(`/plan/${name}.ts`)), name).toBe(true);
    }
  });
});
