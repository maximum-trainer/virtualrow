/// <reference types="@webgpu/types" />

/**
 * Instanced static-mesh scenery pass. Owns a registry of GLB-loaded meshes
 * and draws each one as `instances[i]` × its baked local-space vertices.
 * One pipeline, one bind group layout; each registered mesh gets its own
 * per-mesh bind group (base colour uniform + instance storage buffer) and
 * its own vertex + index buffers. Follows the `boat.ts` static-mesh pattern.
 */

import type { FrameContext, Pass } from '../engine/frameGraph';
import type { Mat4 } from '../math/mat4';
import sceneryMeshWgsl from './sceneryMesh.wgsl?raw';
import { ALWAYS_REVEALED, packRevealUniform, SCENERY_REVEAL_UNIFORM_BYTES } from './sceneryReveal';
import { renderPipelineAsync } from '../engine/pipelineAsync';

/**
 * One instance record: a mat4 model, a tint vec4 and an effect vec4
 * (#728 VP-10, #713 D3a), 24 floats = 96 B. Mirrors `SceneryInstance`
 * in `sceneryMesh.wgsl` and `sceneryMeshDepth.wgsl`.
 */
export const SCENERY_INSTANCE_BYTES = 96;
const FLOATS_PER_INSTANCE = SCENERY_INSTANCE_BYTES / 4;

/**
 * How one instance of a mesh is drawn, beyond its transform (#728 FR2,
 * #713 D3a). Every field defaults to "as authored": no tint, opaque, no
 * rim, sun-shaded.
 */
export interface SceneryInstanceStyle {
  readonly model: Mat4;
  /** rgb, and how far (0..1) the authored colour moves towards it. */
  readonly tint?: readonly [number, number, number, number];
  /** Below 1 the instance is drawn in the translucent pass, after every opaque one. */
  readonly alpha?: number;
  /** Strength of a fresnel rim highlight. */
  readonly rim?: number;
  /** 0 sun-shaded, 1 flat: the tint holds its brightness in any light. */
  readonly flat?: number;
  /** Share (0..1) of the distance haze it takes; 1, the default, is all of it. */
  readonly haze?: number;
}

export type SceneryInstance = Mat4 | SceneryInstanceStyle;

const isStyled = (i: SceneryInstance): i is SceneryInstanceStyle => !ArrayBuffer.isView(i);

export interface SceneryMeshInput {
  /** Stable id so the registry can be queried + instance buffers updated by id. */
  id: string;
  positions: Float32Array; // interleaved vec3
  normals: Float32Array;   // interleaved vec3
  indices: Uint16Array | Uint32Array;
  /** Fallback colour used for every vertex when `colors` is omitted. */
  baseColor: [number, number, number, number];
  /**
   * Per-vertex colour (vec4 each, matching `positions`). glTF splits a model
   * into one primitive per material, so this carries each primitive's own
   * `baseColor` baked per vertex — otherwise the whole mesh would render in a
   * single colour. Omit it for a genuinely single-colour mesh (e.g. one boat
   * primitive); the pass then fills every vertex with `baseColor`.
   */
  colors?: Float32Array;
  /** Upper bound on the per-mesh instance count, so the buffer is allocated once. */
  maxInstances: number;
  /**
   * #688 — whether this mesh should drop into the shadow-depth cascade.
   * Defaults to `true`. Set `false` for small, shadow-neutral props
   * (buoys, flagpoles, distance markers, bank railings) so their
   * geometry doesn't inflate the shadow-pass triangle count every
   * cascade for a shadow nobody can see anyway. The lit colour pass
   * draws them exactly the same regardless.
   */
  castsShadow?: boolean;
  /**
   * #726 FR3 — frame time (seconds, `frame.time`) the model became
   * available. Its instances fade in over `SCENERY_REVEAL_SECONDS` from
   * then. Omit it for a mesh that should draw fully from its first frame
   * (the boat, the crew, models placed before the ride starts).
   */
  revealAt?: number;
}

interface RegisteredMesh {
  id: string;
  positionBuffer: GPUBuffer;
  normalBuffer: GPUBuffer;
  colorBuffer: GPUBuffer;
  colorByteLength: number;
  indexBuffer: GPUBuffer;
  indexFormat: 'uint16' | 'uint32';
  indexCount: number;
  instanceBuffer: GPUBuffer;
  /** #726 FR3 — {revealTime, fadeSeconds, visibility, pad}. */
  revealBuffer: GPUBuffer;
  maxInstances: number;
  instanceCount: number;
  /** #728 — per instance, whether it draws in the translucent pass. */
  translucent: Uint8Array;
  /** #726 FR4 — CPU staging for the instance buffer: one write per `setInstances`. */
  staging: Float32Array;
  translucentCount: number;
  bindGroup: GPUBindGroup;
  translucentBindGroup: GPUBindGroup;
  /** #688 — included in the shadow-depth iteration; defaults to true. */
  castsShadow: boolean;
}

