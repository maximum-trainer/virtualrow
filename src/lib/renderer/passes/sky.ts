/// <reference types="@webgpu/types" />

import type { FrameContext, Pass } from '../engine/frameGraph';
import skyWgsl from './sky.wgsl?raw';
import { renderPipelineAsync } from '../engine/pipelineAsync';
import { SKY_COLOUR_WGSL } from '../engine/shaderSnippets';

export interface SkyPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameUniforms: GPUBuffer;
  /** #730 VP-12 — the conditions lighting block (`packFrameLighting`). */
  lightingUniforms: GPUBuffer;
}

export const createSkyPass = async ({ device, format, frameUniforms, lightingUniforms }: SkyPassOptions): Promise<Pass> => {
  const module = device.createShaderModule({ label: 'sky', code: SKY_COLOUR_WGSL + skyWgsl });
  const pipeline = await renderPipelineAsync(device, {
    label: 'sky',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
    // The sky clears depth; subsequent passes compare against it.
    depthStencil: {
      depthWriteEnabled: false,
      depthCompare: 'always',
      format: 'depth32float',
    },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUniforms } },
      { binding: 1, resource: { buffer: lightingUniforms } },
    ],
  });

  let disposed = false;
  return {
    name: 'sky',
    encode(ctx: FrameContext) {
      if (disposed) return;
      const pass = ctx.encoder.beginRenderPass({
        label: 'sky',
        colorAttachments: [
          {
            view: ctx.swapView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0.78, g: 0.86, b: 0.95, a: 1 },
          },
        ],
        depthStencilAttachment: {
          view: ctx.depthView,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1.0,
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3, 1, 0, 0);
      pass.end();
      ctx.colorCleared = true;
      ctx.depthCleared = true;
    },
    dispose() {
      disposed = true;
    },
  };
};
