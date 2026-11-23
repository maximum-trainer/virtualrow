import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prewarmDevice = vi.fn();
vi.mock('../lib/renderer/engine/device', () => ({ prewarmDevice: (nav: unknown) => prewarmDevice(nav) }));

import { prewarmGpuOnIntent } from '../lib/ui/prewarmGpuOnIntent';

describe('prewarmGpuOnIntent (#729)', () => {
  beforeEach(() => prewarmDevice.mockClear());
  afterEach(() => document.body.replaceChildren());

  it.each(['pointerenter', 'focus', 'pointerdown', 'touchstart'])(
    'asks for the GPU device on %s',
    (type) => {
      const button = document.createElement('button');
      document.body.append(button);
      const nav = { gpu: {} as GPU };
      prewarmGpuOnIntent(button, nav);
      button.dispatchEvent(new Event(type));
      expect(prewarmDevice).toHaveBeenCalledWith(nav);
    },
  );

  it('does nothing until the user shows intent, and stops listening when destroyed', () => {
    const button = document.createElement('button');
    const action = prewarmGpuOnIntent(button, { gpu: {} as GPU });
    expect(prewarmDevice).not.toHaveBeenCalled();
    action.destroy();
    button.dispatchEvent(new Event('pointerenter'));
    expect(prewarmDevice).not.toHaveBeenCalled();
  });
});
