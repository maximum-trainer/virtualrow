/**
 * #803 — warm the GPU up before the ride shows as ready.
 *
 * Creating a scene queues a few hundred milliseconds of work in the
 * browser's GPU process (Chrome compiles pipelines there, behind the page's
 * back). Until it drains, the first frames of the row queue behind it and
 * the screen freezes for 400–700 ms (measured on an NVIDIA laptop,
 * Windows / D3D12, at basic and medium).
 *
 * One frame and one wait was not enough on that laptop (stalls fell to
 * 230–330 ms but stayed), so the warm-up keeps drawing and waiting until
 * the GPU finishes a frame quickly twice in a row: that is when no
 * deferred work is left in front of the row.
 *
 * Then, while the loading screen still covers the canvas, it keeps drawing
 * one frame per animation frame until the screen has gone, and a few more
 * after that. Windows sets up the canvas's swap chain and overlay on the
 * first presents after nothing covers it, and that Present can block the
 * GPU process for 120-400 ms; this puts it on the loading screen too.
 *
 * The whole warm-up is capped so a slow or wedged driver cannot hold the
 * ride back, and the simulation clocks restart afterwards so the warm-up
 * time is not fast-forwarded into the first stroke.
 */
export interface WarmUpTarget {
  readonly device: GPUDevice;
  frameOnce(): void;
  resume(): void;
}

export type WarmUpResult = 'drained' | 'timeout' | 'skipped';

export interface WarmUpOptions {
  /** The longest the whole warm-up may take. */
  timeoutMs: number;
  /** A frame the GPU finishes within this counts as quick. Default 25 ms. */
  quickMs?: number;
  /** Quick frames in a row that end the warm-up. Default 2. */
  quickFrames?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** True while the loading screen covers the canvas. Omitted = never. */
  overlayShown?: () => boolean;
  /** Frames presented uncovered after the overlay goes. Default 3. */
  settleFrames?: number;
  /** Waits for the next animation frame. Default requestAnimationFrame. */
  nextFrame?: () => Promise<void>;
}

const animationFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });

export async function warmUpScene(scene: WarmUpTarget, opts: WarmUpOptions): Promise<WarmUpResult> {
  const now = opts.now ?? (() => performance.now());
  const quickMs = opts.quickMs ?? 25;
  const quickFrames = opts.quickFrames ?? 2;
  const queue = scene.device.queue as Partial<GPUQueue> | undefined;
  const start = now();
  let result: WarmUpResult = 'skipped';
  let quick = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
  });
  try {
    for (;;) {
      scene.frameOnce();
      if (typeof queue?.onSubmittedWorkDone !== 'function') break;
      const t = now();
      const r = await Promise.race([queue.onSubmittedWorkDone.call(queue).then(() => 'done' as const), deadline]);
      if (r === 'timeout') {
        result = 'timeout';
        break;
      }
      quick = now() - t <= quickMs ? quick + 1 : 0;
      if (quick >= quickFrames) {
        result = 'drained';
        break;
      }
      if (now() - start >= opts.timeoutMs) {
        result = 'timeout';
        break;
      }
    }
    if (result !== 'timeout' && opts.overlayShown?.()) {
      const nextFrame = opts.nextFrame ?? animationFrame;
      const timedOut = () => now() - start >= opts.timeoutMs;
      do {
        await nextFrame();
        scene.frameOnce();
        if (timedOut()) result = 'timeout';
      } while (result !== 'timeout' && opts.overlayShown());
      for (let i = 0; result !== 'timeout' && i < (opts.settleFrames ?? 3); i += 1) {
        await nextFrame();
        scene.frameOnce();
        if (timedOut()) result = 'timeout';
      }
    }
  } catch {
    result = 'skipped';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  scene.resume();
  return result;
}
