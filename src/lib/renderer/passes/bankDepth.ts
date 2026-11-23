/**
 * Bank shadow-depth pipeline (#559 FR4). Depth-only; one draw per
 * cascade over the same bank strips the lit `bank` pass draws.
 */

/// <reference types="@webgpu/types" />

import type { RouteCurve } from '../math/curve';
import { buildBankStrips, indexUpload } from '../plan/bankStrip';
import type { WaterFootprint } from '../plan/waterFootprint';
import type { WaterEdges } from '../plan/waterStrip';
import bankDepthWgsl from './bankDepth.wgsl?raw';
import { renderPipelineAsync } from '../engine/pipelineAsync';

export interface BankDepthPipeline {
  pipeline: GPURenderPipeline;
  cascadeLayout: GPUBindGroupLayout;
  positions: GPUBuffer;
  sides: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
  /** #742 — a long route's banks need 32-bit indices. */
  indexFormat: GPUIndexFormat;
  dispose(): void;
}

export interface BankDepthOptions {
  /** Route curve for the strip to follow (must match the lit bank pass). */
  curve?: RouteCurve | null;
  /** Same per-progress shore widths the lit bank pass uses. */
  edgesForProgress?: (progress: number) => WaterEdges;
  /** #742 — the same water footprint the lit bank pass gives way to. */
  footprint?: WaterFootprint | null;
}

export const createBankDepthPipeline = async (
  device: GPUDevice,
  options: BankDepthOptions = {},
): Promise<BankDepthPipeline> => {
  const module = device.createShaderModule({ label: 'bankDepth', code: bankDepthWgsl });
  const cascadeLayout = device.createBindGroupLayout({
    label: 'bankDepth:cascade',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ],
  });
  const pipeline = await renderPipelineAsync(device, {
    label: 'bankDepth',
    layout: device.createPipelineLayout({ bindGroupLayouts: [cascadeLayout] }),
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }] },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth32float' },
  });
  const geom = buildBankStrips({
    curve: options.curve ?? null,
    edgesForProgress: options.edgesForProgress,
    footprint: options.footprint,
  });
  const positions = device.createBuffer({
    label: 'bankDepth-pos',
    size: geom.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(positions, 0, geom.positions as BufferSource);
  const sides = device.createBuffer({
    label: 'bankDepth-side',
    size: geom.sides.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(sides, 0, geom.sides as BufferSource);
  const indices = device.createBuffer({
    label: 'bankDepth-idx',
    size: indexUpload(geom.indices).byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indices, 0, indexUpload(geom.indices) as BufferSource);

  let disposed = false;
  return {
    pipeline,
    cascadeLayout,
    positions,
    sides,
    indices,
    indexCount: geom.indices.length,
    indexFormat: geom.indexFormat,
    dispose() {
      if (disposed) return;
      disposed = true;
      positions.destroy();
      sides.destroy();
      indices.destroy();
    },
  };
};
