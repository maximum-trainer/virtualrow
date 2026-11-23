/**
 * #803 — warm the GPU up before the ride shows as ready.
 *
 * Creating a scene queues a few hundred milliseconds of work in the
 * browser's GPU process (Chrome compiles every pipeline there, behind the
 * page's back). Until it drains, the first frames of the row queue behind
 * it and the screen freezes for 400–700 ms (measured on an NVIDIA laptop,
 * Windows / D3D12, at basic and medium). Drawing one frame and waiting for
 * the GPU to finish it moves that wait onto the loading screen.
 *
 * The wait is capped so a slow or wedged driver cannot hold the ride back,
 * and the simulation clocks restart afterwards so the warm-up time is not
 * fast-forwarded into the first stroke.
 */
export interface WarmUpTarget {
  readonly device: GPUDevice;
  frameOnce(): void;
  resume(): void;
}

export type WarmUpResult = 'drained' | 'timeout' | 'skipped';

export async function warmUpScene(scene: WarmUpTarget, timeoutMs: number): Promise<WarmUpResult> {
  scene.frameOnce();
  let result: WarmUpResult = 'skipped';
  const queue = scene.device.queue as Partial<GPUQueue> | undefined;
  if (typeof queue?.onSubmittedWorkDone === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        queue.onSubmittedWorkDone.call(queue).then(() => 'drained' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
    } catch {
      result = 'skipped';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  scene.resume();
  return result;
}
