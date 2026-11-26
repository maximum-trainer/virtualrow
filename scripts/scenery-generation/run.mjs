#!/usr/bin/env node
/**
 * Generates route-specific scenery for rownative courses with llm-cad and
 * ingests it into the kit (#449 FR3-FR7, FR10).
 *
 *   node scripts/scenery-generation/run.mjs --courses "<id> <id> ..." \
 *     [--llm-cad-dir <dir>] [--model <id>] [--root <dir>] [--summary <file>] \
 *     [--run-url <url>] [--run-id <id>] [--dry-run]
 *
 * (`--course-id <id>` is accepted for a single course.)
 *
 * Per course: fetch the course JSON from rownative and hash it (FR3), run
 * `llm-cad generate-course` with a pinned model and a seed derived from the
 * course id (FR4, FR12), check each GLB against the size caps (NFR2 and the kit
 * gate), copy it to `public/assets/scenery/tier-r/<id>/` (FR5), merge its
 * placements into `route-placements.json` (FR6) and record the course in
 * `processed-courses.json` (FR7), adding LICENSES.md's tier-r row the first
 * time a model lands. Each GLB is stored as `r-<id>-<name>.glb`. A course that fails stays out of the snapshot
 * so the next run retries it. The workflow and a local run take this same path;
 * neither touches git (AC11). The workflow regenerates the manifest afterwards
 * (D12).
 *
 * `LLM_CAD_MODEL_API_KEY` must be set unless `--stub` is passed; the stub
 * writes a tiny placeholder GLB so the harness can be exercised offline.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { COURSE_ID_PATTERN, ROWNATIVE_COURSE_BASE_URL } from './plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

/** NFR2: a generated model over 500 KB gzipped is rejected. */
export const GZIP_CAP_BYTES = 500 * 1024;
/** The kit gate in sceneryKitGates.test.ts (#890 D5-a) holds every LOD0 to 450 KB on disk. */
export const RAW_CAP_BYTES = 450 * 1024;
/** Pinned so a re-run of a course reproduces it (FR12): Claude via the Messages API with an Anthropic key (llm-cad#44). The workflow can override it. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MAX_MODELS_PER_COURSE = 3;

const REGISTRY_PATH = ['public', 'assets', 'scenery', 'route-placements.json'];
const SNAPSHOT_PATH = ['scripts', 'scenery-generation', 'processed-courses.json'];
const TIER_R_PATH = ['public', 'assets', 'scenery', 'tier-r'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** FR12: seed = a hash of the route id, so the same course always gets the same seed. */
export const seedFor = (courseId) => Number.parseInt(sha256(courseId).slice(0, 8), 16) & 0x7fffffff;

/** Rejects a GLB that breaks either cap; `null` when it fits. */
export const sizeProblem = (bytes) => {
  if (bytes.byteLength > RAW_CAP_BYTES) return `${bytes.byteLength} B on disk is over the ${RAW_CAP_BYTES} B kit cap`;
  const gz = gzipSync(bytes, { level: 9 }).byteLength;
  if (gz > GZIP_CAP_BYTES) return `${gz} B gzipped is over the ${GZIP_CAP_BYTES} B cap`;
  return null;
};

/**
 * The file name a course's GLB gets on disk. The manifest keys models by file
 * name, and two courses can draw the same name ("narragansett-boat-club-
 * boathouse.glb" for both 104 and 106 in the first real run), so the course id
 * goes in front.
 */
export const diskName = (courseId, filename) => `r-${courseId}-${filename}`;

/** LICENSES.md row for the generated tier (#890 AC11): the kit gate fails on a GLB folder it does not cover. */
export const TIER_R_LICENCE_ROW =
  '| `public/assets/scenery/tier-r/` | Route-specific models, one folder per rownative course | `scripts/scenery-generation/run.mjs` (llm-cad `generate-course`, #449) |';

