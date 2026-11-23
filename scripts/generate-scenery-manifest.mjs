#!/usr/bin/env node
/**
 * Write the shipped GLB kit's manifest (issue #332).
 *
 * The scene fetches a model per placement, and until now nothing in the app -
 * or in CI - knew what any of them weighed. The manifest is what the byte
 * budgets are checked against, and what lets the app warm the cache for a
 * route smallest-model-first instead of asking a static host for 58 GLBs at
 * once.
 *
 *   node scripts/generate-scenery-manifest.mjs
 *
 * Generated from the files on disk, never hand-edited; `sceneryManifest.test.ts`
 * fails if the two drift apart.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
export const MANIFEST_PATH = path.join(PUBLIC, 'assets', 'scenery', 'manifest.json');
export const FOOTPRINTS_TS_PATH = path.join(
  ROOT, 'src', 'lib', 'scenery', 'sceneryFootprints.generated.ts',
);
export const SPANS_TS_PATH = path.join(ROOT, 'src', 'lib', 'scenery', 'bridgeSpans.generated.ts');

const GLB_ROOTS = [path.join('assets', 'scenery'), path.join('assets', 'boat')];

const glbsUnder = (dir) => {
  const absolute = path.join(PUBLIC, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs
    .readdirSync(absolute, { recursive: true })
    .map((entry) => entry.toString())
    .filter((entry) => entry.toLowerCase().endsWith('.glb'))
    .map((entry) => path.join(dir, entry).split(path.sep).join('/'))
    .sort();
};

const trianglesIn = (document) =>
  document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((total, primitive) => {
      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : (primitive.getAttribute('POSITION')?.getCount() ?? 0);
      return total + Math.floor(count / 3);
    }, 0);

/** `ASSET_SCALE` from `sceneryPlacement.ts` — the base model→scene-m factor.
 *  All `footprint*` fields are reported in scene metres so a consumer doesn't
 *  have to know the mm→m convention. Kept in sync with the TS source. */
const ASSET_SCALE = 0.001;

/**
 * XZ footprint bounds for every mesh in the document, in SCENE METRES
 * (#723 FR3). Uses `@gltf-transform/functions`' `getBounds` so KHR_mesh_
 * quantization, EXT_meshopt_compression and node transforms are all
 * honoured — walking POSITION arrays by hand gets the wrong answer on
 * quantized data because the ints have to be dequantized through the
 * accessor's normalized flag plus the node's scale.
 *
 * Y is ignored on purpose; the keep-clear maths project onto the water
 * plane. `radius` is half the longer XZ extent and is what consumers
 * compare against `distanceToCentreline - waterHalfWidth`. `centre*`
 * is the model origin's offset from the AABB centre (0 for symmetric
 * models, non-zero for a boathouse whose porch sticks out).
 */
const round4 = (n) => Math.round(n * 10000) / 10000;

const footprintOf = (document) => {
  const scene = document.getRoot().listScenes()[0] ?? null;
  if (!scene) return null;
  const bounds = getBounds(scene);
  if (!bounds) return null;
  const minX = bounds.min[0] * ASSET_SCALE;
  const maxX = bounds.max[0] * ASSET_SCALE;
  const minZ = bounds.min[2] * ASSET_SCALE;
  const maxZ = bounds.max[2] * ASSET_SCALE;
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  const extentX = maxX - minX;
  const extentZ = maxZ - minZ;
  const radius = Math.max(extentX, extentZ) / 2;
  return {
    minX: round4(minX),
    maxX: round4(maxX),
    minZ: round4(minZ),
    maxZ: round4(maxZ),
    extentX: round4(extentX),
    extentZ: round4(extentZ),
    radius: round4(radius),
    centreX: round4((minX + maxX) / 2),
    centreZ: round4((minZ + maxZ) / 2),
  };
};

/**
 * #724 VP-06 FR1 — a bridge's span along its long axis, in scene metres:
 * the axis, where it starts, its length, and its navigable openings.
 * The underside is profiled in `SPAN_STEP_M` bins (the lowest point of
 * any triangle over each bin, conservatively: a triangle counts over every
 * bin its range covers); an opening is a run of bins whose underside is
 * at least `OPENING_MIN_UNDERSIDE_M`, the lowest that the largest allowed
 * span scale (1.6) can still lift to the 4.5 m clearance `bridgeSpan.ts`
 * needs. Each opening records its centre, width and lowest underside.
 */
