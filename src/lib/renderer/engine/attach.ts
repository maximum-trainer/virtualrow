/**
 * Public entry point for the WebGPU engine (#550 FR1). The UI shell owns the
 * `<canvas>` and calls this in `onMount`, matching the structural signature
 * agreed with the UI thread.
 *
 * The exported `RideAttach` / `RideRenderer` types mirror the UI thread's
 * `src/lib/ui/rideCanvas.ts` shape (which lives on their branch); when their
 * branch merges this file keeps satisfying it structurally without a hard
 * import. Returning `null` means "renderer unavailable" and the host shows
 * its placeholder.
 *
 * Device-lost recovery (#584 FR1, D1-a): the per-device scene lives in
 * `rideScene.ts`. `attach` owns the device-session lifecycle, the outer
 * render loop, and the one-attempt reattach on the same canvas when the
 * current device fires its `lost` promise. On a second loss (the retry
 * device also dies) the engine stops drawing and publishes the
 * `renderer-unavailable` fallback.
 */

/// <reference types="@webgpu/types" />

import { warmUpScene } from './warmUp';
import { requestDevice, softwareAttachRequested, type DeviceSession } from './device';
import { publishFallback, type WebGPUFallbackReason } from './health';
import type { RideFrame } from './rideFrame';
import {
  createRideScene,
  isSceneryRoute,
  type RideSceneHandle,
  type SceneryRoute,
} from './rideScene';
import { isLightingConditions } from '../plan/conditionsLighting';
import {
  createTelemetry,
  publishBanner,
  releaseTelemetry,
  type TelemetryHandles,
} from './telemetry';


/** #803 — the longest the warm-up waits for the GPU before the ride starts anyway. */
const WARM_UP_TIMEOUT_MS = 3000;
export interface RideRenderer {
  dispose(): void;
  /**
   * Push a per-athlete appearance change to the active scene (#578 FR5).
   * No-op before the scene has attached, no-op after dispose, no-op while
   * the engine has fallen back to the UI placeholder. The scene re-tints
   * the scull primitives on the next frame — no reattach, no extra draw
   * calls. The palette shape is `CrewPalette` from
   * `src/lib/renderer/plan/crewPalette.ts`; it's intentionally re-typed
   * as `unknown` here so a shell import of this file doesn't drag the
   * plan layer in. Optional so a lightweight test fake can skip it.
   */
  setAppearance?(palette: unknown): void;
  /**
   * #730 VP-12 — relight the active scene for the rower's conditions
   * (`dawn` | `midday` | `golden` | `overcast` | `dusk`). Takes effect on
   * the next frame, with no reattach; survives a device-lost rebuild. An
   * unknown value is ignored. Optional so a test fake can skip it.
   */
  setConditions?(conditions: unknown): void;
  /**
   * #733 VP-15 — CSS px the HUD covers along each canvas edge. Reframes on
   * the next frame; survives a device-lost rebuild.
   */
  setViewportInsets?(insets: unknown): void;
}

export { isSceneryRoute, type SceneryRoute };

/**
 * #584 FR1 D2-a — banner copy ported verbatim from the retired WebGL
 * `webgl-context-recovery.spec.ts`'s messages so the ride-view banner has
 * one authoritative source. The spec that used to assert against this text
 * is now its contract on the engine side (`ac4PortedBehaviors.test.ts`).
 */
export const BANNER_LOST_RESTORING =
  'Lost the graphics context — restoring…';
export const BANNER_LOST_FAILED =
  "We couldn't get the graphics context back. Your row is still being recorded.";

