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
import type { ShadowResources } from './bank';
import {
  AERIAL_FOG_WGSL,
  lightingBindingWgsl,
  SAMPLE_SHADOW_WGSL,
  SHADOW_UNIFORMS_WGSL,
  SKY_COLOUR_WGSL,
} from '../engine/shaderSnippets';
import { defaultLightingUniformBuffer } from '../engine/uniforms';
import { buildCellLayout, frustumPlanes, maxScale, meshRadius, visibleRuns, type CellLayout } from '../plan/instanceCells';
import { ALWAYS_REVEALED, packRevealUniform, SCENERY_REVEAL_UNIFORM_BYTES } from './sceneryReveal';
import { renderPipelineAsync } from '../engine/pipelineAsync';
import { sceneMultisample } from '../engine/msaa';

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
  /**
   * #736 — draw this mesh's instances from slot `index` of a shared buffer
   * reserved with `reserveInstanceGroup`, so a model made of many primitives
   * (the scull) uploads all its matrices in one write per frame.
   */
  instanceGroup?: { name: string; index: number };
  /**
   * #727 FR1 — bin the instances into ground cells this many metres across
   * and draw only the cells in view (and, for shadows, inside each
   * cascade). For static route scenery; the scull, re-posed every frame,
   * leaves it off.
   */
  cullCellMetres?: number;
  /**
   * #725 FR7 — metres from the camera beyond which this mesh is not drawn
   * (cells further away are skipped, and the shader fades it out before).
   * 0 or absent draws it at any distance.
   */
  drawDistanceMetres?: number;
  /** #725 FR7 — metres from the camera beyond which it casts no shadow; 0 or absent for no limit. */
  shadowDistanceMetres?: number;
  /**
   * #727 FR4 — the model's LOD1, drawn (and cast) for the cells further
   * than {@link SCENERY_LOD1_METRES} from the eye. Same instances, lighter
   * geometry. Only used with `cullCellMetres`, once `setView` has an eye.
   */
  lod1?: {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint16Array | Uint32Array;
    colors?: Float32Array;
  };
}

/** #727 FR4 — horizontal metres from the eye beyond which a cell draws LOD1. */
export const SCENERY_LOD1_METRES = 120;

/** One level of detail's vertex and index buffers. */
interface MeshGeometry {
  positionBuffer: GPUBuffer;
  normalBuffer: GPUBuffer;
  colorBuffer: GPUBuffer;
  colorByteLength: number;
  indexBuffer: GPUBuffer;
  indexFormat: 'uint16' | 'uint32';
  indexCount: number;
  /** GPU bytes held. */
  bytes: number;
}

/** #727 — per-mesh culling state: the cell layout and a scratch run list. */
interface MeshCull {
  cellMetres: number;
  /** #725 FR7 — horizontal draw limit from the eye, 0 for none. */
  drawDistance: number;
  /** #725 FR7 — horizontal shadow-casting limit from the eye, 0 for none. */
  shadowDistance: number;
  /** The model's reach from its pivot, before instance scale. */
  radius: number;
  layout: CellLayout | null;
  runs: Uint32Array;
  /** #727 FR4 — scratch runs for the LOD1 side of a split. */
  farRuns: Uint32Array;
}

/** #736 — one GPU buffer shared by several meshes, uploaded in one write. */
interface InstanceGroup {
  buffer: GPUBuffer;
  staging: Float32Array;
  /** Bytes between one mesh's slot and the next (storage-offset aligned). */
  strideBytes: number;
  slots: number;
  maxInstances: number;
  dirty: boolean;
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
  /** #736 — byte range of `instanceBuffer` this mesh reads; the whole buffer unless grouped. */
  instanceOffset: number;
  instanceSize: number;
  /** #736 — set when the instances live in a shared group buffer. */
  group: InstanceGroup | null;
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
  /** #727 — null for a mesh drawn whole every frame. */
  cull: MeshCull | null;
  /** #727 FR4 — the LOD1 geometry, or null. */
  lod1: MeshGeometry | null;
  /** #727 FR5 — GPU bytes this mesh holds (not counting a shared group buffer). */
  bytes: number;
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
  /** #736 — byte range of `instanceBuffer` holding this mesh's instances. */
  readonly instanceOffset: number;
  readonly instanceSize: number;
  readonly instanceCount: number;
  /** #688 — whether this mesh opts into the shadow-depth cascade. */
  readonly castsShadow: boolean;
}

