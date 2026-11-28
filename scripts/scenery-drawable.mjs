/**
 * #449 FR5 / AC9 — make a scenery GLB drawable by the engine's mesh decoder,
 * which needs every primitive indexed and with a normal.
 *
 * llm-cad writes unindexed triangles with positions only, so every generated
 * model failed to load on the ride. This gives such a primitive per-face
 * normals (each triangle owns its vertices, so CAD edges stay hard), then
 * welds identical vertices into an index buffer, and keeps the file's meshopt
 * compression. A model that is already drawable comes back as the same bytes.
 * `run.mjs` applies it to every GLB it ingests.
 *
 *   node scripts/scenery-drawable.mjs <dir|file.glb> ...   rewrite in place
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { normals, quantize, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GLB_MAGIC = 0x46546c67;

let io;
const sceneryIo = async () => {
  if (!io) {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
    io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  }
  return io;
};

const isGlb = (bytes) =>
  bytes.byteLength >= 20 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === GLB_MAGIC;

/** `bytes` with every primitive indexed and normalled; the same bytes when nothing was missing or it is not a GLB. */
export const ensureDrawable = async (bytes) => {
  if (!isGlb(bytes)) return bytes;
  const glbIo = await sceneryIo();
  const doc = await glbIo.readBinary(bytes);
  const missing = doc
    .getRoot()
    .listMeshes()
    .some((mesh) => mesh.listPrimitives().some((primitive) => !primitive.getAttribute('NORMAL') || !primitive.getIndices()));
  if (!missing) return bytes;
  // Normals before the weld: vertices merge only where position and normal
  // both match, so faces keep their own. Quantised like the rest of the kit.
  await doc.transform(
    normals({ overwrite: false }),
    weld(),
    quantize({ pattern: /^NORMAL$/, quantizeNormal: 8 }),
  );
  return glbIo.writeBinary(doc);
};

const glbsUnder = (target) =>
  fs.statSync(target).isDirectory()
    ? fs.readdirSync(target, { recursive: true }).map((entry) => path.join(target, entry.toString())).filter((f) => f.endsWith('.glb'))
    : [target];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fixed = 0;
  for (const target of process.argv.slice(2)) {
    for (const file of glbsUnder(target)) {
      const bytes = new Uint8Array(fs.readFileSync(file));
      const out = await ensureDrawable(bytes);
      if (out !== bytes) {
        fs.writeFileSync(file, out);
        fixed += 1;
        console.log(`made drawable: ${file}`);
      }
    }
  }
  console.log(`${fixed} GLB(s) made drawable`);
}
