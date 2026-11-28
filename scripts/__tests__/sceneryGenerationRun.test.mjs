/**
 * Vitest for the scenery-generation harness (#449 FR3-FR8, AC3-AC5, AC11, AC12, NFR2).
 *
 * llm-cad itself is stubbed: `generate` writes what `llm-cad generate-course`
 * would (GLBs, placements.json, report.json) into the directory it is given.
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GZIP_CAP_BYTES,
  RAW_CAP_BYTES,
  TIER_R_LICENCE_ROW,
  applyOutcome,
  diskName,
  ensureLicenceRow,
  formatSummary,
  invokeLlmCad,
  processCourse,
  seedFor,
  sizeProblem,
  stubLlmCad,
  toRegistryEntry,
} from '../scenery-generation/run.mjs';

const okFetch = (text = '{"name":"Course"}') => async () => ({ ok: true, status: 200, text: async () => text });

const placement = (filename, extra = {}) => ({
  modelId: `r-7-${filename.replace('.glb', '')}`,
  filename,
  distanceAlongRouteMeters: 120,
  bankSide: 'left',
  lateralOffsetMeters: 12,
  orientationDegrees: 90,
  scale: 1,
  ...extra,
});

/** A fake `llm-cad generate-course` that writes the given files. */
const fakeGenerate = ({ glbs = {}, placements = [], exitCode = 0, failures = [] }) => async ({ outDir }) => {
  await mkdir(outDir, { recursive: true });
  for (const [name, bytes] of Object.entries(glbs)) await writeFile(join(outDir, name), bytes);
  if (placements.length) await writeFile(join(outDir, 'placements.json'), JSON.stringify(placements));
  await writeFile(join(outDir, 'report.json'), JSON.stringify({ failures, planError: null }));
  return { exitCode };
};