/** Adds the tier-r row after the last own-work scenery tier row, once. */
export const ensureLicenceRow = (markdown) => {
  if (markdown.includes('`public/assets/scenery/tier-r/`')) return markdown;
  const lines = markdown.split('\n');
  const end = lines.findIndex((l) => l.startsWith('## Third party'));
  const ownWork = end < 0 ? lines : lines.slice(0, end);
  let at = -1;
  ownWork.forEach((l, i) => {
    if (l.startsWith('| `public/assets/scenery/tier-')) at = i;
  });
  if (at < 0) throw new Error('LICENSES.md: no own-work scenery tier row to add tier-r after');
  lines.splice(at + 1, 0, TIER_R_LICENCE_ROW);
  return lines.join('\n');
};

/** One llm-cad placement as a registry entry (FR6 / D7). */
export const toRegistryEntry = (courseId, placement, sourceRun) => {
  const slug = String(placement.filename).replace(/\.glb$/i, '');
  const modelId = /^r-[A-Za-z0-9_-]{1,196}$/.test(placement.modelId) ? placement.modelId : `r-${courseId}-${slug}`.slice(0, 198);
  const entry = {
    modelId,
    assetPath: `/assets/scenery/tier-r/${courseId}/${diskName(courseId, placement.filename)}`,
    distanceAlongRouteMeters: Math.max(0, Number(placement.distanceAlongRouteMeters)),
    bankSide: placement.bankSide,
    lateralOffsetMeters: Number(placement.lateralOffsetMeters ?? 0),
    orientationDegrees: Number(placement.orientationDegrees ?? 0),
    scale: Number(placement.scale ?? 1),
  };
  if (sourceRun) entry.sourceRun = sourceRun;
  return entry;
};

const runCommand = (command, args, options) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
    child.on('error', (err) => resolvePromise({ code: 127, error: err.message }));
    child.on('close', (code) => resolvePromise({ code: code ?? 1 }));
  });

/**
 * The one seam to llm-cad (D1): `uv run llm-cad generate-course` from a
 * checkout of MaximumTrainer/llm-cad. Returns what it wrote to `outDir`.
 */
export const invokeLlmCad = async ({ courseJsonPath, outDir, llmCadDir, model, seed, run = runCommand }) => {
  const args = [
    'run', '--directory', llmCadDir, 'llm-cad', 'generate-course',
    '--course-json', courseJsonPath, '--out', outDir,
    '--model', model, '--seed', String(seed), '--max-models', String(MAX_MODELS_PER_COURSE),
  ];
  const result = await run('uv', args, { env: process.env });
  return { exitCode: result.code, error: result.error };
};

/** Offline stand-in for `invokeLlmCad`: one 12-byte GLB header and one placement. */
export const stubLlmCad = async ({ outDir }) => {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, 12, true);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'landmark.glb'), header);
  await writeFile(
    join(outDir, 'placements.json'),
    JSON.stringify([{ modelId: '', filename: 'landmark.glb', distanceAlongRouteMeters: 1500, bankSide: 'right', lateralOffsetMeters: 4.5, orientationDegrees: 0, scale: 1 }]),
  );
  return { exitCode: 0 };
};

const readJsonIfPresent = async (path) => (existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null);

/**
 * Fetch, generate and size-check one course. Writes nothing into the repo;
 * `applyOutcome` does that.
 */
