#!/usr/bin/env node
/**
 * Emit an LOD1 beside every heavy scenery model (#727 VP-09 FR4).
 *
 * A model above `LOD_MIN_TRIANGLES` gets `<id>.lod1.glb` next to it with at
 * most `LOD_MAX_SHARE` of its triangles, which the engine draws for
 * instances beyond 120 m. Built from the shipped (already compressed) GLB:
 * the kit's source of truth is `scripts/build_scenery.py`, and LOD0 is what
 * the rower sees up close, so LOD1 only has to look like LOD0 from afar.
 *
 *   node scripts/build-scenery-lod.mjs [--dry-run]
 *
 * Simplification is tried at a rising error until the triangle share is met
 * with the bounding box held within 2%; a model that cannot get there keeps
 * no LOD1 (the engine then draws LOD0 at every distance) and is named in the
 * output. Boats are left alone: they are only ever seen close.
 */
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, meshopt, prune, quantize, simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENERY = path.join(ROOT, 'public', 'assets', 'scenery');

/** Models above this many triangles get an LOD1 (#727 FR4). */
export const LOD_MIN_TRIANGLES = 1500;
/** LOD1 keeps at most this share of LOD0's triangles. */
export const LOD_MAX_SHARE = 0.35;
/** Bounding box movement LOD1 may show, as a share of the largest extent. */
const BOUNDS_TOLERANCE = 0.02;
/** Simplifier error bounds tried in turn, smallest first. */
const ERRORS = [0.01, 0.03, 0.06, 0.1];
const LOD_SUFFIX = '.lod1.glb';

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

const boxOf = (document) => {
  const { min, max } = getBounds(document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]);
  return [...min, ...max];
};

const boxDrift = (before, after) => {
  const span = Math.max(...[0, 1, 2].map((axis) => Math.abs(before[axis + 3] - before[axis])), 1e-6);
  return Math.max(...before.map((value, i) => Math.abs(value - after[i]) / span));
};

const modelsUnder = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, entry.toString()))
    .filter((file) => file.endsWith('.glb') && !file.endsWith(LOD_SUFFIX))
    .sort();

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

  const kept = [];
  const declined = [];
  for (const file of modelsUnder(SCENERY)) {
    const id = path.basename(file, '.glb');
    const lodFile = file.replace(/\.glb$/, LOD_SUFFIX);
    const source = await io.read(file);
    const triangles = trianglesIn(source);
    if (triangles <= LOD_MIN_TRIANGLES) {
      if (fs.existsSync(lodFile) && !dryRun) fs.rmSync(lodFile);
      continue;
    }
    const bounds = boxOf(source);

    let made = null;
    for (const error of ERRORS) {
      const document = await io.read(file);
      await document.transform(
        dequantize(),
        weld(),
        simplify({ simplifier: MeshoptSimplifier, ratio: LOD_MAX_SHARE * 0.9, error }),
        prune(),
      );
      const share = trianglesIn(document) / triangles;
      const drift = boxDrift(bounds, boxOf(document));
      if (share <= LOD_MAX_SHARE && drift <= BOUNDS_TOLERANCE) {
        made = { document, share, drift, error };
        break;
      }
    }
    if (!made) {
      declined.push(id);
      if (fs.existsSync(lodFile) && !dryRun) fs.rmSync(lodFile);
      continue;
    }
    await made.document.transform(quantize(), meshopt({ encoder: MeshoptEncoder }));
    const bytes = await io.writeBinary(made.document);
    if (!dryRun) fs.writeFileSync(lodFile, bytes);
    kept.push(id);
    console.log(
      `${id.padEnd(34)} ${String(triangles).padStart(6)} -> ${String(trianglesIn(made.document)).padStart(6)} tris (${(made.share * 100).toFixed(0)}%, error ${made.error}, drift ${(made.drift * 100).toFixed(1)}%)  ${bytes.byteLength} B`,
    );
  }
  console.log(`\n${kept.length} LOD1 models written.${declined.length ? ` No LOD1 for: ${declined.join(', ')}` : ''}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
