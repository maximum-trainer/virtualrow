/**
 * Drawing for the 2D route map (#738).
 *
 * The Row-screen preview and the in-ride minimap (`RouteMap.svelte`) have no
 * tile source, by design: the demo route and guests must work with no external
 * map data. They used to draw the route over a flat green rectangle (plus 200
 * random dots, redrawn differently on every resize). They now draw a vector
 * map from data already in memory: the bank in green, the water corridor
 * along the route in blue, the route line, start/finish markers with labels,
 * distance ticks along the course, and a scale bar.
 *
 * Kept free of Svelte so the drawing can be asserted against a recording
 * context.
 */

import { createRouteMapTransform, type RouteMetreBounds } from '../../components/routeMapProjection';

export interface MetrePoint {
  x: number;
  y: number;
}

export interface RouteMapDrawInput {
  points: readonly MetrePoint[];
  bounds: RouteMetreBounds;
  width: number;
  height: number;
  /** 0-100; splits the line into completed/remaining when > 0. */
  progressPercent?: number;
  /** The in-ride minimap: small, no scale bar, no tick numbers. */
  highlightMode?: boolean;
}

export const ROUTE_MAP_COLOURS = {
  bank: '#5a7d5a',
  bankEdge: '#4a6a4a',
  water: '#4f97c9',
  waterEdge: '#3a7fb0',
  route: '#1e3a8a',
  completed: '#ef4444',
  remaining: '#22c55e',
  start: '#22c55e',
  finish: '#ef4444',
  tickEdge: '#1f2937',
  label: '#ffffff',
  labelHalo: 'rgba(17, 24, 39, 0.85)',
} as const;

/** Nominal river width drawn under the route, in metres. */
export const WATER_CORRIDOR_M = 40;
const WATER_MIN_PX = 10;
const WATER_MAX_PX = 36;

/**
 * Width in pixels of the water corridor at a given pixels-per-metre scale.
 * At least 3% of the canvas's short side (and 10 px), so a long river on the
 * large preview still reads as water rather than a thin outline.
 */
export const waterCorridorPx = (scale: number, canvasShortSide = 0): number =>
  Math.min(WATER_MAX_PX, Math.max(WATER_MIN_PX, canvasShortSide * 0.03, WATER_CORRIDOR_M * scale));

/** Tick spacing in metres: 1 km, widened so a long route has at most 40 ticks. */
export const tickStepMetres = (lengthM: number): number => {
  for (const step of [1000, 2000, 5000, 10000, 20000, 50000]) {
    if (lengthM / step <= 40) return step;
  }
  return 100000;
};

export interface DistanceTick {
  x: number;
  y: number;
  /** Distance from the start, in km. */
  km: number;
}

/**
 * Points every `stepM` metres along the polyline, measured from the start.
 * The start (0 km) and anything at or past the end are left out: those are
 * the start and finish markers.
 */
export const distanceTicks = (points: readonly MetrePoint[], stepM: number): DistanceTick[] => {
  const ticks: DistanceTick[] = [];
  if (points.length < 2 || !(stepM > 0)) return ticks;
  let travelled = 0;
  let next = stepM;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg <= 0) continue;
    while (travelled + seg > next) {
      const t = (next - travelled) / seg;
      ticks.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, km: next / 1000 });
      next += stepM;
    }
    travelled += seg;
  }
  return ticks;
};

export const polylineLength = (points: readonly MetrePoint[]): number => {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
};

/** Start and finish closer than this many pixels share one label. */
const SHARED_LABEL_PX = 24;

const formatKm = (km: number) => (Number.isInteger(km) ? `${km}` : km.toFixed(1));

const tracePath = (
  ctx: CanvasRenderingContext2D,
  pts: readonly { x: number; y: number }[],
  from = 0,
  to = pts.length - 1,
) => {
  ctx.beginPath();
  ctx.moveTo(pts[from].x, pts[from].y);
  for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i].x, pts[i].y);
};

const strokeLine = (ctx: CanvasRenderingContext2D, colour: string, width: number) => {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
};

const haloText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
) => {
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = ROUTE_MAP_COLOURS.labelHalo;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = ROUTE_MAP_COLOURS.label;
  ctx.fillText(text, x, y);
};

const marker = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
};

/**
 * Draw the whole map. Returns the text labels drawn (start/finish), so the
 * component can expose them to tests; a route with < 2 points draws nothing.
 */