export const processCourse = async ({ courseId, generate, fetchFn = fetch, workRoot }) => {
  const outcome = { courseId, courseSha: null, admitted: [], rejected: [], placements: [], failures: [], error: null };
  if (!COURSE_ID_PATTERN.test(courseId)) {
    outcome.error = 'invalid course id';
    return outcome;
  }
  let courseText;
  try {
    const res = await fetchFn(`${ROWNATIVE_COURSE_BASE_URL}/${courseId}.json`);
    if (!res.ok) throw new Error(`rownative returned ${res.status}`);
    courseText = await res.text();
  } catch (err) {
    outcome.error = `course fetch failed: ${err.message}`; // FR3: logged and skipped, not aborted
    return outcome;
  }
  outcome.courseSha = sha256(courseText);

  const work = await mkdtemp(join(workRoot ?? tmpdir(), `scenery-${courseId}-`));
  const courseJsonPath = join(work, `${courseId}.json`);
  const outDir = join(work, 'out');
  await writeFile(courseJsonPath, courseText);
  const run = await generate({ courseId, courseJsonPath, outDir, seed: seedFor(courseId) });
  const report = await readJsonIfPresent(join(outDir, 'report.json'));
  outcome.report = report;
  for (const f of report?.failures ?? []) outcome.failures.push(f);
  if (report?.planError) outcome.failures.push({ modelId: '(plan)', error: report.planError });
  if (run.exitCode !== 0) {
    outcome.error = `llm-cad exited ${run.exitCode}${run.error ? ` (${run.error})` : ''}`;
    return outcome;
  }
  const placements = (await readJsonIfPresent(join(outDir, 'placements.json'))) ?? [];
  const files = new Set(await readdir(outDir));
  for (const p of placements) {
    if (typeof p.filename !== 'string' || !/^[A-Za-z0-9_-]+\.glb$/.test(p.filename) || !files.has(p.filename)) {
      outcome.rejected.push({ filename: String(p.filename), reason: 'missing or badly named GLB' });
      continue;
    }
    const bytes = new Uint8Array(await readFile(join(outDir, p.filename)));
    const problem = sizeProblem(bytes);
    if (problem) {
      outcome.rejected.push({ filename: p.filename, reason: problem });
      continue;
    }
    outcome.admitted.push({ filename: p.filename, bytes, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength });
    outcome.placements.push(p);
  }
  if (outcome.admitted.length === 0 && !outcome.error) outcome.error = 'no GLB within the caps';
  return outcome;
};

/**
 * Write one course's admitted GLBs and merge its placements and snapshot entry
 * (FR5-FR7). Only a course with at least one admitted GLB is recorded, so a
 * failed course is retried next run. An existing GLB that differs from the new
 * one is kept and reported (D11: a hand edit is never overwritten).
 */
export const applyOutcome = async ({ outcome, root, registry, snapshot, now, runId, runUrl }) => {
  const kept = [];
  if (outcome.admitted.length === 0) return { registry, snapshot, kept };
  const dir = join(root, ...TIER_R_PATH, outcome.courseId);
  await mkdir(dir, { recursive: true });
  for (const glb of outcome.admitted) {
    const name = diskName(outcome.courseId, glb.filename);
    const target = join(dir, name);
    if (existsSync(target)) {
      const current = await readFile(target);
      if (sha256(current) !== sha256(glb.bytes)) {
        kept.push(name);
        continue;
      }
    }
    await writeFile(target, glb.bytes);
  }
  const entries = outcome.placements.map((p) => toRegistryEntry(outcome.courseId, p, runUrl));
  const nextRegistry = {
    ...registry,
    placements: { ...registry.placements, [outcome.courseId]: entries },
  };
  const nextSnapshot = {
    ...snapshot,
    courses: {
      ...(snapshot.courses ?? {}),
      [outcome.courseId]: { courseSha: outcome.courseSha, generatedAt: now, workflowRunId: runId ?? 'local' },
    },
  };
  return { registry: sortRegistry(nextRegistry), snapshot: sortSnapshot(nextSnapshot), kept };
};

const sortKeys = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
const sortRegistry = (r) => ({ ...r, placements: sortKeys(r.placements) });
const sortSnapshot = (s) => ({ ...s, courses: sortKeys(s.courses) });