/** #737 VP-19 FR2 — what the lit mesh pass drew this frame. */
export interface SceneryMeshFrameStats {
  draws: number;
  instances: number;
  triangles: number;
  /** #727 FR5 — meshes registered (resident) this frame, and the GPU bytes they hold. */
  residentMeshes: number;
  residentBytes: number;
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
   * #736 — reserve a shared instance buffer of `slots` meshes, each up to
   * `maxInstances`, for meshes registered with `instanceGroup`. Their
   * `setInstances` calls fill a CPU staging copy; `flushInstanceGroups`
   * (also run at the start of `encode`) uploads each changed group in one
   * write. Reserving an existing name is a no-op.
   */
  reserveInstanceGroup(name: string, slots: number, maxInstances: number): void;
  /** #736 — upload every group changed since the last flush, one write each. */
  flushInstanceGroups(): void;
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
  /**
   * #734 FR4 — hand the pass the shadow atlas to receive from. A no-op on a
   * pass created without `receiveShadows`.
   */
  setShadow(shadow: ShadowResources): void;
  /**
   * #727 FR1 — the camera's view-projection for this frame. Culled meshes
   * draw only their cells inside it; until it is set they draw whole.
   */
  setView(viewProj: Mat4, eye?: ArrayLike<number>): void;
  /**
   * #727 FR2 — like `forEachActiveShadowCaster`, with the runs of each
   * mesh's instances inside `viewProj` (a cascade's light projection):
   * `runs` holds `runCount` `(firstInstance, count)` pairs. A mesh with no
   * instance inside is skipped.
   */
  forEachShadowCasterIn(
    viewProj: Mat4,
    cb: (snapshot: SceneryMeshSnapshot, runs: Uint32Array, runCount: number) => void,
  ): void;
  /**
   * #727 FR3 — drop a mesh and free its GPU buffers; it can be registered
   * again later. Meshes in an instance group cannot be dropped.
   */
  unregister(id: string): boolean;
  /** Whether this pass samples the shadow atlas. */
  readonly receivesShadows: boolean;
}

export interface CreateSceneryMeshPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameUniforms: GPUBuffer;
  /** #725 FR6 — the conditions block, for the shared fog's horizon colour; midday when absent. */
  lightingUniforms?: GPUBuffer;
  /**
   * #734 FR4 — sample the cascaded shadow atlas (medium and up). The atlas
   * comes later, through `setShadow`; until then the pass draws nothing.
   */
  receiveShadows?: boolean;
}

/** The scenery pass's bind group for the shadow atlas; 0 and 1 are frame and mesh. */
export const SCENERY_SHADOW_GROUP = 2 as const;

/**
 * Metres a receiving point moves along its normal before the atlas lookup,
 * so a mesh does not shadow its own lit faces (acne).
 */
export const SCENERY_SHADOW_NORMAL_OFFSET_M = 0.08;

/** The WGSL prepended to `sceneryMesh.wgsl`: `sceneryShadow(worldPos, viewZ, n)`. */
export const sceneryShadowWgsl = (receive: boolean): string =>
  receive
    ? SHADOW_UNIFORMS_WGSL.replaceAll('@group(1)', `@group(${SCENERY_SHADOW_GROUP})`) +
      SAMPLE_SHADOW_WGSL +
      `
fn sceneryShadow(worldPos: vec3<f32>, viewZ: f32, n: vec3<f32>) -> f32 {
  return sampleShadow(worldPos + n * ${SCENERY_SHADOW_NORMAL_OFFSET_M.toFixed(3)}, viewZ);
}
`
    : `
fn sceneryShadow(worldPos: vec3<f32>, viewZ: f32, n: vec3<f32>) -> f32 {
  return 1.0;
}
`;

