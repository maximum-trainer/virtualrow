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

async function main() {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

  const models = {};
  let totalBytes = 0;

  for (const relative of GLB_ROOTS.flatMap(glbsUnder)) {
    const file = path.join(PUBLIC, relative);
    const id = path.basename(relative, '.glb');
    const document = await io.read(file);
    const bytes = fs.statSync(file).size;
    totalBytes += bytes;
    const footprint = footprintOf(document);
    models[id] = {
      path: relative,
      bytes,
      triangles: trianglesIn(document),
      compressed: document
        .getRoot()
        .listExtensionsUsed()
        .some((extension) => extension.extensionName === 'EXT_meshopt_compression'),
      ...(footprint ? { footprint } : {}),
    };
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
  console.log(
    `${Object.keys(models).length} models, ${(totalBytes / 1024 / 1024).toFixed(2)} MB -> ${path.relative(ROOT, MANIFEST_PATH)} + ${path.relative(ROOT, FOOTPRINTS_TS_PATH)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