/** The PR body's per-course table and failures (FR8). */
export const formatSummary = (outcomes, { model, runUrl } = {}) => {
  const landed = outcomes.filter((o) => o.admitted.length > 0);
  const lines = [
    `Automated llm-cad scenery run (#449 FR8): ${landed.length} of ${outcomes.length} courses produced models.`,
    '',
    `Model: \`${model ?? DEFAULT_MODEL}\`, seed per course from its id (FR12).${runUrl ? ` Run: ${runUrl}` : ''}`,
    '',
    '| Course | Models | Sizes (gzipped) |',
    '|---|---|---|',
  ];
  for (const o of landed) {
    const sizes = o.admitted.map((g) => `${g.filename} ${(g.gzipBytes / 1024).toFixed(1)} KB`).join(', ');
    lines.push(`| ${o.courseId} | ${o.admitted.length} | ${sizes} |`);
  }
  const failed = outcomes.filter((o) => o.error || o.rejected.length > 0 || o.failures.length > 0);
  if (failed.length > 0) {
    lines.push('', '### Failed', '');
    for (const o of failed) {
      if (o.error) lines.push(`- ${o.courseId}: ${o.error}`);
      for (const r of o.rejected) lines.push(`- ${o.courseId}/${r.filename}: ${r.reason}`);
      for (const f of o.failures) lines.push(`- ${o.courseId}/${f.modelId}: ${f.error}`);
    }
  }
  lines.push(
    '',
    '### Reviewer checklist',
    '',
    '- [ ] Row one of the courses above and check each new model stands where its placement says.',
  );
  return `${lines.join('\n')}\n`;
};

const parseArgs = (argv) => {
  const out = { courses: [], dryRun: false, stub: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--course-id') out.courses.push(argv[++i]);
    else if (a === '--courses') out.courses.push(...String(argv[++i]).split(/[\s,]+/).filter(Boolean));
    else if (a === '--llm-cad-dir') out.llmCadDir = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--summary') out.summary = argv[++i];
    else if (a === '--run-url') out.runUrl = argv[++i];
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--stub') out.stub = true;
  }
  return out;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.courses.length === 0) {
    console.error('--courses or --course-id is required');
    process.exit(2);
  }
  const model = args.model || DEFAULT_MODEL;
  if (!args.stub && !process.env.LLM_CAD_MODEL_API_KEY) {
    console.error('LLM_CAD_MODEL_API_KEY is not set (pass --stub for an offline run)');
    process.exit(2);
  }
  if (!args.stub && !args.llmCadDir) {
    console.error('--llm-cad-dir <checkout of MaximumTrainer/llm-cad> is required');
    process.exit(2);
  }
  const root = resolve(args.root ?? REPO_ROOT);
  const generate = args.stub
    ? stubLlmCad
    : (opts) => invokeLlmCad({ ...opts, llmCadDir: resolve(args.llmCadDir), model });

  const registryPath = join(root, ...REGISTRY_PATH);
  const snapshotPath = join(root, ...SNAPSHOT_PATH);
  let registry = JSON.parse(await readFile(registryPath, 'utf8'));
  let snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const workRoot = await mkdtemp(join(tmpdir(), 'scenery-generation-'));
  const outcomes = [];
  try {
    for (const courseId of args.courses) {
      console.log(`[scenery-generation] ${courseId}: generating (model ${model}, seed ${seedFor(courseId)})`);
      const outcome = await processCourse({ courseId, generate, workRoot });
      outcomes.push(outcome);
      console.log(`[scenery-generation] ${courseId}: admitted ${outcome.admitted.length}, rejected ${outcome.rejected.length}${outcome.error ? `, ${outcome.error}` : ''}`);
      if (args.dryRun) continue;
      const applied = await applyOutcome({ outcome, root, registry, snapshot, now: new Date().toISOString(), runId: args.runId, runUrl: args.runUrl });
      registry = applied.registry;
      snapshot = applied.snapshot;
      for (const f of applied.kept) console.warn(`[scenery-generation] ${courseId}/${f}: kept the existing file (differs from the new one; D11)`);
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
  if (!args.dryRun) {
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    if (outcomes.some((o) => o.admitted.length > 0)) {
      const licencesPath = join(root, 'LICENSES.md');
      const licences = await readFile(licencesPath, 'utf8');
      const next = ensureLicenceRow(licences);
      if (next !== licences) await writeFile(licencesPath, next);
    }
  }
  const summary = formatSummary(outcomes, { model, runUrl: args.runUrl });
  if (args.summary) await writeFile(args.summary, summary);
  console.log(summary);
  const landed = outcomes.filter((o) => o.admitted.length > 0).length;
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `landed=${landed}\n`);
  }
};

// The second test is the one that matches on Windows (C:\\... vs file:///C:/...).
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

