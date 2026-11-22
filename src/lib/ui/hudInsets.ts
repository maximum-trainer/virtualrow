/**
 * Watch the HUD panels drawn over the ride stage and report which part of it
 * they cover (#733 VP-15 FR1). The ride view hands the result to the engine,
 * which frames the boat in what is left.
 *
 * Re-measures when the stage or a panel resizes, when a panel is added or
 * removed (the workout block shows and hides), on window resize and on
 * fullscreen changes. Reports only when the insets or the stage height
 * actually change; the height drives the compact HUD (FR4).
 */
import { hudInsetsFromRects, type HudInsets, type HudRect } from './rowHudPlan';

/** The panels that sit over the 3D view. Existing class names (FR5). */
export const HUD_OCCLUDER_SELECTOR = '.row-hud-strip, .workout-block-panel, .row-hud-gap, .row-hud-lap';

const toRect = (el: Element): HudRect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

export const observeHudInsets = (
  stage: HTMLElement,
  onChange: (insets: HudInsets, stageHeight: number) => void,
): (() => void) => {
  let last = '';
  let stopped = false;
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
  const watched = new Set<Element>();

  const rebind = (panels: Element[]): void => {
    if (!resize) return;
    for (const el of panels) {
      if (!watched.has(el)) {
        resize.observe(el);
        watched.add(el);
      }
    }
    for (const el of [...watched]) {
      if (el !== stage && !panels.includes(el)) {
        resize.unobserve(el);
        watched.delete(el);
      }
    }
  };

  function measure(): void {
    if (stopped) return;
    const panels = Array.from(stage.querySelectorAll(HUD_OCCLUDER_SELECTOR));
    rebind(panels);
    const stageRect = toRect(stage);
    const insets = hudInsetsFromRects(stageRect, panels.map(toRect));
    const stageHeight = stageRect.bottom - stageRect.top;
    const key = `${insets.top},${insets.right},${insets.bottom},${insets.left},${stageHeight}`;
    if (key === last) return;
    last = key;
    onChange(insets, stageHeight);
  }

  resize?.observe(stage);
  watched.add(stage);
  const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => measure());
  mutations?.observe(stage, { childList: true, subtree: true });
  window.addEventListener('resize', measure);
  document.addEventListener('fullscreenchange', measure);
  measure();

  return () => {
    stopped = true;
    resize?.disconnect();
    mutations?.disconnect();
    window.removeEventListener('resize', measure);
    document.removeEventListener('fullscreenchange', measure);
  };
};
