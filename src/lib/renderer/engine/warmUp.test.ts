import { describe, expect, it, vi } from 'vitest';
import { warmUpScene } from './warmUp';

/** A scene whose GPU takes `drainMs[i]` to finish frame i, on a fake clock. */
const scene = (drainMs: number[] | ((i: number) => number | 'never' | 'reject')) => {
  let clock = 0;
  let frames = 0;
  const order: string[] = [];
  const costOf = (i: number) => (typeof drainMs === 'function' ? drainMs(i) : (drainMs[i] ?? 0));
  const h = {
    device: {
      queue: {
        onSubmittedWorkDone: vi.fn(() => {
          order.push('wait');
          const cost = costOf(frames - 1);
          if (cost === 'never') return new Promise<undefined>(() => {});
          if (cost === 'reject') return Promise.reject(new Error('lost'));
          clock += cost;
          return Promise.resolve(undefined);
        }),
      },
    } as unknown as GPUDevice,
    frameOnce: vi.fn(() => {
      frames += 1;
      order.push('frame');
    }),
    resume: vi.fn(() => order.push('resume')),
  };
  return { h, order, now: () => clock, frames: () => frames };
};

describe('warmUpScene (#803)', () => {
  it('keeps drawing until the GPU finishes two frames quickly in a row, then restarts the clocks', async () => {
    const s = scene([300, 120, 10, 200, 5, 4]);
    await expect(warmUpScene(s.h, { timeoutMs: 3000, now: s.now })).resolves.toBe('drained');
    // 300 slow, 120 slow, 10 quick, 200 slow (resets), 5 quick, 4 quick -> done after 6 frames.
    expect(s.frames()).toBe(6);
    expect(s.order.at(-1)).toBe('resume');
  });

  it('stops after the first two frames when the GPU is already idle', async () => {
    const s = scene(() => 1);
    await expect(warmUpScene(s.h, { timeoutMs: 3000, now: s.now })).resolves.toBe('drained');
    expect(s.order).toEqual(['frame', 'wait', 'frame', 'wait', 'resume']);
  });

  it('gives up once the warm-up has taken longer than the cap', async () => {
    const s = scene(() => 400);
    await expect(warmUpScene(s.h, { timeoutMs: 1000, now: s.now })).resolves.toBe('timeout');
    expect(s.frames()).toBe(3);
    expect(s.h.resume).toHaveBeenCalledOnce();
  });

  it('gives up on a wait that never resolves instead of holding the ride back', async () => {
    vi.useFakeTimers();
    try {
      const s = scene(() => 'never');
      const p = warmUpScene(s.h, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(p).resolves.toBe('timeout');
      expect(s.order).toEqual(['frame', 'wait', 'resume']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws one frame and skips the wait on a device without onSubmittedWorkDone', async () => {
    const h = { device: { queue: {} } as unknown as GPUDevice, frameOnce: vi.fn(), resume: vi.fn() };
    await expect(warmUpScene(h, { timeoutMs: 1000 })).resolves.toBe('skipped');
    expect(h.frameOnce).toHaveBeenCalledOnce();
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it('still resumes when a wait rejects (device lost mid warm-up)', async () => {
    const s = scene(() => 'reject');
    await expect(warmUpScene(s.h, { timeoutMs: 1000, now: s.now })).resolves.toBe('skipped');
    expect(s.order).toEqual(['frame', 'wait', 'resume']);
  });
});
