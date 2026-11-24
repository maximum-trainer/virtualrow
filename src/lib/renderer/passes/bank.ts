/// <reference types="@webgpu/types" />

import type { FrameContext, Pass } from '../engine/frameGraph';
import type { RouteCurve } from '../math/curve';
import {
  HORIZON_BLEND,
  HORIZON_HAZE_WGSL,
  SKY_COLOUR_WGSL,
  AERIAL_FOG_WGSL,
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
import { BANK_BIOME_WEIGHTS, bankBiomeWgsl, writeBiomeWeights } from '../plan/bankBiome';
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
  /**
   * #725 FR5 — each bank's scenery profile along the route, for its ground
   * cover. Omitted → the 'fallback' look (a patchwork of fields) everywhere.
   */
  profileForProgress?: (progress: number, side: 'left' | 'right') => SceneryProfile;
}

export interface BankPass extends Pass {
  /**
   * #725 FR5 — the ground plane beyond the strips takes the biome mix at the
   * boat (both banks, blended over ±{@link GROUND_BIOME_BLEND_METRES}), so it
   * changes with the bands as the boat rows through them. Call per frame;
   * writes the uniform only when the mix changes.
   */
  setBoatProgress(progress: number): void;
}

/** Metres of route either side of the boat the ground plane's biome mix averages over. */
export const GROUND_BIOME_BLEND_METRES = 150;
/** Byte offset of `groundBiome` in the bank's `Grass` uniform. */
export const GROUND_BIOME_OFFSET = 32;
const GRASS_UNIFORM_BYTES = 64;

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
  profileForProgress,
}: BankPassOptions): Promise<BankPass> => {
  // #725 FR6 — the shared aerial fog, in the sky's horizon colour.
  const code = SHADOW_UNIFORMS_WGSL + SAMPLE_SHADOW_WGSL + HORIZON_HAZE_WGSL + SKY_COLOUR_WGSL + AERIAL_FOG_WGSL
    + bankBiomeWgsl() + bankWgsl;
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
        {
          // #725 FR5: biome weights (fields, scrub, green, marsh) + woodland.
          arrayStride: BANK_BIOME_WEIGHTS * 4,
          attributes: [
            { shaderLocation: 2, offset: 0, format: 'float32x4' },
            { shaderLocation: 3, offset: 16, format: 'float32' },
          ],
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
    size: GRASS_UNIFORM_BYTES,
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

  const profileAt = profileForProgress ?? ((): SceneryProfile => 'fallback');
  const geom = buildBankStrips({ curve, edgesForProgress, footprint, landSide, profileForProgress: profileAt });
  const biomes = geom.biomes!;
  const biomeBuffer = device.createBuffer({
    label: 'bank-biome',
    size: biomes.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(biomeBuffer, 0, biomes as BufferSource);

  // The ground plane's mix, at the boat: both banks, over a wider stretch
  // than the strips so it turns over gently as the boat enters a band.
  const routeMetres = curve && curve.length >= 2 ? curve.approximateLength(64) : 400;
  const groundWindow = GROUND_BIOME_BLEND_METRES / Math.max(1, routeMetres);
  const leftAt = (t: number) => profileAt(t, 'left');
  const rightAt = (t: number) => profileAt(t, 'right');
  const sideMix = new Float32Array(BANK_BIOME_WEIGHTS * 2);
  const groundMix = new Float32Array(BANK_BIOME_WEIGHTS);
  let groundWritten = false;
  const setBoatProgress = (progress: number): void => {
    const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    writeBiomeWeights(leftAt, p, groundWindow, sideMix, 0);
    writeBiomeWeights(rightAt, p, groundWindow, sideMix, BANK_BIOME_WEIGHTS);
    let changed = !groundWritten;
    for (let k = 0; k < BANK_BIOME_WEIGHTS; k++) {
      const w = landSide === 'left' ? sideMix[k] : landSide === 'right' ? sideMix[BANK_BIOME_WEIGHTS + k]
        : (sideMix[k] + sideMix[BANK_BIOME_WEIGHTS + k]) / 2;
      if (w !== groundMix[k]) changed = true;
      groundMix[k] = w;
    }
    if (!changed) return;
    groundWritten = true;
    device.queue.writeBuffer(grassUniforms, GROUND_BIOME_OFFSET, groundMix as BufferSource);
  };
  setBoatProgress(0);
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
    setBoatProgress,
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
      pass.setVertexBuffer(2, biomeBuffer);
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
      biomeBuffer.destroy();
      indexBuffer.destroy();
      grassTexture.destroy();
      grassUniforms.destroy();
      bankAtlasTexture.destroy();
    },
  };
};