export const createSceneryMeshPass = async ({
  device,
  format,
  frameUniforms,
  lightingUniforms: liveLighting,
  receiveShadows = false,
}: CreateSceneryMeshPassOptions): Promise<SceneryMeshPass> => {
  const lightingUniforms = liveLighting ?? defaultLightingUniformBuffer(device);
  const module = device.createShaderModule({
    label: 'sceneryMesh',
    // #725 FR6 — the shared aerial fog, in the sky's horizon colour.
    code: sceneryShadowWgsl(receiveShadows) + lightingBindingWgsl(1) + SKY_COLOUR_WGSL + AERIAL_FOG_WGSL + sceneryMeshWgsl,
  });
  const vertexBuffers: GPUVertexBufferLayout[] = [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
    { arrayStride: 16, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x4' }] },
  ];
  const pipeline = await renderPipelineAsync(device, {
    multisample: sceneMultisample(device),
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
    multisample: sceneMultisample(device),
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
    entries: [
      { binding: 0, resource: { buffer: frameUniforms } },
      { binding: 1, resource: { buffer: lightingUniforms } },
    ],
  });
  // `layout: 'auto'` gives each pipeline its own (equal) layouts, so the
  // translucent draws need bind groups made against its layouts.
  const translucentFrameBind = device.createBindGroup({
    label: 'sceneryMesh-translucent-frame',
    layout: translucentPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameUniforms } },
      { binding: 1, resource: { buffer: lightingUniforms } },
    ],
  });
  const translucentMeshLayout = translucentPipeline.getBindGroupLayout(1);

  const registry = new Map<string, RegisteredMesh>();
  const groups = new Map<string, InstanceGroup>();
  // A storage binding's offset must be a multiple of this (256 on every adapter today).
  const offsetAlignment = device.limits?.minStorageBufferOffsetAlignment || 256;

  const reserveInstanceGroup = (name: string, slots: number, maxInstances: number): void => {
    if (groups.has(name)) return;
    const perMesh = Math.max(1, maxInstances) * SCENERY_INSTANCE_BYTES;
    const strideBytes = Math.ceil(perMesh / offsetAlignment) * offsetAlignment;
    const count = Math.max(1, slots);
    groups.set(name, {
      buffer: device.createBuffer({
        label: `sceneryMesh:${name}-inst`,
        size: count * strideBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      staging: new Float32Array((count * strideBytes) / 4),
      strideBytes,
      slots: count,
      maxInstances: Math.max(1, maxInstances),
      dirty: false,
    });
  };

  const flushInstanceGroups = (): void => {
    for (const group of groups.values()) {
      if (!group.dirty) continue;
      group.dirty = false;
      device.queue.writeBuffer(group.buffer, 0, group.staging as BufferSource);
    }
  };

  /** Vertex and index buffers for one level of detail. */
  const createGeometry = (
    label: string,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint16Array | Uint32Array,
    baseColor: [number, number, number, number],
    suppliedColors: Float32Array | undefined,
  ): MeshGeometry => {
    const positionBuffer = device.createBuffer({
      label: `${label}-pos`,
      size: positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(positionBuffer, 0, positions as BufferSource);
    const normalBuffer = device.createBuffer({
      label: `${label}-nrm`,
      size: normals.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(normalBuffer, 0, normals as BufferSource);
    const vertexCount = positions.length / 3;
    // Per-vertex colour: use the supplied buffer when it matches the vertex
    // count, otherwise fill every vertex with the single `baseColor`.
    let colors = suppliedColors;
    if (!colors || colors.length !== vertexCount * 4) {
      colors = new Float32Array(vertexCount * 4);
      const [r, g, b, a] = baseColor;
      for (let v = 0; v < vertexCount; v += 1) {
        colors[v * 4] = r;
        colors[v * 4 + 1] = g;
        colors[v * 4 + 2] = b;
        colors[v * 4 + 3] = a;
      }
    }
    const colorBuffer = device.createBuffer({
      label: `${label}-col`,
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
      indices.byteLength % 4 === 0
        ? indices
        : (() => {
            const padded = new Uint16Array(indices.length + 1);
            padded.set(indices);
            return padded;
          })();
    const indexBuffer = device.createBuffer({
      label: `${label}-idx`,
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, indexData as BufferSource);
    return {
      positionBuffer,
      normalBuffer,
      colorBuffer,
      colorByteLength: colors.byteLength,
      indexBuffer,
      indexFormat: indices instanceof Uint32Array ? 'uint32' : 'uint16',
      indexCount: indices.length,
      bytes: positions.byteLength + normals.byteLength + colors.byteLength + indexData.byteLength,
    };
  };

  const register = (input: SceneryMeshInput): void => {
    if (registry.has(input.id)) return;
    const lod0 = createGeometry(
      `sceneryMesh:${input.id}`,
      input.positions,
      input.normals,
      input.indices,
      input.baseColor,
      input.colors,
    );
    const { positionBuffer, normalBuffer, colorBuffer, indexBuffer } = lod0;
    const lod1 = input.lod1 && input.cullCellMetres
      ? createGeometry(
          `sceneryMesh:${input.id}-lod1`,
          input.lod1.positions,
          input.lod1.normals,
          input.lod1.indices,
          input.baseColor,
          input.lod1.colors,
        )
      : null;
    const group = input.instanceGroup ? groups.get(input.instanceGroup.name) ?? null : null;
    const slotIndex = input.instanceGroup?.index ?? 0;
    if (input.instanceGroup && (!group || slotIndex < 0 || slotIndex >= group.slots)) {
      throw new Error(`sceneryMesh: ${input.id} has no slot ${slotIndex} in group "${input.instanceGroup.name}"`);
    }
    const maxInstances = group ? group.maxInstances : Math.max(1, input.maxInstances);
    const instanceSize = maxInstances * SCENERY_INSTANCE_BYTES;
    const instanceOffset = group ? slotIndex * group.strideBytes : 0;
    const instanceBuffer = group
      ? group.buffer
      : device.createBuffer({
          label: `sceneryMesh:${input.id}-inst`,
          size: instanceSize,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    const revealBuffer = device.createBuffer({
      label: `sceneryMesh:${input.id}-reveal`,
      size: SCENERY_REVEAL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(revealBuffer, 0, packRevealUniform(input.revealAt ?? ALWAYS_REVEALED, undefined, input.drawDistanceMetres ?? 0) as BufferSource);
    const meshEntries: GPUBindGroupEntry[] = [
      { binding: 1, resource: { buffer: instanceBuffer, offset: instanceOffset, size: instanceSize } },
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
      colorByteLength: lod0.colorByteLength,
      indexBuffer,
      indexFormat: lod0.indexFormat,
      indexCount: lod0.indexCount,
      instanceBuffer,
      instanceOffset,
      instanceSize,
      group,
      revealBuffer,
      maxInstances,
      instanceCount: 0,
      translucent: new Uint8Array(maxInstances),
      staging: group
        ? group.staging.subarray(instanceOffset / 4, instanceOffset / 4 + maxInstances * FLOATS_PER_INSTANCE)
        : new Float32Array(maxInstances * FLOATS_PER_INSTANCE),
      translucentCount: 0,
      bindGroup,
      translucentBindGroup,
      castsShadow: input.castsShadow ?? true,
      cull:
        input.cullCellMetres && !group
          ? { cellMetres: input.cullCellMetres, drawDistance: Math.max(0, input.drawDistanceMetres ?? 0), shadowDistance: Math.max(0, input.shadowDistanceMetres ?? 0), radius: meshRadius(input.positions), layout: null, runs: new Uint32Array(0), farRuns: new Uint32Array(0) }
          : null,
      lod1,
      bytes: lod0.bytes + (lod1?.bytes ?? 0) + (group ? 0 : instanceSize) + SCENERY_REVEAL_UNIFORM_BYTES,
    });
    residentBytes += registry.get(input.id)!.bytes;
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
    // #727 FR1 — a culled mesh stores its instances cell by cell.
    let order: Uint32Array | null = null;
    if (mesh.cull) {
      const positions = new Float32Array(count * 3);
      const radii = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        const inst = instances[i];
        const m = isStyled(inst) ? inst.model : inst;
        positions[i * 3] = m[12];
        positions[i * 3 + 1] = m[13];
        positions[i * 3 + 2] = m[14];
        radii[i] = mesh.cull.radius * maxScale(m);
      }
      mesh.cull.layout = buildCellLayout(positions, radii, mesh.cull.cellMetres);
      mesh.cull.runs = new Uint32Array(mesh.cull.layout.cells.length * 2);
      mesh.cull.farRuns = new Uint32Array(mesh.cull.layout.cells.length * 2);
      order = mesh.cull.layout.order;
    }
    for (let i = 0; i < count; i += 1) {
      const inst = instances[order ? order[i] : i];
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
    // #736 — a grouped mesh goes up with the rest of its group.
    if (mesh.group) {
      mesh.group.dirty = true;
      return;
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

  let residentBytes = 0;
  const stats: SceneryMeshFrameStats = { draws: 0, instances: 0, triangles: 0, residentMeshes: 0, residentBytes: 0 };
  // #727 FR1 — this frame's view frustum, once `setView` has been called.
  const viewPlanes = new Float32Array(24);
  let viewSet = false;
  const cascadePlanes = new Float32Array(24);
  // #725 FR7 — the eye, for meshes with a draw distance.
  const nearLimit: { x: number; z: number; maxDistance: number; minDistance?: number } = { x: 0, z: 0, maxDistance: 0 };
  let eyeSet = false;
  const wholeRun = new Uint32Array(2);
  const runResult: { runs: Uint32Array; count: number } = { runs: wholeRun, count: 0 };
  /** #727 FR4 — whether this frame splits `mesh` into LOD0 near and LOD1 far. */
  const splitsLod = (mesh: RegisteredMesh): boolean => !!mesh.lod1 && !!mesh.cull?.layout && eyeSet;
  /**
   * Runs of `mesh` to draw inside `planes`; the whole list when it is not
   * culled. `side` picks the near (LOD0) or far (LOD1) cells of a mesh with
   * an LOD1; 'all' ignores the split.
   */
  const runsIn = (
    mesh: RegisteredMesh,
    planes: Float32Array | null,
    forShadow = false,
    side: 'all' | 'near' | 'far' = 'all',
  ): { runs: Uint32Array; count: number } => {
    if (!mesh.cull?.layout || !planes) {
      wholeRun[0] = 0;
      wholeRun[1] = mesh.instanceCount;
      runResult.runs = wholeRun;
      runResult.count = 1;
      return runResult;
    }
    const limit = eyeSet ? (forShadow ? mesh.cull.shadowDistance : mesh.cull.drawDistance) : 0;
    runResult.runs = side === 'far' ? mesh.cull.farRuns : mesh.cull.runs;
    if (side === 'near') {
      nearLimit.maxDistance = limit > 0 ? Math.min(limit, SCENERY_LOD1_METRES) : SCENERY_LOD1_METRES;
      nearLimit.minDistance = undefined;
    } else if (side === 'far') {
      if (limit > 0 && limit <= SCENERY_LOD1_METRES) {
        runResult.count = 0;
        return runResult;
      }
      nearLimit.maxDistance = limit;
      nearLimit.minDistance = SCENERY_LOD1_METRES;
    } else {
      nearLimit.maxDistance = limit;
      nearLimit.minDistance = undefined;
    }
    runResult.count = visibleRuns(mesh.cull.layout, planes, runResult.runs, nearLimit);
    nearLimit.minDistance = undefined;
    return runResult;
  };
  // One reused snapshot object, so the per-cascade walk allocates nothing.
  const shadowSnapshot = {} as { -readonly [K in keyof SceneryMeshSnapshot]: SceneryMeshSnapshot[K] };
  const snapshotOf = (mesh: RegisteredMesh, lod: MeshGeometry | null = null): SceneryMeshSnapshot => {
    shadowSnapshot.id = mesh.id;
    shadowSnapshot.positionBuffer = lod ? lod.positionBuffer : mesh.positionBuffer;
    shadowSnapshot.indexBuffer = lod ? lod.indexBuffer : mesh.indexBuffer;
    shadowSnapshot.indexFormat = lod ? lod.indexFormat : mesh.indexFormat;
    shadowSnapshot.indexCount = lod ? lod.indexCount : mesh.indexCount;
    shadowSnapshot.instanceBuffer = mesh.instanceBuffer;
    shadowSnapshot.instanceOffset = mesh.instanceOffset;
    shadowSnapshot.instanceSize = mesh.instanceSize;
    shadowSnapshot.instanceCount = mesh.instanceCount;
    shadowSnapshot.castsShadow = mesh.castsShadow;
    return shadowSnapshot;
  };
  const destroyMesh = (mesh: RegisteredMesh): void => {
    mesh.positionBuffer.destroy();
    mesh.normalBuffer.destroy();
    mesh.colorBuffer.destroy();
    mesh.indexBuffer.destroy();
    if (!mesh.group) mesh.instanceBuffer.destroy();
    mesh.revealBuffer.destroy();
    if (mesh.lod1) {
      mesh.lod1.positionBuffer.destroy();
      mesh.lod1.normalBuffer.destroy();
      mesh.lod1.colorBuffer.destroy();
      mesh.lod1.indexBuffer.destroy();
    }
  };
  const draw = (
    pass: GPURenderPassEncoder,
    mesh: Pick<RegisteredMesh, 'indexCount'>,
    count: number,
    first = 0,
  ): void => {
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

  // #734 FR4 — one shadow bind group per pipeline (`layout: 'auto'`).
  let shadowBind: GPUBindGroup | null = null;
  let translucentShadowBind: GPUBindGroup | null = null;
  const setShadow = (shadow: ShadowResources): void => {
    if (!receiveShadows) return;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: shadow.uniforms } },
      { binding: 1, resource: shadow.atlasView },
      { binding: 2, resource: shadow.cmpSampler },
    ];
    shadowBind = device.createBindGroup({
      label: 'sceneryMesh-shadow',
      layout: pipeline.getBindGroupLayout(SCENERY_SHADOW_GROUP),
      entries,
    });
    translucentShadowBind = device.createBindGroup({
      label: 'sceneryMesh-translucent-shadow',
      layout: translucentPipeline.getBindGroupLayout(SCENERY_SHADOW_GROUP),
      entries,
    });
  };

  let disposed = false;
  return {
    name: 'sceneryMesh',
    stats,
    setShadow,
    receivesShadows: receiveShadows,
    setView(viewProj: Mat4, eye?: ArrayLike<number>) {
      frustumPlanes(viewProj, viewPlanes);
      viewSet = true;
      if (eye) {
        nearLimit.x = eye[0];
        nearLimit.z = eye[2];
        eyeSet = true;
      }
    },
    forEachShadowCasterIn(viewProj, cb) {
      frustumPlanes(viewProj, cascadePlanes);
      for (const mesh of registry.values()) {
        if (mesh.instanceCount === 0 || !mesh.castsShadow) continue;
        if (splitsLod(mesh)) {
          // #727 FR4 — the far cells cast from LOD1.
          const near = runsIn(mesh, cascadePlanes, true, 'near');
          if (near.count > 0) cb(snapshotOf(mesh), near.runs, near.count);
          const far = runsIn(mesh, cascadePlanes, true, 'far');
          if (far.count > 0) cb(snapshotOf(mesh, mesh.lod1), far.runs, far.count);
          continue;
        }
        const { runs, count } = runsIn(mesh, cascadePlanes, true);
        if (count === 0) continue;
        cb(snapshotOf(mesh), runs, count);
      }
    },
    unregister(id: string) {
      const mesh = registry.get(id);
      if (!mesh || mesh.group) return false;
      destroyMesh(mesh);
      residentBytes -= mesh.bytes;
      registry.delete(id);
      return true;
    },
    register,
    setInstances,
    reserveInstanceGroup,
    flushInstanceGroups,
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
          instanceOffset: mesh.instanceOffset,
          instanceSize: mesh.instanceSize,
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
          instanceOffset: mesh.instanceOffset,
          instanceSize: mesh.instanceSize,
          instanceCount: mesh.instanceCount,
          castsShadow: mesh.castsShadow,
        });
      }
    },
    encode(ctx: FrameContext) {
      stats.draws = 0;
      stats.instances = 0;
      stats.triangles = 0;
      stats.residentMeshes = registry.size;
      stats.residentBytes = residentBytes;
      if (disposed || registry.size === 0) return;
      flushInstanceGroups();
      if (receiveShadows && !shadowBind) return;
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
      if (shadowBind) pass.setBindGroup(SCENERY_SHADOW_GROUP, shadowBind);
      let translucentMeshes = 0;
      const bindMesh = (mesh: Omit<MeshGeometry, 'bytes' | 'colorByteLength' | 'indexCount'>, bindGroup: GPUBindGroup): void => {
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
        if (mesh.translucentCount === 0) {
          if (viewSet && splitsLod(mesh)) {
            // #727 FR4 — LOD0 for the near cells, LOD1 for the far ones.
            const near = runsIn(mesh, viewPlanes, false, 'near');
            if (near.count > 0) {
              bindMesh(mesh, mesh.bindGroup);
              for (let r = 0; r < near.count; r += 1) draw(pass, mesh, near.runs[r * 2 + 1], near.runs[r * 2]);
            }
            const far = runsIn(mesh, viewPlanes, false, 'far');
            if (far.count > 0) {
              bindMesh(mesh.lod1!, mesh.bindGroup);
              for (let r = 0; r < far.count; r += 1) draw(pass, mesh.lod1!, far.runs[r * 2 + 1], far.runs[r * 2]);
            }
            continue;
          }
          // #727 FR1 — only the cells in view.
          const { runs, count } = runsIn(mesh, viewSet ? viewPlanes : null);
          if (count === 0) continue;
          bindMesh(mesh, mesh.bindGroup);
          for (let r = 0; r < count; r += 1) draw(pass, mesh, runs[r * 2 + 1], runs[r * 2]);
          continue;
        }
        bindMesh(mesh, mesh.bindGroup);
        drawRuns(pass, mesh, 0);
      }
      // #728 FR2 — translucent instances last, over everything opaque
      // this pass drew.
      if (translucentMeshes > 0) {
        pass.setPipeline(translucentPipeline);
        pass.setBindGroup(0, translucentFrameBind);
        if (translucentShadowBind) pass.setBindGroup(SCENERY_SHADOW_GROUP, translucentShadowBind);
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
      for (const mesh of registry.values()) destroyMesh(mesh);
      registry.clear();
      residentBytes = 0;
      for (const group of groups.values()) group.buffer.destroy();
      groups.clear();
      if (!liveLighting) lightingUniforms.destroy();
    },
  };
};
