/// <reference types="@webgpu/types" />

import type { FrameContext, Pass } from '../engine/frameGraph';
import type { RouteCurve } from '../math/curve';
import {
  HORIZON_BLEND,
  HORIZON_HAZE_WGSL,
  SAMPLE_SHADOW_WGSL,
  SHADOW_UNIFORMS_WGSL,
} from '../engine/shaderSnippets';
import { buildGroundPlane } from '../plan/groundPlane';
import { buildBankStrips, indexUpload } from '../plan/bankStrip';
import type { WaterFootprint } from '../plan/waterFootprint';
import type { WaterEdges } from '../plan/waterStrip';
import { paintBiomeDensityR8 } from '../../scenery/biomeDensity';
import { BANK_ATLAS_SIZE, paintBankAtlas } from '../../scenery/bankAtlas';
import type { SceneryProfile } from '../../services/routeEnrichmentService';
import bankWgsl from './bank.wgsl?raw';
import { renderPipelineAsync } from '../engine/pipelineAsync';
import { sceneMultisample } from '../engine/msaa';

export interface ShadowResources {
  uniforms: GPUBuffer;
  atlasView: GPUTextureView;
  cmpSampler: GPUSampler;
}

/** The biome whose density tile drives the bank's grass modulation (#496). */
export interface BankGrassConfig {
  profile: SceneryProfile;
  /** 0 disables the chunk at the shader level; 1 is React's full strength. */
  strength: number;
  /** Plan-view metres covered by one wrap of the tile. React uses 32. */
  tileMetres?: number;
  /** Density tile edge in texels; 256 matches `createBiomeDensityTile`'s default. */
  tileSize?: number;
}

export interface BankPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameUniforms: GPUBuffer;
  /** #730 VP-12 — the conditions lighting block (`packFrameLighting`). */
  lightingUniforms: GPUBuffer;
  shadow: ShadowResources;
  /** Route curve the bank follows. Null → straight-line fallback. */
  curve?: RouteCurve | null;
  /** Same per-progress shore widths the water pass uses. */
  edgesForProgress?: (progress: number) => WaterEdges;
  /** Biome-density grass modulation. Omitted → chunk off (strength 0, fallback tile). */
  grass?: BankGrassConfig;
  /** #755 FR4 — land on this side only (a coastal course). Omitted → both. */
  landSide?: 'left' | 'right';
  /** #742 — the water the bank gives way to (default: the route's own ribbon). */
  footprint?: WaterFootprint | null;
}

const srgbToLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/**
 * Mean colour of the grass (left) half of the bank atlas, in linear space,
 * which is what the `-srgb` texture format hands the shader.
 */
export const meanLinearGrass = (pixels: Uint8Array): [number, number, number] => {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < BANK_ATLAS_SIZE; y++) {
    for (let x = 0; x < BANK_ATLAS_SIZE / 2; x++) {
      const i = (y * BANK_ATLAS_SIZE + x) * 4;
      r += srgbToLinear(pixels[i]); g += srgbToLinear(pixels[i + 1]); b += srgbToLinear(pixels[i + 2]);
      n++;
    }
  }
  return [r / n, g / n, b / n];
};

