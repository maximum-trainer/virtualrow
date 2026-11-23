/**
 * #731 VP-13 FR1/FR2/FR4 — the canvas backing store follows the display's
 * device pixel ratio, within the tier's cap and pixel ceiling.
 */

import type { BuildingTierCaps } from './tierCaps';
import type { AntialiasMode } from './msaa';

export type SurfaceCaps = Pick<BuildingTierCaps, 'maxPixelRatio' | 'maxBackingPixels'>;

export interface BackingSize {
  /** Backing pixels per CSS pixel actually used. */
  scale: number;
  width: number;
  height: number;
}

/**
 * The backing size for a `cssWidth` x `cssHeight` canvas on a display of
 * `dpr`: CSS size x min(dpr, cap). Over the tier's pixel ceiling the scale
 * is lowered to fit (never cropped), but not below 1 (or the dpr, if that
 * is lower): a big monitor keeps the resolution it had before #731.
 */
export const backingSizeFor = (
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  caps: SurfaceCaps,
): BackingSize => {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const floor = Math.min(1, ratio);
  let scale = Math.min(ratio, caps.maxPixelRatio);
  // Over the ceiling, round down so the backing area stays inside it; the
  // scale never drops below min(1, dpr), so the size stays at the CSS size.
  let round = Math.round;
  if (w * h * scale * scale > caps.maxBackingPixels) {
    scale = Math.max(floor, Math.sqrt(caps.maxBackingPixels / (w * h)));
    round = Math.floor;
  }
  return {
    scale,
    width: Math.max(1, round(w * scale)),
    height: Math.max(1, round(h * scale)),
  };
};

/** What `__ROWER3D_SURFACE` publishes (FR4). */
export interface Rower3DSurface {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  scale: number;
  width: number;
  height: number;
  antialias: AntialiasMode;
}

/**
 * FR2 — the latest size a ResizeObserver reported for the canvas, read once
 * a frame. `devicePixels` is the exact device-pixel box where the browser
 * reports `devicePixelContentBoxSize`; with a scale equal to the dpr the
 * backing store takes it as-is, so a fractional dpr lands on whole pixels.
 */
export interface ObservedCanvasSize {
  cssWidth: number;
  cssHeight: number;
  devicePixels: { width: number; height: number } | null;
}

export const observeCanvasSize = (
  canvas: HTMLCanvasElement,
  onChange: (size: ObservedCanvasSize) => void,
): (() => void) => {
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (!RO) return () => undefined;
  const observer = new RO((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const box = entry.contentBoxSize?.[0];
    const dev = entry.devicePixelContentBoxSize?.[0];
    onChange({
      cssWidth: box ? box.inlineSize : entry.contentRect.width,
      cssHeight: box ? box.blockSize : entry.contentRect.height,
      devicePixels: dev ? { width: dev.inlineSize, height: dev.blockSize } : null,
    });
  });
  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas);
  }
  return () => observer.disconnect();
};

/** FR1 + FR2: the backing size for an observed canvas. */
export const backingSizeForObserved = (
  observed: ObservedCanvasSize,
  dpr: number,
  caps: SurfaceCaps,
): BackingSize => {
  const size = backingSizeFor(observed.cssWidth, observed.cssHeight, dpr, caps);
  if (observed.devicePixels && Math.abs(size.scale - dpr) < 1e-6) {
    return { scale: size.scale, width: Math.max(1, observed.devicePixels.width), height: Math.max(1, observed.devicePixels.height) };
  }
  return size;
};