export const drawRouteMap = (ctx: CanvasRenderingContext2D, input: RouteMapDrawInput): string[] => {
  const { points, bounds, width, height, progressPercent: progress, highlightMode } = input;
  if (points.length < 2) return [];

  const { toCanvas, scale, padding } = createRouteMapTransform(bounds, { width, height });
  const px = points.map((p) => toCanvas(p.x, p.y));
  const last = px.length - 1;

  ctx.clearRect(0, 0, width, height);

  // Bank.
  const bank = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height));
  bank.addColorStop(0, '#6b8e6b');
  bank.addColorStop(0.5, ROUTE_MAP_COLOURS.bank);
  bank.addColorStop(1, ROUTE_MAP_COLOURS.bankEdge);
  ctx.fillStyle = bank;
  ctx.fillRect(0, 0, width, height);

  // Water corridor: an edge stroke, then the water on top of it.
  const water = waterCorridorPx(scale, Math.min(width, height));
  tracePath(ctx, px);
  strokeLine(ctx, ROUTE_MAP_COLOURS.waterEdge, water + 3);
  tracePath(ctx, px);
  strokeLine(ctx, ROUTE_MAP_COLOURS.water, water);

  // Route line, split at the rower's progress when there is any.
  const splitIndex =
    progress !== undefined && progress > 0
      ? Math.min(Math.floor((progress / 100) * points.length), last)
      : 0;
  if (splitIndex > 0) {
    tracePath(ctx, px, 0, splitIndex);
    strokeLine(ctx, ROUTE_MAP_COLOURS.completed, 4);
    if (splitIndex < last) {
      tracePath(ctx, px, splitIndex, last);
      strokeLine(ctx, ROUTE_MAP_COLOURS.remaining, 4);
    }
  } else {
    tracePath(ctx, px);
    strokeLine(ctx, ROUTE_MAP_COLOURS.route, 3);
  }

  // Distance ticks.
  const ticks = distanceTicks(points, tickStepMetres(polylineLength(points)));
  for (const tick of ticks) {
    const p = toCanvas(tick.x, tick.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, highlightMode ? 2 : 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = ROUTE_MAP_COLOURS.tickEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (!highlightMode) haloText(ctx, `${formatKm(tick.km)} km`, p.x, p.y - 7, '10px sans-serif');
  }

  // Start and finish.
  const start = px[0];
  const end = px[last];
  marker(ctx, end.x, end.y, 8, ROUTE_MAP_COLOURS.finish);
  marker(ctx, start.x, start.y, 8, ROUTE_MAP_COLOURS.start);
  const labelFont = highlightMode ? 'bold 10px sans-serif' : 'bold 12px sans-serif';
  const labels: string[] = [];
  if (Math.hypot(end.x - start.x, end.y - start.y) < SHARED_LABEL_PX) {
    haloText(ctx, 'Start / Finish', start.x, start.y - 12, labelFont);
    labels.push('Start / Finish');
  } else {
    haloText(ctx, 'Start', start.x, start.y - 12, labelFont);
    haloText(ctx, 'Finish', end.x, end.y - 12, labelFont);
    labels.push('Start', 'Finish');
  }

  // The rower's position.
  if (splitIndex > 0) {
    const current = px[splitIndex];
    marker(ctx, current.x, current.y, 10, '#fbbf24');
    ctx.beginPath();
    ctx.arc(current.x, current.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
  }

  // Scale bar.
  if (!highlightMode) {
    const barWidth = 100;
    const metres = barWidth / scale;
    const x = width - padding - barWidth;
    const y = height - 20;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(x - 10, y - 20, barWidth + 20, 30);
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + barWidth, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.moveTo(x + barWidth, y - 5);
    ctx.lineTo(x + barWidth, y + 5);
    ctx.stroke();
    ctx.fillStyle = '#374151';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`, x + barWidth / 2, y - 8);
  }
  return labels;
};

/**
 * #729: run a map draw as its own task, in idle time (at most ~200 ms late),
 * so it never lands inside a navigation or the ride's first frames. Returns a
 * cancel.
 */
export const scheduleMapDraw = (draw: () => void): (() => void) => {
  const g = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof g.requestIdleCallback === 'function' && typeof g.cancelIdleCallback === 'function') {
    const id = g.requestIdleCallback(draw, { timeout: 200 });
    return () => g.cancelIdleCallback?.(id);
  }
  const id = setTimeout(draw, 0);
  return () => clearTimeout(id);
};
