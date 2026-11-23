/**
 * #729 (Dan's choice, 2026-11-23) — a Svelte action for the buttons that
 * start a row. When the pointer reaches the button, or it takes focus, or a
 * touch begins on it, ask for the GPU device ahead of time (`prewarmDevice`),
 * so Chrome's synchronous adapter/device work happens before the click and
 * not in the first frames of the ride. The GPU only wakes when a ride is
 * likely, not on every visit.
 */

import { prewarmDevice } from '../renderer/engine/device';

const INTENT_EVENTS = ['pointerenter', 'focus', 'pointerdown', 'touchstart'] as const;

export const prewarmGpuOnIntent = (
  node: HTMLElement,
  nav: { gpu?: GPU } | undefined = typeof navigator === 'undefined' ? undefined : navigator,
) => {
  const onIntent = () => prewarmDevice(nav);
  for (const type of INTENT_EVENTS) node.addEventListener(type, onIntent, { passive: true });
  return {
    destroy() {
      for (const type of INTENT_EVENTS) node.removeEventListener(type, onIntent);
    },
  };
};