const SPAN_STEP_M = 0.5;
const OPENING_MIN_UNDERSIDE_M = 4.5 / 1.6;
// Every tier-c/g bridge, plus the tier-l landmarks that cross water.
const isBridge = (id) => /bridge|ponte/.test(id);
const mulPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const undersideProfile = (document, axis, start, bins) => {
  const low = new Array(bins).fill(Number.POSITIVE_INFINITY);
  const e = [0, 0, 0];
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      for (let i = 0; i + 2 < n; i += 3) {
        let a = Infinity;
        let b = -Infinity;
        let y = Infinity;
        for (let k = 0; k < 3; k += 1) {
          pos.getElement(idx ? idx.getScalar(i + k) : i + k, e);
          const p = mulPoint(world, e);
          const along = p[axis] * ASSET_SCALE;
          a = Math.min(a, along);
          b = Math.max(b, along);
          y = Math.min(y, p[1] * ASSET_SCALE);
        }
        const first = Math.max(0, Math.floor((a - start) / SPAN_STEP_M));
        const last = Math.min(bins - 1, Math.floor((b - start) / SPAN_STEP_M));
        for (let j = first; j <= last; j += 1) if (y < low[j]) low[j] = y;
      }
    }
  }
  return low;
};
const openingsOf = (low, start, step = SPAN_STEP_M, minUnderside = OPENING_MIN_UNDERSIDE_M) => {
  const openings = [];
  let from = -1;
  for (let i = 0; i <= low.length; i += 1) {
    const open = i < low.length && low[i] >= minUnderside;
    if (open && from < 0) from = i;
    if (!open && from >= 0) {
      // No geometry over a bin at all is open sky; cap it at 99 m.
      const underside = Math.min(99, ...low.slice(from, i));
      openings.push({
        centre: round4(start + ((from + i) / 2) * step),
        width: round4((i - from) * step),
        underside: Math.round(underside * 100) / 100,
      });
      from = -1;
    }
  }
  return openings;
};
const spanOf = (document, footprint) => {
  if (!footprint) return null;
  const axis = footprint.extentX >= footprint.extentZ ? 0 : 2;
  const start = axis === 0 ? footprint.minX : footprint.minZ;
  const length = axis === 0 ? footprint.extentX : footprint.extentZ;
  const bins = Math.max(1, Math.ceil(length / SPAN_STEP_M));
  const low = undersideProfile(document, axis, start, bins);
  return {
    axis: axis === 0 ? 'x' : 'z',
    start: round4(start),
    length: round4(length),
    openings: openingsOf(low, start),
  };
};

async function main() {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

  const models = {};
  const spans = {};
  let totalBytes = 0;

  for (const relative of GLB_ROOTS.flatMap(glbsUnder)) {
    const file = path.join(PUBLIC, relative);
    const id = path.basename(relative, '.glb');
    const document = await io.read(file);
    const bytes = fs.statSync(file).size;
    totalBytes += bytes;
    const footprint = footprintOf(document);
    const span = isBridge(id) ? spanOf(document, footprint) : null;
    models[id] = {
      path: relative,
      bytes,
      triangles: trianglesIn(document),
      compressed: document
        .getRoot()
        .listExtensionsUsed()
        .some((extension) => extension.extensionName === 'EXT_meshopt_compression'),
      ...(footprint ? { footprint } : {}),
      ...(span ? { span } : {}),
    };
    if (span) spans[id] = span;
  }

  const manifest = { totalBytes, models };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  // Companion TS module so the sync placement code (toEngineRoute etc.)
  // can look up a model's XZ footprint radius without waiting on a
  // manifest fetch. Regenerated whenever the JSON is — sceneryManifest.test
  // fails if the two drift apart.
  const footprintEntries = Object.entries(models)
    .filter(([, m]) => m.footprint)
    .map(([id, m]) => {
      const f = m.footprint;
      return `  '${id}': { minX: ${f.minX}, maxX: ${f.maxX}, minZ: ${f.minZ}, maxZ: ${f.maxZ}, extentX: ${f.extentX}, extentZ: ${f.extentZ}, radius: ${f.radius}, centreX: ${f.centreX}, centreZ: ${f.centreZ} },`;
    })
    .sort()
    .join('\n');
  const tsSource =
    `// Generated by scripts/generate-scenery-manifest.mjs — do not edit by hand.\n` +
    `//\n` +
    `// Mirrors the \`footprint\` field of each entry in\n` +
    `// \`public/assets/scenery/manifest.json\` so sync placement code can\n` +
    `// look up a model's XZ footprint radius without a runtime fetch (#723).\n` +
    `\n` +
    `import type { SceneryModelFootprint } from '../utils/sceneryManifest';\n` +
    `\n` +
    `export const SCENERY_FOOTPRINTS: Readonly<Record<string, SceneryModelFootprint>> = {\n` +
    `${footprintEntries}\n` +
    `};\n`;
  fs.writeFileSync(FOOTPRINTS_TS_PATH, tsSource);
  // #724 — the bridges' span profiles, for the sync span placement.
  const spanEntries = Object.entries(spans)
    .map(([id, span]) => `  '${id}': ${JSON.stringify(span).replace(/"(\w+)":/g, '$1: ').replace(/"/g, "'").replace(/,/g, ', ')},`)
    .sort()
    .join('\n');
  fs.writeFileSync(
    SPANS_TS_PATH,
    `// Generated by scripts/generate-scenery-manifest.mjs — do not edit by hand.\n` +
      `//\n` +
      `// Mirrors the \`span\` field of each bridge in\n` +
      `// \`public/assets/scenery/manifest.json\` (#724 VP-06), for the sync\n` +
      `// span placement in \`bridgeSpan.ts\`.\n` +
      `\n` +
      `import type { BridgeSpanProfile } from './bridgeSpan';\n` +
      `\n` +
      `export const BRIDGE_SPANS: Readonly<Record<string, BridgeSpanProfile>> = {\n` +
      `${spanEntries}\n` +
      `};\n`,
  );
  console.log(
    `${Object.keys(models).length} models, ${(totalBytes / 1024 / 1024).toFixed(2)} MB -> ${path.relative(ROOT, MANIFEST_PATH)} + ${path.relative(ROOT, FOOTPRINTS_TS_PATH)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
