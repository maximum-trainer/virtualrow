import { describe, expect, it, vi } from 'vitest';
import { warmUpScene } from './warmUp';

const handle = (done: () => Promise<undefined>) => {
  const order: string[] = [];
  return {
    order,
    h: {
      device: { queue: { onSubmittedWorkDone: vi.fn(() => { order.push('wait'); return done(); }) } } as unknown as GPUDevice,
      frameOnce: vi.fn(() => order.push('frame')),
      resume: vi.fn(() => order.push('resume')),
    },
  };
};

describe('warmUpScene (#803)', () => {
  it('draws a frame, waits for the GPU to finish it, then restarts the clocks', async () => {
    const { h, order } = handle(() => Promise.resolve(undefined));
    await expect(warmUpScene(h, 1000)).resolves.toBe('drained');
    expect(order).toEqual(['frame', 'wait', 'resume']);
  });

  it('gives up waiting after the timeout instead of holding the ride back', async () => {
    vi.useFakeTimers();
    try {
      const { h, order } = handle(() => new Promise<undefined>(() => {}));
      const p = warmUpScene(h, 50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(p).resolves.toBe('timeout');
      expect(order).toEqual(['frame', 'wait', 'resume']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the wait on a device without onSubmittedWorkDone', async () => {
    const h = { device: { queue: {} } as unknown as GPUDevice, frameOnce: vi.fn(), resume: vi.fn() };
    await expect(warmUpScene(h, 1000)).resolves.toBe('skipped');
    expect(h.frameOnce).toHaveBeenCalledOnce();
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it('still resumes when the wait rejects (device lost mid warm-up)', async () => {
    const { h, order } = handle(() => Promise.reject(new Error('lost')));
    await expect(warmUpScene(h, 1000)).resolves.toBe('skipped');
    expect(order).toEqual(['frame', 'wait', 'resume']);
  });
});
