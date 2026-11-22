import { describe, it, expect, vi } from 'vitest';
import { HUD_OCCLUDER_SELECTOR, observeHudInsets } from '../lib/ui/hudInsets';

// #733 VP-15 FR1 — the ride view watches the HUD panels over the stage and
// tells the engine which part of the canvas they cover.

const rect = (el: Element, r: { left: number; top: number; right: number; bottom: number }): void => {
  el.getBoundingClientRect = () =>
    ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r }) as DOMRect;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('observeHudInsets', () => {
  it('reports the insets at once, and again when a panel appears or goes', async () => {
    const stage = document.createElement('div');
    document.body.append(stage);
    rect(stage, { left: 0, top: 0, right: 1280, bottom: 720 });
    const strip = document.createElement('div');
    strip.className = 'row-hud-strip';
    rect(strip, { left: 0, top: 560, right: 1280, bottom: 720 });
    stage.append(strip);

    const seen: number[] = [];
    const stop = observeHudInsets(stage, (i) => seen.push(i.bottom));
    expect(seen).toEqual([160]);

    const block = document.createElement('div');
    block.className = 'workout-block-panel';
    rect(block, { left: 0, top: 420, right: 1280, bottom: 560 });
    stage.append(block);
    await flush();
    expect(seen.at(-1)).toBe(300);

    block.remove();
    await flush();
    expect(seen.at(-1)).toBe(160);

    stop();
    stage.append(block);
    await flush();
    expect(seen.at(-1)).toBe(160);
    stage.remove();
  });

  it('re-measures on window resize and fullscreen changes, and only reports changes', async () => {
    const stage = document.createElement('div');
    document.body.append(stage);
    rect(stage, { left: 0, top: 0, right: 1280, bottom: 720 });
    const strip = document.createElement('div');
    strip.className = 'row-hud-strip';
    rect(strip, { left: 0, top: 560, right: 1280, bottom: 720 });
    stage.append(strip);
    const onChange = vi.fn();
    const stop = observeHudInsets(stage, onChange);
    window.dispatchEvent(new Event('resize'));
    expect(onChange).toHaveBeenCalledTimes(1);
    rect(stage, { left: 0, top: 0, right: 1920, bottom: 1080 });
    rect(strip, { left: 0, top: 900, right: 1920, bottom: 1080 });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0].bottom).toBe(180);
    expect(onChange.mock.calls[1][1]).toBe(1080);
    stop();
    stage.remove();
  });

  it('watches the panels the issue names', () => {
    for (const cls of ['.row-hud-strip', '.workout-block-panel', '.row-hud-gap', '.row-hud-lap']) {
      expect(HUD_OCCLUDER_SELECTOR).toContain(cls);
    }
  });
});