export type RideAttachOpts = {
  tier?: string;
  /**
   * #591-fu P2c: separate "view distance" tier (LOD / fog / sprout
   * window / stream look-ahead), independent of the quality tier above.
   * Omitted falls back to `tier`.
   */
  distanceTier?: string;
  route?: unknown;
  /**
   * #690 — stable engine route id, used by `placeFurniture` to attach
   * hand-authored per-route extras (boathouse, bridge, pontoon, …) for
   * a named route like the Willowbrook demo. Omitted = only the generic
   * course furniture (buoys, posts, finish tower, flagpoles) is placed.
   */
  routeId?: string;
  testMode?: boolean;
  /**
   * Per-frame data from the UI shell (#570 FR7). Optional — the smoke
   * pages pass no frame and the engine falls back to a canned chase
   * camera. The engine never caches a `RideFrame`; it calls `getFrame`
   * once per rendered frame and reads the returned object.
   */
  getFrame?: () => RideFrame;
  /**
   * Which crewed scull GLB to load. The shell resolves this against the
   * athlete's intervals.icu profile `sex` and the stored CrewPreference
   * (#232 / #443), so the engine stays free of that policy. Defaults to
   * `male` — the GLB the engine shipped with before the seam reached it.
   */
  crew?: 'male' | 'female';
  /** #571 — stable athlete identifier used to deterministically pick a
   *  shell paint tint from `boatPaint.BOAT_PAINT_PALETTE`. Omitted =
   *  the pre-#571 off-white default. */
  athleteId?: string;
  /**
   * #578 FR2 — initial per-athlete clothing / hair / hat palette. The
   * shell derives it from `rowerAppearanceService` through
   * `plan/crewPalette.paletteFromPreference`. Omitted = the engine's
   * baked default (navy unisuit, dark hair). Typed as `unknown` here so
   * the engine's public attach surface doesn't export the plan type;
   * callers hand it through as-is.
   */
  appearance?: unknown;
  /**
   * #730 VP-12 — the resolved conditions the shell's picker chose. Omitted
   * = the engine default (today's Midday frame).
   */
  conditions?: string;
  /** #733 VP-15 — CSS px the HUD covers along each canvas edge. */
  viewportInsets?: { top: number; right: number; bottom: number; left: number };
  /**
   * #728 VP-10 FR2 — called with the race ghost's marker (CSS px over the
   * canvas, and the gap) whenever it moves, and null when it hides.
   */
  onGhostMarker?: (marker: { x: number; y: number; meters: number; ahead: boolean } | null) => void;
  /**
   * #726 VP-08 FR1 — each load phase (`scene`, `boat`, `crew`, `atlas`,
   * `scenery-near`, `frame`) as it settles, for the host's loading bar.
   */
  onLoadPhase?: (phase: string, status: 'done' | 'failed') => void;
  /**
   * #803 — true while the host's loading screen still covers the canvas.
   * The engine keeps drawing behind it, and reports ready only once it has
   * gone and a few frames have been presented uncovered, so the one-off
   * cost of the first uncovered present (a 120-400 ms Windows swap-chain
   * Present) lands on the loading screen, not in the first strokes.
   */
  loadingOverlayShown?: () => boolean;
};

export type RideAttach = (
  canvas: HTMLCanvasElement,
  opts?: RideAttachOpts,
) => RideRenderer | null | Promise<RideRenderer | null>;

const PLAYWRIGHT_TESTING_KEY = '__PLAYWRIGHT_TESTING' as const;
const FORCE_LOST_KEY = '__ROWER3D_FORCE_DEVICE_LOST' as const;