export const createBankPass = async ({
  device,
  format,
  frameUniforms,
  lightingUniforms,
  shadow,
  curve = null,
  edgesForProgress,
  grass,
  footprint,
  landSide,
}: BankPassOptions): Promise<Pass> => {
  const code = SHADOW_UNIFORMS_WGSL + SAMPLE_SHADOW_WGSL + HORIZON_HAZE_WGSL + bankWgsl;
  const module = device.createShaderModule({ label: 'bank', code });
  const pipeline = await renderPipelineAsync(device, {
    multisample: sceneMultisample(device),
    label: 'bank',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
        {
          // #591-fu P0b: 2 floats per vertex, (sign, shoreDist). The sign
          // kept its old ±1 meaning (left vs right strip); shoreDist is
          // metres from the water edge for the triplanar grass/earth mix.
          arrayStride: 8,
          attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format, blend: HORIZON_BLEND }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: 'less',
      format: 'depth32float',
    },
  });
  // The land beyond the strips (`plan/groundPlane.ts`). Same shader module
  // and the same three bind groups, so its colour matches the strips where
  // they meet. No depth write and no depth test: it is drawn first, straight
  // over the sky, and everything else draws over it. That rules out
  // z-fighting with the water 0.1 m below it at any distance.
  const groundPipeline = await renderPipelineAsync(device, {
    multisample: sceneMultisample(device),
    label: 'bank-ground',
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_ground',
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
      ],
    },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format, blend: HORIZON_BLEND }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
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
  const shadowBindGroup = device.createBindGroup({
    label: 'bank-shadow',
    layout: pipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: { buffer: shadow.uniforms } },
      { binding: 1, resource: shadow.atlasView },
      { binding: 2, resource: shadow.cmpSampler },
    ],
  });

  // Grass density chunk resources (#496 Phase 2). The texture + sampler are
  // mounted even when `strength === 0` so the pipeline+bind-group graph
  // stays identical regardless of tier: a toggle only needs to rewrite the
  // uniform. The tile is `r8unorm` because the shader reads only `.r`,
  // which is 4× cheaper to upload than RGBA.
  const grassProfile: SceneryProfile = grass?.profile ?? 'fallback';
  const grassStrength = Math.max(0, Math.min(1, grass?.strength ?? 0));
  const grassTileMetres = grass?.tileMetres ?? 32;
  const grassTileSize = grass?.tileSize ?? 256;
  const grassPixels = paintBiomeDensityR8(grassProfile, grassTileSize);
  const grassTexture = device.createTexture({
    label: `bank-grass-tile:${grassProfile}`,
    size: { width: grassTileSize, height: grassTileSize },
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: grassTexture },
    grassPixels as BufferSource,
    { bytesPerRow: grassTileSize, rowsPerImage: grassTileSize },
    { width: grassTileSize, height: grassTileSize },
  );
  const grassSampler = device.createSampler({
    label: 'bank-grass-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  const grassUniforms = device.createBuffer({
    label: 'bank-grass-uniforms',
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // #591-fu P0b: shared grass+earth albedo atlas (left half grass, right
  // half earth). One tile per pass, `rgba8unorm-srgb`. Sampled twice in the
  // fragment and mixed by shore distance.
  const bankAtlasPixels = paintBankAtlas();
  // strength, tileMetres, pad, pad, then the grass half's linear-space mean
  // (the far ground's stand-in for the tile, which has no mips).
  const grassMean = meanLinearGrass(bankAtlasPixels);
  device.queue.writeBuffer(
    grassUniforms,
    0,
    new Float32Array([grassStrength, grassTileMetres, 0, 0, grassMean[0], grassMean[1], grassMean[2], 0]),
  );
  const bankAtlasTexture = device.createTexture({
    label: 'bank-atlas',
    size: { width: BANK_ATLAS_SIZE, height: BANK_ATLAS_SIZE },
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: bankAtlasTexture },
    bankAtlasPixels as BufferSource,
    { bytesPerRow: BANK_ATLAS_SIZE * 4, rowsPerImage: BANK_ATLAS_SIZE },
    { width: BANK_ATLAS_SIZE, height: BANK_ATLAS_SIZE },
  );
  const bankAtlasSampler = device.createSampler({
    label: 'bank-atlas-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  const grassBindGroup = device.createBindGroup({
    label: 'bank-grass',
    layout: pipeline.getBindGroupLayout(2),
    entries: [
      { binding: 0, resource: { buffer: grassUniforms } },
      { binding: 1, resource: grassTexture.createView() },
      { binding: 2, resource: grassSampler },
      { binding: 3, resource: bankAtlasTexture.createView() },
      { binding: 4, resource: bankAtlasSampler },
    ],
  });

  const ground = buildGroundPlane();
  const groundPositionBuffer = device.createBuffer({
    label: 'bank-ground-pos',
    size: ground.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(groundPositionBuffer, 0, ground.positions as BufferSource);
  const groundIndexBuffer = device.createBuffer({
    label: 'bank-ground-idx',
    // Index buffers are sized in multiples of 4 bytes.
    size: Math.ceil(ground.indices.byteLength / 4) * 4,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(groundIndexBuffer, 0, ground.indices as BufferSource);
  // `layout: 'auto'` gives each pipeline its own layouts, so the ground
  // pipeline needs bind groups made from its own.
  const groundBindGroup = device.createBindGroup({
    layout: groundPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUniforms } },
      { binding: 1, resource: { buffer: lightingUniforms } },
    ],
  });
  const groundShadowBindGroup = device.createBindGroup({
    label: 'bank-ground-shadow',
    layout: groundPipeline.getBindGroupLayout(1),
    entries: [
      { binding: 0, resource: { buffer: shadow.uniforms } },
      { binding: 1, resource: shadow.atlasView },
      { binding: 2, resource: shadow.cmpSampler },
    ],
  });
  const groundGrassBindGroup = device.createBindGroup({
    label: 'bank-ground-grass',
    layout: groundPipeline.getBindGroupLayout(2),
    entries: [
      { binding: 0, resource: { buffer: grassUniforms } },
      { binding: 1, resource: grassTexture.createView() },
      { binding: 2, resource: grassSampler },
      { binding: 3, resource: bankAtlasTexture.createView() },
      { binding: 4, resource: bankAtlasSampler },
    ],
  });

  const geom = buildBankStrips({ curve, edgesForProgress, footprint, landSide });
  const positionBuffer = device.createBuffer({
    label: 'bank-pos',
    size: geom.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(positionBuffer, 0, geom.positions as BufferSource);
  const sideBuffer = device.createBuffer({
    label: 'bank-side',
    size: geom.sides.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(sideBuffer, 0, geom.sides as BufferSource);
  const indexBuffer = device.createBuffer({
    label: 'bank-idx',
    size: indexUpload(geom.indices).byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indexUpload(geom.indices) as BufferSource);

  let disposed = false;
  return {
    name: 'bank',
    encode(ctx: FrameContext) {
      if (disposed) return;
      const pass = ctx.encoder.beginRenderPass({
        label: 'bank',
        colorAttachments: [
          {
            view: ctx.swapView,
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: ctx.depthView,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(groundPipeline);
      pass.setBindGroup(0, groundBindGroup);
      pass.setBindGroup(1, groundShadowBindGroup);
      pass.setBindGroup(2, groundGrassBindGroup);
      pass.setVertexBuffer(0, groundPositionBuffer);
      pass.setIndexBuffer(groundIndexBuffer, 'uint16');
      pass.drawIndexed(ground.indices.length);

      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setBindGroup(1, shadowBindGroup);
      pass.setBindGroup(2, grassBindGroup);
      pass.setVertexBuffer(0, positionBuffer);
      pass.setVertexBuffer(1, sideBuffer);
      pass.setIndexBuffer(indexBuffer, geom.indexFormat);
      pass.drawIndexed(geom.indices.length);
      pass.end();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      positionBuffer.destroy();
      groundPositionBuffer.destroy();
      groundIndexBuffer.destroy();
      sideBuffer.destroy();
      indexBuffer.destroy();
      grassTexture.destroy();
      grassUniforms.destroy();
      bankAtlasTexture.destroy();
    },
  };
};