/** Bytes that do not compress, so the gzip cap is what they test. */
const noise = (n) => {
  const out = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
};

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scenery-run-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scenery-generation run (#449)', () => {
  it('derives a stable seed from the course id (FR12)', () => {
    expect(seedFor('277')).toBe(seedFor('277'));
    expect(seedFor('277')).not.toBe(seedFor('180'));
    expect(Number.isInteger(seedFor('277'))).toBe(true);
    expect(seedFor('277')).toBeGreaterThanOrEqual(0);
  });

  it('admits a small GLB and rejects one over either cap (AC5, NFR2)', () => {
    expect(sizeProblem(new Uint8Array(100 * 1024))).toBeNull();
    expect(sizeProblem(new Uint8Array(RAW_CAP_BYTES + 1))).toMatch(/kit cap/);
    expect(GZIP_CAP_BYTES).toBeGreaterThan(RAW_CAP_BYTES); // so the raw cap binds first today
  });

  it('calls llm-cad generate-course with the course, model and seed (D1, FR4)', async () => {
    const calls = [];
    const run = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0 };
    };
    const res = await invokeLlmCad({ courseJsonPath: '/c/7.json', outDir: '/o', llmCadDir: '/llm-cad', model: 'm/x', seed: 42, run });
    expect(res.exitCode).toBe(0);
    expect(calls[0]).toEqual([
      'uv', 'run', '--directory', '/llm-cad', 'llm-cad', 'generate-course',
      '--course-json', '/c/7.json', '--out', '/o', '--model', 'm/x', '--seed', '42', '--max-models', '3',
    ]);
  });

  it('hashes the course and keeps the GLBs within the caps (FR3, FR5)', async () => {
    const generate = fakeGenerate({
      glbs: { 'small.glb': new Uint8Array(1000), 'big.glb': noise(RAW_CAP_BYTES + 10) },
      placements: [placement('small.glb'), placement('big.glb')],
    });
    const o = await processCourse({ courseId: '7', generate, fetchFn: okFetch('course'), workRoot: root });
    expect(o.courseSha).toMatch(/^[0-9a-f]{64}$/);
    expect(o.admitted.map((g) => g.filename)).toEqual(['small.glb']);
    expect(o.rejected).toEqual([{ filename: 'big.glb', reason: expect.stringMatching(/cap/) }]);
    expect(o.placements.map((p) => p.filename)).toEqual(['small.glb']);
    expect(o.error).toBeNull();
  });

  it('gives an admitted model the indices and normals llm-cad leaves out (FR5, AC9)', async () => {
    const { Document, NodeIO } = await import('@gltf-transform/core');
    const doc = new Document();
    const buffer = doc.createBuffer();
    const position = doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]));
    doc.createNode().setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', position)));
    const io = new NodeIO();
    const generate = fakeGenerate({ glbs: { 'shed.glb': await io.writeBinary(doc) }, placements: [placement('shed.glb')] });
    const o = await processCourse({ courseId: '7', generate, fetchFn: okFetch('course'), workRoot: root });
    const admitted = await io.readBinary(o.admitted[0].bytes);
    const primitive = admitted.getRoot().listMeshes()[0].listPrimitives()[0];
    expect(primitive.getAttribute('NORMAL')).not.toBeNull();
    expect(primitive.getIndices()).not.toBeNull();
  });

  it('skips a course rownative cannot serve, without aborting (FR3)', async () => {
    const notFound = async () => ({ ok: false, status: 404, text: async () => '' });
    const o = await processCourse({ courseId: '9', generate: fakeGenerate({}), fetchFn: notFound, workRoot: root });
    expect(o.error).toMatch(/404/);
    expect(o.admitted).toEqual([]);
  });

  it('reports a non-zero llm-cad exit and its failures (AC4)', async () => {
    const generate = fakeGenerate({ exitCode: 1, failures: [{ modelId: 'r-2-tower', error: 'SyntaxError' }] });
    const o = await processCourse({ courseId: '2', generate, fetchFn: okFetch(), workRoot: root });
    expect(o.error).toMatch(/exited 1/);
    expect(o.failures).toEqual([{ modelId: 'r-2-tower', error: 'SyntaxError' }]);
  });

  it('rejects a placement whose GLB is missing or badly named', async () => {
    const generate = fakeGenerate({ placements: [placement('gone.glb'), placement('../x.glb')] });
    const o = await processCourse({ courseId: '7', generate, fetchFn: okFetch(), workRoot: root });
    expect(o.rejected.map((r) => r.filename)).toEqual(['gone.glb', '../x.glb']);
    expect(o.error).toBe('no GLB within the caps');
  });

  it('refuses an id that is not a rownative id, before any request', async () => {
    let fetched = false;
    const o = await processCourse({ courseId: '../etc', generate: fakeGenerate({}), fetchFn: async () => { fetched = true; }, workRoot: root });
    expect(o.error).toBe('invalid course id');
    expect(fetched).toBe(false);
  });

  it('maps an llm-cad placement onto the registry schema (FR6, D7)', () => {
    expect(toRegistryEntry('7', placement('tower.glb'), 'https://run/1')).toEqual({
      modelId: 'r-7-tower',
      assetPath: '/assets/scenery/tier-r/7/r-7-tower.glb',
      distanceAlongRouteMeters: 120,
      bankSide: 'left',
      lateralOffsetMeters: 12,
      orientationDegrees: 90,
      scale: 1,
      sourceRun: 'https://run/1',
    });
    expect(toRegistryEntry('7', placement('tower.glb', { modelId: '' })).modelId).toBe('r-7-tower');
  });

  it('writes GLBs, merges placements and records the course in one step (FR5-FR7, AC3)', async () => {
    const o = await processCourse({
      courseId: '7',
      generate: fakeGenerate({ glbs: { 'tower.glb': new Uint8Array([1, 2, 3]) }, placements: [placement('tower.glb')] }),
      fetchFn: okFetch(),
      workRoot: root,
    });
    const registry = { $schemaVersion: 2, placements: { '3': [] } };
    const snapshot = { $schemaVersion: 1, courses: {} };
    const res = await applyOutcome({ outcome: o, root, registry, snapshot, now: '2026-11-26T00:00:00.000Z', runId: '99' });
    expect(await readFile(join(root, 'public/assets/scenery/tier-r/7/r-7-tower.glb'))).toEqual(Buffer.from([1, 2, 3]));
    expect(Object.keys(res.registry.placements)).toEqual(['3', '7']);
    expect(res.registry.placements['7']).toHaveLength(1);
    expect(res.snapshot.courses['7']).toEqual({ courseSha: o.courseSha, generatedAt: '2026-11-26T00:00:00.000Z', workflowRunId: '99' });
  });

  it('leaves a failed course out of the snapshot so the next run retries it (FR7)', async () => {
    const failed = { courseId: '2', courseSha: 'x', admitted: [], rejected: [], placements: [], failures: [], error: 'boom' };
    const registry = { $schemaVersion: 2, placements: {} };
    const snapshot = { $schemaVersion: 1, courses: {} };
    const res = await applyOutcome({ outcome: failed, root, registry, snapshot, now: 'n' });
    expect(res.snapshot).toBe(snapshot);
    expect(res.registry).toBe(registry);
    expect(existsSync(join(root, 'public'))).toBe(false);
  });

  it('never overwrites a GLB that was edited by hand (D11)', async () => {
    const dir = join(root, 'public/assets/scenery/tier-r/7');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'r-7-tower.glb'), Buffer.from([9, 9]));
    const o = { courseId: '7', courseSha: 's', admitted: [{ filename: 'tower.glb', bytes: new Uint8Array([1]), gzipBytes: 20 }], rejected: [], placements: [placement('tower.glb')], failures: [], error: null };
    const res = await applyOutcome({ outcome: o, root, registry: { placements: {} }, snapshot: { courses: {} }, now: 'n' });
    expect(res.kept).toEqual(['r-7-tower.glb']);
    expect(await readFile(join(dir, 'r-7-tower.glb'))).toEqual(Buffer.from([9, 9]));
  });

  it('names each GLB on disk after its course, so two courses never share a manifest id', () => {
    // The manifest keys models by file name: course 104 and 106 both drew a
    // "narragansett-boat-club-boathouse.glb" in the first real run.
    expect(diskName('104', 'narragansett-boat-club-boathouse.glb')).toBe('r-104-narragansett-boat-club-boathouse.glb');
    expect(diskName('106', 'narragansett-boat-club-boathouse.glb')).not.toBe(diskName('104', 'narragansett-boat-club-boathouse.glb'));
  });

  it('adds the tier-r licence row once, inside the own-work table (#890 AC11)', () => {
    const md = [
      '## Own work', '', '| Path | What | Built by |', '|---|---|---|',
      '| `public/assets/scenery/tier-l/` | Liveried landmark heroes | `scripts/build_scenery.py` |',
      '| `public/assets/boat/` | Sculls and crew | `scripts/build_crew.py` |', '', '## Third party', '',
    ].join('\n');
    const once = ensureLicenceRow(md);
    expect(once).toContain(TIER_R_LICENCE_ROW);
    expect(once.indexOf(TIER_R_LICENCE_ROW)).toBeLessThan(once.indexOf('## Third party'));
    expect(once.indexOf(TIER_R_LICENCE_ROW)).toBeGreaterThan(once.indexOf('tier-l/'));
    expect(ensureLicenceRow(once)).toBe(once);
  });

  it('summarises landed and failed courses for the PR body (FR8)', () => {
    const md = formatSummary(
      [
        { courseId: '7', admitted: [{ filename: 'tower.glb', gzipBytes: 2048 }], rejected: [], failures: [], error: null },
        { courseId: '2', admitted: [], rejected: [], failures: [], error: 'llm-cad exited 1' },
      ],
      { model: 'm/x', runUrl: 'https://run/1' },
    );
    expect(md).toContain('1 of 2 courses');
    expect(md).toContain('| 7 | 1 | tower.glb 2.0 KB |');
    expect(md).toContain('### Failed');
    expect(md).toContain('- 2: llm-cad exited 1');
    expect(md).toContain('Reviewer checklist');
  });

  it('runs end to end offline with the stub (AC11)', async () => {
    const o = await processCourse({ courseId: '7', generate: stubLlmCad, fetchFn: okFetch(), workRoot: root });
    expect(o.admitted).toHaveLength(1);
    expect(o.placements[0].filename).toBe('landmark.glb');
    expect(await readdir(root)).not.toContain('public');
  });
});