/**
 * Snapshot of a registered mesh's GPU buffers + instance state, as the
 * shadow stage needs it to render depth-only (#591-fu P1c). Keeping this
 * read-only so the shadow stage can borrow buffers without reaching into
 * the lit pass's internals.
 */
export interface SceneryMeshSnapshot {
  readonly id: string;
  readonly positionBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly indexCount: number;
  readonly instanceBuffer: GPUBuffer;
  readonly instanceCount: number;
  /** #688 — whether this mesh opts into the shadow-depth cascade. */
  readonly castsShadow: boolean;
}

/** #737 VP-19 FR2 — what the lit mesh pass drew this frame. */
export interface SceneryMeshFrameStats {
  draws: number;
  instances: number;
  triangles: number;
}

export interface SceneryMeshPass extends Pass {
  /** #737 FR2 — this frame's counts, reset at the start of every `encode`. */
  readonly stats: SceneryMeshFrameStats;
  register(input: SceneryMeshInput): void;
  /**
   * Write `instances.length` instance records for `id`; clamps to the
   * registered maxInstances. A bare mat4 draws as authored; a styled
   * instance carries its own tint, opacity and rim (#728, #713 D3a).
   */
  setInstances(id: string, instances: readonly SceneryInstance[]): void;
  /**
   * Overwrite the per-vertex colour buffer for an already-registered mesh
   * (#578 FR2). The length must match the mesh's vertex count × 4; a
   * mismatch is a no-op so a stale call cannot corrupt the GPU buffer.
   * Used by the per-athlete rower-appearance seam to re-tint a scull
   * primitive without reallocating or re-registering.
   */
  writeColors(id: string, colors: Float32Array): void;
  readonly meshCount: number;
  /**
   * Iterate every registered mesh with a non-zero instance count. The
   * lit scenery pass uses this; the shadow stage uses
   * `forEachActiveShadowCaster` instead so shadow-neutral props are
   * skipped. Callback-based so the pass keeps buffer ownership and
   * callers can't accidentally mutate state.
   */
  forEachActiveMesh(cb: (snapshot: SceneryMeshSnapshot) => void): void;
  /**
   * #688 — like `forEachActiveMesh`, but skips meshes registered with
   * `castsShadow: false`. The shadow stage runs its own depth-only
   * pipeline over this subset so small props (buoys, flagpoles,
   * distance markers) don't inflate the per-cascade raster cost for
   * shadows nobody can see.
   */
  forEachActiveShadowCaster(cb: (snapshot: SceneryMeshSnapshot) => void): void;
}

export interface CreateSceneryMeshPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameUniforms: GPUBuffer;
}

