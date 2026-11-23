/**
 * #731 VP-13 FR3 — 4x MSAA on the scene colour and depth at medium and up.
 *
 * Every lit scene pass (sky, clouds, bank, buildings, flora, water, boat,
 * kit models, particles, rain) renders into the frame's `swapView` /
 * `depthView`. With MSAA those are 4-sample targets, so every one of their
 * pipelines has to be built with the same `multisample.count`: the engine
 * records the count per device here once, before any pass is created, and
 * each scene pipeline reads it through `sceneMultisample(device)`.
 *
 * Post-FX reads single-sample textures, so a resolve pass runs after the last
 * scene pass and before post-FX: the colour resolves into the HDR scene
 * texture through a render-pass `resolveTarget`, and the depth (which WebGPU
 * cannot resolve) is copied from sample 0 into the single-sample depth
 * texture with a full-screen draw that writes `frag_depth`. SSAO and DOF then
 * read that resolved depth.
 */

/// <reference types="@webgpu/types" />

import type { FrameContext, Pass } from './frameGraph';
import { renderPipelineAsync } from './pipelineAsync';

export type AntialiasMode = 'msaa' | 'fxaa' | 'none';

/** The scene's sample count for an anti-aliasing mode. */
export const sceneSampleCountFor = (mode: AntialiasMode): 1 | 4 => (mode === 'msaa' ? 4 : 1);

const sampleCounts = new WeakMap<GPUDevice, number>();

/** Record the scene sample count for a device. Call before creating any scene pass. */
export const setSceneSampleCount = (device: GPUDevice, count: number): void => {
  sampleCounts.set(device, count);
};

/** The multisample state every scene pipeline on this device is built with. */
export const sceneMultisample = (device: GPUDevice): GPUMultisampleState => ({
  count: sampleCounts.get(device) ?? 1,
});

export const DEPTH_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var msDepth: texture_depth_multisampled_2d;

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  // One triangle that covers the screen.
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
  return textureLoad(msDepth, vec2<i32>(p.xy), 0);
}
`;

export interface MsaaResolveTargets {
  /** The single-sample HDR texture post-FX reads. */
  sceneView: GPUTextureView;
  /** The 4-sample depth texture the scene passes wrote. */
  msaaDepthTexture: GPUTexture;
  /** The single-sample depth post-FX (SSAO, DOF) reads. */
  depthView: GPUTextureView;
}

export interface MsaaResolvePass extends Pass {
  setTargets(targets: MsaaResolveTargets): void;
}

/**
 * The pass that resolves the 4-sample scene into the single-sample HDR and
 * depth textures. It reads the 4-sample targets from the frame context
 * (`swapView` / `depthView`), and writes the targets given to `setTargets`.
 */
export const createMsaaResolvePass = async (device: GPUDevice): Promise<MsaaResolvePass> => {
  const module = device.createShaderModule({ label: 'msaa-depth-resolve', code: DEPTH_RESOLVE_WGSL });
  const pipeline = await renderPipelineAsync(device, {
    label: 'msaa-depth-resolve',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  });
  let targets: MsaaResolveTargets | null = null;
  let bindGroup: GPUBindGroup | null = null;
  let disposed = false;
  return {
    name: 'msaa-resolve',
    setTargets(next) {
      targets = next;
      bindGroup = device.createBindGroup({
        label: 'msaa-depth-resolve',
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: next.msaaDepthTexture.createView() }],
      });
    },
    encode(ctx: FrameContext) {
      if (disposed || !targets || !bindGroup) return;
      const colour = ctx.encoder.beginRenderPass({
        label: 'msaa-colour-resolve',
        colorAttachments: [{ view: ctx.swapView, resolveTarget: targets.sceneView, loadOp: 'load', storeOp: 'discard' }],
      });
      colour.end();
      const depth = ctx.encoder.beginRenderPass({
        label: 'msaa-depth-resolve',
        colorAttachments: [],
        depthStencilAttachment: {
          view: targets.depthView,
          depthLoadOp: 'clear',
          depthClearValue: 1,
          depthStoreOp: 'store',
        },
      });
      depth.setPipeline(pipeline);
      depth.setBindGroup(0, bindGroup);
      depth.draw(3);
      depth.end();
    },
    dispose() {
      disposed = true;
    },
  };
};
