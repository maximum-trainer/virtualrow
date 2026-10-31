/// <reference types="@webgpu/types" />

import type { FrameContext, Pass } from '../engine/frameGraph';
import { SAMPLE_SHADOW_WGSL, SHADOW_UNIFORMS_WGSL } from '../engine/shaderSnippets';
import {
  buildPolygonWater,
  clipPolygonToDisc,
  type PolygonWithHoles,
  type Vec2XZ,
} from '../plan/waterPolygon';
import waterWgsl from './water.wgsl?raw';

import type { ShadowResources } from './bank';

/**
 * Polygon-water pass (#493 Phase 3b / FR4). Draws the OSM polygon water
 * at `WATER_SURFACE_Y` using the same vertex / fragment program as the
 * swept-ribbon water pass (`water.wgsl`), so colour, waves and shadow
 * receive are identical — only the geometry differs.
 *
 * Takes a projected set of polygon-with-holes in **scene XZ** (metres);
 * the engine's rideScene handles the lat/lng → local-frame projection
 * before constructing this pass. Each polygon is clipped against a
 * view-radius disc centred on the follow boat (FR7 / D8c) and then
 * ear-clipped into triangles. The clip + tessellation runs at
 * construction time; a Phase 3b follow-up will rebuild the geometry
 * each frame as the disc centre moves.
 */
export interface WaterPolygonPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameUniforms: GPUBuffer;
  shadow: ShadowResources;
  /** Polygons in scene XZ, already projected and tier-simplified. */
  polygons: PolygonWithHoles[];
  /** Centre of the view-radius disc in scene XZ. Defaults to origin. */
  discCentre?: Vec2XZ;
  /** View-radius for the disc clip; use `DEFAULT_MAX_DISTANCE` or similar. */
  discRadius?: number;
}

/** Join every polygon's tessellated mesh into one position / index buffer. */
function tessellateAll(
  polygons: PolygonWithHoles[],
  discCentre?: Vec2XZ,
  discRadius?: number,
): { positions: Float32Array; indices: Uint32Array; triangleCount: number } {
  const positionChunks: Float32Array[] = [];
  const indexChunks: Uint32Array[] = [];
  let vertexOffset = 0;
  let triangleCount = 0;

  for (const polygon of polygons) {
    let outer = polygon.outer;
    let holes = polygon.holes;
    if (discCentre && discRadius !== undefined && discRadius > 0) {
      outer = clipPolygonToDisc(outer, discCentre.x, discCentre.z, discRadius);
      // Only keep holes whose ring is still (fully) inside the clipped
      // outer — a half-clipped hole lies outside and no longer bounds a
      // land-in-water area.
      holes = holes
        .map((h) => clipPolygonToDisc(h, discCentre.x, discCentre.z, discRadius))
        .filter((h) => h.length >= 3);
    }
    if (outer.length < 3) continue;

    const mesh = buildPolygonWater({ outer, holes });
    if (mesh.indices.length === 0) continue;

    positionChunks.push(mesh.positions);
    const offsetIndices = new Uint32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i++) {
      offsetIndices[i] = mesh.indices[i] + vertexOffset;
    }
    indexChunks.push(offsetIndices);
    vertexOffset += mesh.positions.length / 3;
    triangleCount += mesh.indices.length / 3;
  }

  const totalPositions = positionChunks.reduce((n, c) => n + c.length, 0);
  const totalIndices = indexChunks.reduce((n, c) => n + c.length, 0);
  const positions = new Float32Array(totalPositions);
  const indices = new Uint32Array(totalIndices);
  let p = 0;
  let idx = 0;
  for (const c of positionChunks) {
    positions.set(c, p);
    p += c.length;
  }
  for (const c of indexChunks) {
    indices.set(c, idx);
    idx += c.length;
  }
  return { positions, indices, triangleCount };
}

export const createWaterPolygonPass = ({
  device,
  format,
  frameUniforms,
  shadow,
  polygons,
  discCentre,
  discRadius,
}: WaterPolygonPassOptions): Pass | null => {
  const mesh = tessellateAll(polygons, discCentre, discRadius);
  if (mesh.indices.length === 0) return null;

  const code = SHADOW_UNIFORMS_WGSL + SAMPLE_SHADOW_WGSL + waterWgsl;
  const module = device.createShaderModule({ label: 'water-polygon', code });
  const pipeline = device.createRenderPipeline({
    label: 'water-polygon',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: 'depth32float',
    },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: frameUniforms } }],
  });
  const shadowBindGroup = device.createBindGroup({
    label: 'water-polygon-shadow',
    layout: pipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: { buffer: shadow.uniforms } },
      { binding: 1, resource: shadow.atlasView },
      { binding: 2, resource: shadow.cmpSampler },
    ],
  });

  const positionBuffer = device.createBuffer({
    label: 'water-polygon-pos',
    size: mesh.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(positionBuffer, 0, mesh.positions as BufferSource);
  const indexBuffer = device.createBuffer({
    label: 'water-polygon-idx',
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, mesh.indices as BufferSource);

  let disposed = false;
  return {
    name: 'water-polygon',
    encode(ctx: FrameContext) {
      if (disposed) return;
      const pass = ctx.encoder.beginRenderPass({
        label: 'water-polygon',
        colorAttachments: [{ view: ctx.swapView, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: ctx.depthView,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setBindGroup(1, shadowBindGroup);
      pass.setVertexBuffer(0, positionBuffer);
      pass.setIndexBuffer(indexBuffer, 'uint32');
      pass.drawIndexed(mesh.indices.length);
      pass.end();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      positionBuffer.destroy();
      indexBuffer.destroy();
    },
  };
};
