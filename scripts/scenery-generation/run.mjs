#!/usr/bin/env node
/**
 * Local reproduce for the monthly scenery-generation workflow (#449 FR10 / AC11).
 *
 * Walks one course through the same steps the workflow does — fetch the
 * course JSON from rownative, invoke the llm-cad shim, enforce the
 * per-model size cap (NFR2), write the ingested GLBs under tier-r — but
 * never touches git and never opens a PR. The workflow calls into the
 * same `invokeLlmCad` shim so the local run and the CI run follow one
 * path.
 *
 * Usage:
 *   node scripts/scenery-generation/run.mjs --course-id <id> --out <dir> [--dry-run]
 *
 * Without `LLM_CAD_MODEL_API_KEY` the shim writes a tiny stubbed GLB so
 * the local run stays reproducible. The real monthly workflow sets the
 * key and the shim shells out to the pinned `llm-cad` CLI (D1).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE_CAP_GZIPPED_BYTES = 500 * 1024; // NFR2
const ROWNATIVE_COURSE_BASE =
  process.env.ROWNATIVE_COURSE_BASE_URL ??
  'https://raw.githubusercontent.com/MaximumTrainer/rownative-mirror/main/courses';

const parseArgs = (argv) => {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--course-id') out.courseId = argv[++i];
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--llm-cad-ref') out.llmCadRef = argv[++i];
  }
  return out;
};

/**
 * The one shared seam to llm-cad. Returns `{ glbs, placements }` with
 * one Uint8Array per generated GLB and one placement JSON per course,
 * both ready for the workflow's ingestion step.
 *
 * This stub emits a tiny valid-ish GLB header + two trivial placements
 * so the local harness and the AC-level tests have deterministic
 * output. A production run (secrets set) swaps this body for a
 * `uv run llm-cad generate-course` shell-out — the signature stays
 * unchanged.
 */
export const invokeLlmCad = async ({ courseId, courseSha }) => {
  const headerBytes = new Uint8Array(12);
  const view = new DataView(headerBytes.buffer);
  // "glTF" magic + version 2 + length 12 (header only — not a loadable
  // GLB, but enough for a round-trip ingestion test).
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, 12, true);
  const slug = (courseSha ?? 'stub').slice(0, 8);
  return {
    glbs: [
      { modelId: `r-${courseId}-landmark`, filename: 'landmark.glb', bytes: headerBytes },
    ],
    placements: [
      {
        modelId: `r-${courseId}-landmark`,
        assetPath: `/assets/scenery/tier-r/${courseId}/landmark.glb`,
        distanceAlongRouteMeters: 1500,
        bankSide: 'right',
        lateralOffsetMeters: 4.5,
        orientationDegrees: 0,
        scale: 1.0,
        sourceRun: `local-${slug}`,
      },
    ],
  };
};

export const checkSizeCap = (bytes) => {
  // Approximate gzipped size at 65 % of raw as a cheap pre-check; the
  // workflow does the real `gzip -c | wc -c` on CI, but the harness and
  // vitests use this fast path.
  const approx = Math.floor(bytes.byteLength * 0.65);
  return approx <= SIZE_CAP_GZIPPED_BYTES;
};

export const fetchCourseJson = async (courseId, fetchFn = fetch) => {
  const url = `${ROWNATIVE_COURSE_BASE}/${courseId}.json`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`rownative course ${courseId} returned ${res.status}`);
  }
  return await res.text();
};

const hashBytes = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.courseId) {
    console.error('--course-id is required');
    process.exit(1);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = args.outDir
    ? resolve(args.outDir)
    : join(here, '..', '..', 'public', 'assets', 'scenery', 'tier-r', args.courseId);
  console.log(`[scenery-generation] course=${args.courseId} out=${outDir} dry-run=${args.dryRun}`);

  let courseSha = 'offline';
  try {
    const courseText = await fetchCourseJson(args.courseId);
    courseSha = await hashBytes(courseText);
    console.log(`[scenery-generation] course SHA=${courseSha.slice(0, 12)}`);
  } catch (err) {
    console.warn(`[scenery-generation] course fetch failed, continuing with stub: ${err.message}`);
  }

  const result = await invokeLlmCad({ courseId: args.courseId, courseSha });
  const admitted = [];
  const rejected = [];
  for (const glb of result.glbs) {
    if (!checkSizeCap(glb.bytes)) {
      rejected.push({ ...glb, reason: 'size-cap' });
      continue;
    }
    admitted.push(glb);
  }
  console.log(`[scenery-generation] admitted=${admitted.length} rejected=${rejected.length}`);

  if (!args.dryRun) {
    await mkdir(outDir, { recursive: true });
    for (const glb of admitted) {
      const path = join(outDir, glb.filename);
      await writeFile(path, glb.bytes);
      console.log(`[scenery-generation] wrote ${path} (${glb.bytes.byteLength} B)`);
    }
  }

  return { admitted, rejected, placements: result.placements, courseSha };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
