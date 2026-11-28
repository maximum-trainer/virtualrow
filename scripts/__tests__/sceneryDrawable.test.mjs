// @vitest-environment node
/**
 * #449 FR5 / AC9 — a generated model reaches the kit indexed and with vertex
 * normals, which the engine's mesh decoder requires.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { ensureDrawable } from '../scenery-drawable.mjs';

const io = new NodeIO();

/** One triangle, positions only, as llm-cad writes them. */
const triangleGlb = async ({ withNormals = false, indexed = false } = {}) => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const primitive = doc.createPrimitive().setAttribute('POSITION', position);
  if (withNormals) {
    primitive.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0])));
  }
  if (indexed) primitive.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 1, 2])));
  doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive));
  return io.writeBinary(doc);
};

describe('ensureDrawable', () => {
  it('indexes a primitive that has only positions and gives it a normal facing out of the triangle', async () => {
    const out = await ensureDrawable(await triangleGlb());
    const primitive = (await io.readBinary(out)).getRoot().listMeshes()[0].listPrimitives()[0];
    expect(primitive.getIndices()?.getCount()).toBe(3);
    const normal = primitive.getAttribute('NORMAL');
    expect(normal).not.toBeNull();
    expect(normal.getCount()).toBe(3);
    // The triangle lies in y = 0; its normal is ±y.
    expect(Math.abs(normal.getElement(0, [])[1])).toBeCloseTo(1, 5);
  });

  it('returns an indexed model that already has normals unchanged', async () => {
    const glb = await triangleGlb({ withNormals: true, indexed: true });
    expect(await ensureDrawable(glb)).toBe(glb);
  });

  it('passes bytes that are not a GLB straight through', async () => {
    const notGlb = new Uint8Array([1, 2, 3, 4]);
    expect(await ensureDrawable(notGlb)).toBe(notGlb);
  });
});
