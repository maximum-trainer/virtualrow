#!/usr/bin/env node
/**
 * Which rownative courses the monthly scenery-generation run processes
 * (#449 FR2 / FR3 / D3 / D5).
 *
 *   node scripts/scenery-generation/plan.mjs [--max 5] [--dry-run]
 *
 * A course is processed when it is in the index but not in
 * `processed-courses.json` ("new"), or when its course file hash differs from
 * the one recorded there ("changed"). Courses run in id order, at most `--max`
 * per run; the rest wait for the next run.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** Same as `ROWNATIVE_INDEX_URL` / `ROWNATIVE_COURSE_BASE_URL` in `rownativeService.ts`. */
export const ROWNATIVE_INDEX_URL = 'https://raw.githubusercontent.com/rownative/courses/main/courses/index.json';
export const ROWNATIVE_COURSE_BASE_URL = 'https://raw.githubusercontent.com/rownative/courses/main/courses';

/** `ROWNATIVE_ROUTE_ID_PATTERN` (D3); ids end up in file paths, so nothing else passes. */
export const COURSE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export const planRun = ({ index, snapshot, max, currentShas = {} }) => {
  const processed = snapshot.courses ?? {};
  const candidates = [];
  const invalid = [];
  for (const { id } of index) {
    if (typeof id !== 'string' || !COURSE_ID_PATTERN.test(id)) {
      invalid.push(id);
    } else if (!Object.hasOwn(processed, id)) {
      candidates.push({ id, reason: 'new' });
    } else if (currentShas[id] && currentShas[id] !== processed[id].courseSha) {
      candidates.push({ id, reason: 'changed' });
    }
  }
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cap = Math.max(1, Math.floor(max));
  return { toProcess: candidates.slice(0, cap), deferred: candidates.slice(cap), invalid };
};

export const formatPlan = (plan, { dryRun }) => {
  const lines = [];
  if (plan.toProcess.length === 0) {
    lines.push('nothing to process');
  } else {
    lines.push(`${dryRun ? 'would process' : 'processing'}: ${plan.toProcess.map((c) => c.id).join(', ')}`);
  }
  if (plan.deferred.length > 0) lines.push(`deferred to next run: ${plan.deferred.length}`);
  if (plan.invalid.length > 0) lines.push(`ignored invalid ids: ${plan.invalid.length}`);
  return lines.join('\n');
};

const readBundledIndex = async () =>
  JSON.parse(await readFile(join(ROOT, 'public', 'assets', 'rownative', 'rownative-index.json'), 'utf8'));

export const loadIndex = async ({ fetchFn = fetch, readBundled = readBundledIndex } = {}) => {
  try {
    const res = await fetchFn(ROWNATIVE_INDEX_URL);
    if (res.ok) {
      const entries = await res.json();
      if (Array.isArray(entries)) return { source: 'network', entries };
    }
  } catch {
    // Offline or blocked: the nightly-refreshed bundled copy is the fallback.
  }
  return { source: 'bundled', entries: await readBundled() };
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Hashes of already-processed courses, so a re-drawn course is picked up again (D3). */
const fetchProcessedShas = async (snapshot, fetchFn = fetch) => {
  const shas = {};
  for (const id of Object.keys(snapshot.courses ?? {})) {
    if (!COURSE_ID_PATTERN.test(id)) continue;
    try {
      const res = await fetchFn(`${ROWNATIVE_COURSE_BASE_URL}/${id}.json`);
      if (res.ok) shas[id] = sha256(await res.text());
    } catch {
      // Unreachable course: keep the recorded hash, so it is not re-processed.
    }
  }
  return shas;
};

const argValue = (argv, flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const max = Number(argValue(argv, '--max') ?? 5);
  const dryRun = argv.includes('--dry-run');
  const snapshot = JSON.parse(await readFile(join(HERE, 'processed-courses.json'), 'utf8'));
  const { source, entries } = await loadIndex();
  const plan = planRun({ index: entries, snapshot, max, currentShas: await fetchProcessedShas(snapshot) });
  console.log(`index: ${entries.length} courses (${source}); already processed: ${Object.keys(snapshot.courses ?? {}).length}`);
  console.log(formatPlan(plan, { dryRun }));
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `courses=${plan.toProcess.map((c) => c.id).join(' ')}\n`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
