/**
 * `__VIRTUALROW_WEBGPU_HEALTH` publishing, same shape as the retired
 * `src/webgpu/health.ts` (#498). Kept as its own module so a Vitest schema
 * snapshot can diff the shape against the main-branch module without
 * importing the whole engine.
 */

/// <reference types="@webgpu/types" />

export type WebGPUFallbackReason =
  | 'webgpu-unsupported'
  | 'software-adapter'
  | 'device-lost'
  | 'adapter-request-failed'
  | 'device-request-failed'
  | 'renderer-unavailable';

/** #623 FR5 — surfaces of the boat mesh for the health telemetry. */
export type BoatMeshSource = 'glb' | 'baked' | 'failed';

export interface WebGPUHealth {
  adapter?: string;
  isSoftware?: boolean;
  deviceLostCount: number;
  dispatchMs?: number;
  mappedReadMs?: number;
  fallbackReason?: WebGPUFallbackReason;
  /**
   * #623 FR5 — the source of the boat mesh the engine ended up drawing.
   * - `'glb'`: a tier-E GLB (`scull*.glb`) loaded cleanly.
   * - `'baked'`: the pre-decoded `/assets/boat/shell.bin` loaded cleanly.
   * - `'failed'`: both failed; the engine surfaces `renderer-unavailable`
   *   rather than draw the SSR/test-only procedural stub.
   * The procedural fallback is never reported here on a user-facing path
   * (D4-a) — it's only there for SSR + unit tests.
   */
  boatSource?: BoatMeshSource;
}

export const readWebGPUHealth = (): WebGPUHealth | undefined =>
  (globalThis as unknown as { window?: { __VIRTUALROW_WEBGPU_HEALTH?: WebGPUHealth } }).window
    ?.__VIRTUALROW_WEBGPU_HEALTH;

export const resetWebGPUHealth = (): void => {
  const w = (globalThis as unknown as { window?: { __VIRTUALROW_WEBGPU_HEALTH?: WebGPUHealth } }).window;
  if (w) delete w.__VIRTUALROW_WEBGPU_HEALTH;
};

const ensure = (): WebGPUHealth => {
  const w = (globalThis as unknown as { window: { __VIRTUALROW_WEBGPU_HEALTH?: WebGPUHealth } }).window;
  if (!w.__VIRTUALROW_WEBGPU_HEALTH) {
    w.__VIRTUALROW_WEBGPU_HEALTH = { deviceLostCount: 0 };
  }
  return w.__VIRTUALROW_WEBGPU_HEALTH;
};

export const publishAdapter = (adapter: string, isSoftware: boolean): void => {
  const health = ensure();
  health.adapter = adapter;
  health.isSoftware = isSoftware;
};

export const publishDeviceLost = (): void => {
  const health = ensure();
  health.deviceLostCount += 1;
};

export const publishFallback = (reason: WebGPUFallbackReason): void => {
  const health = ensure();
  health.fallbackReason = reason;
};

/** #623 FR5 — record the boat mesh source on the health global. */
export const publishBoatSource = (source: BoatMeshSource): void => {
  const health = ensure();
  health.boatSource = source;
};
