/// <reference types="@webgpu/types" />

import type { FrameContext, Pass } from '../engine/frameGraph';
import { buildWaterDebugMesh, type WaterDebugInput } from '../plan/waterDebugLines';
import waterDebugWgsl from './waterDebug.wgsl?raw';

/**
 * Water-detection diagnostics pass (#493 Phase 3d / FR22 / AC23).
 *
 * Draws line-list segments for the detected shoreline, island outlines
 * and on-land route samples, so the debug overlay — toggled from
 * `DebugPanel.svelte` — can show what the detection pipeline sees. The
 * pass runs only when `__VIRTUALROW_WATER_DEBUG === true`; without the
 * flag the whole pass is skipped at the frame-graph level.
 *
 * No shadow / fog bindings — the overlay deliberately pops against the
 * water. One vertex buffer with interleaved position + colour, same
 * layout `buildWaterDebugMesh` emits.
 */
export interface WaterDebugPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameUniforms: GPUBuffer;
  /** The shoreline / islands / on-land markers to draw. */
  input: WaterDebugInput;
}

export const createWaterDebugPass = ({
  device,
  format,
  frameUniforms,
  input,
}: WaterDebugPassOptions): Pass | null => {
  const mesh = buildWaterDebugMesh(input);
  if (mesh.vertexCount === 0) return null;

  const module = device.createShaderModule({ label: 'water-debug', code: waterDebugWgsl });
  const pipeline = device.createRenderPipeline({
    label: 'water-debug',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'line-list', cullMode: 'none' },
    depthStencil: {
      // Line draws write depth so later passes don't blend oddly over
      // the markers; `less` keeps them hidden by anything closer.
      depthWriteEnabled: false,
      depthCompare: 'less',
      format: 'depth32float',
    },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: frameUniforms } }],
  });

  const vertexBuffer = device.createBuffer({
    label: 'water-debug-pos',
    size: mesh.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices as BufferSource);

  let disposed = false;
  return {
    name: 'water-debug',
    encode(ctx: FrameContext) {
      if (disposed) return;
      const pass = ctx.encoder.beginRenderPass({
        label: 'water-debug',
        colorAttachments: [{ view: ctx.swapView, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: ctx.depthView,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.draw(mesh.vertexCount);
      pass.end();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      vertexBuffer.destroy();
    },
  };
};