export const createSceneryMeshPass = async ({
  device,
  format,
  frameUniforms,
}: CreateSceneryMeshPassOptions): Promise<SceneryMeshPass> => {
  const module = device.createShaderModule({ label: 'sceneryMesh', code: sceneryMeshWgsl });
  const vertexBuffers: GPUVertexBufferLayout[] = [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
    { arrayStride: 16, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x4' }] },
  ];
  const pipeline = await renderPipelineAsync(device, {
    label: 'sceneryMesh',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main', buffers: vertexBuffers },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  });
  // #728 FR2 — the race ghost: the same mesh, blended over what is behind
  // it. It tests against the scene's depth but does not write it, so the
  // water and the player's boat stay visible through it.
  const translucentPipeline = await renderPipelineAsync(device, {
    label: 'sceneryMesh-translucent',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main', buffers: vertexBuffers },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
  });

  const frameLayout = pipeline.getBindGroupLayout(0);
  const meshLayout = pipeline.getBindGroupLayout(1);
  const frameBind = device.createBindGroup({
    label: 'sceneryMesh-frame',
    layout: frameLayout,
    entries: [{ binding: 0, resource: { buffer: frameUniforms } }],
  });
  // `layout: 'auto'` gives each pipeline its own (equal) layouts, so the
  // translucent draws need bind groups made against its layouts.
  const translucentFrameBind = device.createBindGroup({
    label: 'sceneryMesh-translucent-frame',
    layout: translucentPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: frameUniforms } }],
  });
  const translucentMeshLayout = translucentPipeline.getBindGroupLayout(1);

  const registry = new Map<string, RegisteredMesh>();

  const register = (input: SceneryMeshInput): void => {
    if (registry.has(input.id)) return;
    const positionBuffer = device.createBuffer({
      label: `sceneryMesh:${input.id}-pos`,
      size: input.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(positionBuffer, 0, input.positions as BufferSource);
    const normalBuffer = device.createBuffer({
      label: `sceneryMesh:${input.id}-nrm`,
      size: input.normals.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(normalBuffer, 0, input.normals as BufferSource);
    const vertexCount = input.positions.length / 3;
    // Per-vertex colour: use the supplied buffer when it matches the vertex
    // count, otherwise fill every vertex with the single `baseColor`.
    let colors = input.colors;
    if (!colors || colors.length !== vertexCount * 4) {
      colors = new Float32Array(vertexCount * 4);
      const [r, g, b, a] = input.baseColor;
      for (let v = 0; v < vertexCount; v += 1) {
        colors[v * 4] = r;
        colors[v * 4 + 1] = g;
        colors[v * 4 + 2] = b;
        colors[v * 4 + 3] = a;
      }
    }
    const colorBuffer = device.createBuffer({
      label: `sceneryMesh:${input.id}-col`,
      size: Math.max(16, colors.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(colorBuffer, 0, colors as BufferSource);
    // `queue.writeBuffer` rejects a size that is not a multiple of 4, which
    // leaves the buffer zero-filled and the primitive invisible. A uint16
    // index list with an odd count (any odd triangle count) is 2 bytes
    // short, so pad it with one unused index; `indexCount` keeps the real
    // count so the pad is never drawn (#672).
    const indexData =
      input.indices.byteLength % 4 === 0
        ? input.indices
        : (() => {
            const padded = new Uint16Array(input.indices.length + 1);
            padded.set(input.indices);
            return padded;
          })();
    const indexBuffer = device.createBuffer({
      label: `sceneryMesh:${input.id}-idx`,
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, indexData as BufferSource);
    const instanceBuffer = device.createBuffer({
      label: `sceneryMesh:${input.id}-inst`,
      size: Math.max(1, input.maxInstances) * SCENERY_INSTANCE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const revealBuffer = device.createBuffer({
      label: `sceneryMesh:${input.id}-reveal`,
      size: SCENERY_REVEAL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(revealBuffer, 0, packRevealUniform(input.revealAt ?? ALWAYS_REVEALED) as BufferSource);
    const meshEntries: GPUBindGroupEntry[] = [
      { binding: 1, resource: { buffer: instanceBuffer } },
      { binding: 2, resource: { buffer: revealBuffer } },
    ];
    const bindGroup = device.createBindGroup({
      label: `sceneryMesh:${input.id}-bg`,
      layout: meshLayout,
      entries: meshEntries,
    });
    const translucentBindGroup = device.createBindGroup({
      label: `sceneryMesh:${input.id}-translucent-bg`,
      layout: translucentMeshLayout,
      entries: meshEntries,
    });
    registry.set(input.id, {
      id: input.id,
      positionBuffer,
      normalBuffer,
      colorBuffer,
      colorByteLength: colors.byteLength,
      indexBuffer,
      indexFormat: input.indices instanceof Uint32Array ? 'uint32' : 'uint16',
      indexCount: input.indices.length,
      instanceBuffer,
      revealBuffer,
      maxInstances: Math.max(1, input.maxInstances),
      instanceCount: 0,
      translucent: new Uint8Array(Math.max(1, input.maxInstances)),
      staging: new Float32Array(Math.max(1, input.maxInstances) * FLOATS_PER_INSTANCE),
      translucentCount: 0,
      bindGroup,
      translucentBindGroup,
      castsShadow: input.castsShadow ?? true,
    });
  };

  const writeColors = (id: string, colors: Float32Array): void => {
    const mesh = registry.get(id);
    if (!mesh) return;
    if (colors.byteLength !== mesh.colorByteLength) return;
    device.queue.writeBuffer(mesh.colorBuffer, 0, colors as BufferSource);
  };

  const setInstances = (id: string, instances: readonly SceneryInstance[]): void => {
    const mesh = registry.get(id);
    if (!mesh) return;
    const count = Math.min(instances.length, mesh.maxInstances);
    mesh.instanceCount = count;
    mesh.translucentCount = 0;
    for (let i = 0; i < count; i += 1) {
      const inst = instances[i];
      const o = i * FLOATS_PER_INSTANCE;
      const slot = mesh.staging.subarray(o, o + FLOATS_PER_INSTANCE);
      slot.fill(0);
      if (isStyled(inst)) {
        slot.set(inst.model, 0);
        if (inst.tint) slot.set(inst.tint, 16);
        const alpha = inst.alpha ?? 1;
        slot[20] = alpha;
        slot[21] = inst.rim ?? 0;
        slot[22] = inst.flat ?? 0;
        slot[23] = inst.haze ?? 1;
        mesh.translucent[i] = alpha < 1 ? 1 : 0;
      } else {
        slot.set(inst, 0);
        slot[20] = 1;
        slot[23] = 1;
        mesh.translucent[i] = 0;
      }
      mesh.translucentCount += mesh.translucent[i];
    }
    // #726 FR4 — one contiguous write for the whole list, not one per instance.
    if (count > 0) {
      device.queue.writeBuffer(
        mesh.instanceBuffer,
        0,
        mesh.staging.subarray(0, count * FLOATS_PER_INSTANCE) as BufferSource,
      );
    }
  };

  const stats: SceneryMeshFrameStats = { draws: 0, instances: 0, triangles: 0 };
  const draw = (pass: GPURenderPassEncoder, mesh: RegisteredMesh, count: number, first = 0): void => {
    pass.drawIndexed(mesh.indexCount, count, 0, 0, first);
    stats.draws += 1;
    stats.instances += count;
    stats.triangles += Math.floor(mesh.indexCount / 3) * count;
  };

  /** Draw each run of instances whose translucent flag equals `want`. */
  const drawRuns = (pass: GPURenderPassEncoder, mesh: RegisteredMesh, want: 0 | 1): void => {
    let i = 0;
    while (i < mesh.instanceCount) {
      if (mesh.translucent[i] !== want) { i += 1; continue; }
      const first = i;
      while (i < mesh.instanceCount && mesh.translucent[i] === want) i += 1;
      draw(pass, mesh, i - first, first);
    }
  };

  let disposed = false;
  return {
    name: 'sceneryMesh',
    stats,
    register,
    setInstances,
    writeColors,
    get meshCount() { return registry.size; },
    forEachActiveMesh(cb) {
      for (const mesh of registry.values()) {
        if (mesh.instanceCount === 0) continue;
        cb({
          id: mesh.id,
          positionBuffer: mesh.positionBuffer,
          indexBuffer: mesh.indexBuffer,
          indexFormat: mesh.indexFormat,
          indexCount: mesh.indexCount,
          instanceBuffer: mesh.instanceBuffer,
          instanceCount: mesh.instanceCount,
          castsShadow: mesh.castsShadow,
        });
      }
    },
    forEachActiveShadowCaster(cb) {
      for (const mesh of registry.values()) {
        if (mesh.instanceCount === 0) continue;
        if (!mesh.castsShadow) continue;
        cb({
          id: mesh.id,
          positionBuffer: mesh.positionBuffer,
          indexBuffer: mesh.indexBuffer,
          indexFormat: mesh.indexFormat,
          indexCount: mesh.indexCount,
          instanceBuffer: mesh.instanceBuffer,
          instanceCount: mesh.instanceCount,
          castsShadow: mesh.castsShadow,
        });
      }
    },
    encode(ctx: FrameContext) {
      stats.draws = 0;
      stats.instances = 0;
      stats.triangles = 0;
      if (disposed || registry.size === 0) return;
      let anyVisible = false;
      for (const mesh of registry.values()) {
        if (mesh.instanceCount > 0) { anyVisible = true; break; }
      }
      if (!anyVisible) return;
      const pass = ctx.encoder.beginRenderPass({
        label: 'sceneryMesh',
        colorAttachments: [{ view: ctx.swapView, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: {
          view: ctx.depthView,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, frameBind);
      let translucentMeshes = 0;
      const bindMesh = (mesh: RegisteredMesh, bindGroup: GPUBindGroup): void => {
        pass.setBindGroup(1, bindGroup);
        pass.setVertexBuffer(0, mesh.positionBuffer);
        pass.setVertexBuffer(1, mesh.normalBuffer);
        pass.setVertexBuffer(2, mesh.colorBuffer);
        pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
      };
      for (const mesh of registry.values()) {
        if (mesh.instanceCount === 0) continue;
        if (mesh.translucentCount > 0) translucentMeshes += 1;
        if (mesh.translucentCount === mesh.instanceCount) continue;
        bindMesh(mesh, mesh.bindGroup);
        if (mesh.translucentCount === 0) draw(pass, mesh, mesh.instanceCount);
        else drawRuns(pass, mesh, 0);
      }
      // #728 FR2 — translucent instances last, over everything opaque
      // this pass drew.
      if (translucentMeshes > 0) {
        pass.setPipeline(translucentPipeline);
        pass.setBindGroup(0, translucentFrameBind);
        for (const mesh of registry.values()) {
          if (mesh.instanceCount === 0 || mesh.translucentCount === 0) continue;
          bindMesh(mesh, mesh.translucentBindGroup);
          drawRuns(pass, mesh, 1);
        }
      }
      pass.end();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of registry.values()) {
        mesh.positionBuffer.destroy();
        mesh.normalBuffer.destroy();
        mesh.colorBuffer.destroy();
        mesh.indexBuffer.destroy();
        mesh.instanceBuffer.destroy();
        mesh.revealBuffer.destroy();
      }
      registry.clear();
    },
  };
};