export const attach: RideAttach = async (canvas, opts = {}) => {
  let currentConditions: unknown = opts.conditions;
  let currentInsets: unknown = opts.viewportInsets;
  const telemetry = createTelemetry(() => void frameOnce());
  canvas.setAttribute('data-backend', 'webgpu');

  const nav = (globalThis as unknown as { navigator?: { gpu?: GPU } }).navigator;

  // Scene state. On a device loss we dispose the current scene and try to
  // build a fresh one on the same canvas (D1-a). Everything in `scene`
  // lives on one GPUDevice; `attach` outlasts them.
  let scene: RideSceneHandle | null = null;
  let outerDisposed = false;
  let rafId: number | null = null;
  // Guards against overlapping reattach attempts: a flap of two `lost`
  // events in quick succession must still only trigger one retry.
  let reattachInFlight = false;

  const frameOnce = (): void => {
    scene?.frameOnce();
  };

  const startLoop = (): void => {
    if (opts.testMode) return;
    const loop = (): void => {
      if (outerDisposed) return;
      frameOnce();
      const raf = (globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number })
        .requestAnimationFrame;
      if (raf) {
        rafId = raf(loop);
      }
    };
    loop();
  };

  const cancelLoop = (): void => {
    if (rafId === null) return;
    const cancel = (globalThis as unknown as { cancelAnimationFrame?: (id: number) => void })
      .cancelAnimationFrame;
    cancel?.(rafId);
    rafId = null;
  };

  // #584 FR2 — expose a page-side helper so a Playwright spec can force a
  // device loss (there is no `WEBGL_lose_context` equivalent for WebGPU and
  // `GPUDevice.destroy()` must be called from inside the page). Gated on
  // `__PLAYWRIGHT_TESTING` (D4-a) so a shipped page can't call it.
  const installForceLostSeam = (device: GPUDevice): void => {
    const win = (globalThis as unknown as {
      window?: Record<string, unknown>;
    }).window;
    if (!win) return;
    if (!win[PLAYWRIGHT_TESTING_KEY]) return;
    win[FORCE_LOST_KEY] = () => {
      try {
        device.destroy();
      } catch {
        // destroy() can throw on an already-destroyed device; ignore.
      }
    };
  };
  const removeForceLostSeam = (): void => {
    const win = (globalThis as unknown as {
      window?: Record<string, unknown>;
    }).window;
    if (!win) return;
    delete win[FORCE_LOST_KEY];
  };

  // Device-loss handler. Called by `requestDevice`'s wiring when the
  // current device's `lost` promise resolves.
  //
  // D1-a (same canvas, rebuild internals) + D3-a (drop to
  // `renderer-unavailable` on the first failed retry). The first loss
  // disposes the current scene, publishes the "restoring" banner, flips
  // `__ROWER3D_CONTEXT_STATE.kind` to `'lost'`, and spins up a retry. A
  // second loss (either during retry setup or on the retry's own device)
  // publishes `renderer-unavailable` and stops drawing.
  const onDeviceLost = (reason: WebGPUFallbackReason | null): void => {
    if (outerDisposed) return;
    const current = scene;
    scene = null;
    if (reason === 'renderer-unavailable') {
      telemetry.contextState.kind = 'unavailable';
      telemetry.contextState.reason = 'renderer-unavailable';
      telemetry.contextState.backend = 'none';
      publishBanner(telemetry, BANNER_LOST_FAILED, 'failed');
      current?.dispose();
      cancelLoop();
      removeForceLostSeam();
      return;
    }
    // First loss. Mark lost, publish, and kick off a retry.
    telemetry.contextState.kind = 'lost';
    telemetry.contextState.reason = 'device-lost';
    publishFallback('device-lost');
    publishBanner(telemetry, BANNER_LOST_RESTORING, 'restoring');
    // Stop the outer loop so frameOnce doesn't try to run against a null
    // scene (frameOnce handles null anyway, but keeping the loop alive on
    // a dead device burns rAF ticks for no reason).
    cancelLoop();
    current?.dispose();
    removeForceLostSeam();
    void (async () => {
      if (reattachInFlight) return;
      reattachInFlight = true;
      try {
        const next = await buildScene(/* isRetry */ true);
        if (outerDisposed) {
          next?.dispose();
          return;
        }
        if (next) {
          scene = next;
          telemetry.contextState.kind = 'ready';
          telemetry.contextState.reason = undefined;
          telemetry.contextState.backend = 'webgpu';
          publishBanner(telemetry, '', '');
          installForceLostSeam(next.device);
          startLoop();
        }
        // On a null `next` the inner `requestDevice({ isRetry: true })`
        // has already run `onDeviceLost('renderer-unavailable')`, which
        // took the `'renderer-unavailable'` branch above — the banner
        // and context state are set there.
      } finally {
        reattachInFlight = false;
      }
    })();
  };

  const buildScene = async (isRetry: boolean): Promise<RideSceneHandle | null> => {
    const session: DeviceSession = await requestDevice(nav, {
      isRetry,
      onDeviceLost,
      // #737 FR5 — `?review=1` / `__VIRTUALROW_ALLOW_SOFTWARE` renders on SwiftShader.
      allowSoftware: softwareAttachRequested((globalThis as { window?: Window }).window),
    });
    if (session.state.kind !== 'ready') {
      const reason =
        session.state.kind === 'unavailable' ? session.state.reason : 'renderer-unavailable';
      publishFallback(reason);
      telemetry.contextState.kind = 'unavailable';
      telemetry.contextState.reason = reason;
      telemetry.contextState.backend = 'none';
      if (isRetry) {
        publishBanner(telemetry, BANNER_LOST_FAILED, 'failed');
      }
      return null;
    }
    // `opts.appearance` is `unknown` on the public attach surface so the
    // seam type stays framework-free; the scene types it as `CrewPalette`.
    // The cast lives here, at the one call site, instead of in every
    // smoke page that passes a palette through.
    // #730: a device-lost rebuild relights with the latest conditions, not
    // the ones the ride started with.
    const sceneOpts = { ...opts, conditions: currentConditions, viewportInsets: currentInsets } as unknown as Parameters<typeof createRideScene>[3];
    const handle = await createRideScene(canvas, session.state.device, telemetry, sceneOpts, session);
    // #803 — let the GPU process finish compiling and uploading before the
    // ride shows as ready, so the first strokes do not freeze behind it.
    // The host's loading screen hides the canvas until then too: the warm-up
    // draws on until it has gone, so the first uncovered presents happen
    // before ready (#803 D-a).
    if (handle) {
      await warmUpScene(handle, {
        timeoutMs: WARM_UP_TIMEOUT_MS,
        ...(opts.loadingOverlayShown ? { overlayShown: opts.loadingOverlayShown } : {}),
      });
    }
    return handle;
  };

  const initial = await buildScene(/* isRetry */ false);
  if (!initial) {
    releaseTelemetry(telemetry);
    canvas.removeAttribute('data-backend');
    return null;
  }
  scene = initial;
  telemetry.contextState.kind = 'ready';
  telemetry.contextState.backend = 'webgpu';
  installForceLostSeam(initial.device);

  // #737 VP-19 FR6 — a hidden tab stops the loop; coming back restarts it
  // and tells the scene to restart its simulation clocks rather than
  // fast-forward them over the hidden time (the "lurch" on return).
  const doc = (globalThis as unknown as { document?: Document }).document;
  const onVisibilityChange = (): void => {
    if (outerDisposed || !doc) return;
    if (doc.visibilityState === 'hidden') {
      cancelLoop();
      return;
    }
    scene?.resume();
    if (!opts.testMode && rafId === null) startLoop();
  };
  doc?.addEventListener('visibilitychange', onVisibilityChange);

  if (opts.testMode) {
    // In test mode we draw one frame and leave scheduling to the caller
    // via `__ROWER3D_FORCE_RENDER()`.
    frameOnce();
  } else {
    startLoop();
  }

  const renderer: RideRenderer & {
    _frameOnce: () => void;
    _telemetry: TelemetryHandles;
    /** Test-only — the current scene's `GPUDevice`, used by the device-lost
     *  specs to call the mock's `__triggerLost`. Live, not snapshotted:
     *  reads the current scene each time so a post-reattach test sees
     *  the retry device, not the dead one. */
    readonly _liveDevice: GPUDevice | undefined;
  } = {
    _frameOnce: frameOnce,
    _telemetry: telemetry,
    get _liveDevice() {
      return scene?.device;
    },
    setViewportInsets(insets) {
      currentInsets = insets;
      scene?.setViewportInsets(insets);
    },
    setConditions(conditions) {
      if (typeof conditions !== 'string') return;
      scene?.setConditions(conditions);
      if (isLightingConditions(conditions)) currentConditions = conditions;
    },
    setAppearance(palette) {
      // No-op when the scene is gone (dispose, device-lost second strike)
      // or when a caller handed us a non-CrewPalette-shaped object.
      scene?.setAppearance(palette as never);
    },
    dispose() {
      if (outerDisposed) return;
      outerDisposed = true;
      doc?.removeEventListener('visibilitychange', onVisibilityChange);
      cancelLoop();
      scene?.dispose();
      scene = null;
      removeForceLostSeam();
      releaseTelemetry(telemetry);
      canvas.removeAttribute('data-backend');
    },
  };
  return renderer;
};

export default attach;
