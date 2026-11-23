import { describe, expect, it, vi } from 'vitest';
import {
  distanceTicks,
  drawRouteMap,
  polylineLength,
  scheduleMapDraw,
  ROUTE_MAP_COLOURS,
  tickStepMetres,
  waterCorridorPx,
  type MetrePoint,
} from '../lib/ui/routeMapDraw';

/** A context that records every call and every style it was given. */
const recorder = () => {
  const calls: { op: string; args: unknown[]; fillStyle?: unknown; strokeStyle?: unknown; lineWidth?: number; font?: string }[] = [];
  const state: Record<string, unknown> = {};
  const gradient = { addColorStop: vi.fn() };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'createRadialGradient') return () => gradient;
      return (...args: unknown[]) => {
        calls.push({
          op: prop,
          args,
          fillStyle: target.fillStyle,
          strokeStyle: target.strokeStyle,
          lineWidth: target.lineWidth as number,
          font: target.font as string,
        });
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, texts: () => calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]) };
};

const boundsOf = (pts: MetrePoint[]) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
};

/** A 3.5 km dog-leg. */
const COURSE: MetrePoint[] = [
  { x: 0, y: 0 },
  { x: 2000, y: 0 },
  { x: 2000, y: 1500 },
];
const draw = (points: MetrePoint[], extra: { progressPercent?: number; highlightMode?: boolean } = {}) => {
  const r = recorder();
  drawRouteMap(r.ctx, { points, bounds: boundsOf(points), width: 400, height: 300, ...extra });
  return r;
};

describe('distance ticks (#738)', () => {
  it('places one tick per whole km along the course, not at the start or finish', () => {
    const ticks = distanceTicks(COURSE, 1000);
    expect(ticks.map((t) => t.km)).toEqual([1, 2, 3]);
    expect(ticks[0]).toMatchObject({ x: 1000, y: 0 });
    expect(ticks[1]).toMatchObject({ x: 2000, y: 0 });
    expect(ticks[2]).toMatchObject({ x: 2000, y: 1000 });
  });

  it('draws nothing for a single point or a non-positive step', () => {
    expect(distanceTicks([{ x: 0, y: 0 }], 1000)).toEqual([]);
    expect(distanceTicks(COURSE, 0)).toEqual([]);
  });

  it('widens the spacing so a long course has at most 40 ticks', () => {
    expect(tickStepMetres(2000)).toBe(1000);
    expect(tickStepMetres(40_000)).toBe(1000);
    expect(tickStepMetres(41_000)).toBe(2000);
    expect(tickStepMetres(150_000)).toBe(5000);
  });

  it('measures the polyline', () => {
    expect(polylineLength(COURSE)).toBe(3500);
  });
});

describe('drawRouteMap (#738)', () => {
  it('draws a blue water corridor wider than the route line', () => {
    const { calls } = draw(COURSE);
    const water = calls.find((c) => c.op === 'stroke' && c.strokeStyle === ROUTE_MAP_COLOURS.water);
    const line = calls.find((c) => c.op === 'stroke' && c.strokeStyle === ROUTE_MAP_COLOURS.route);
    expect(water).toBeDefined();
    expect(line).toBeDefined();
    expect(water!.lineWidth!).toBeGreaterThan(line!.lineWidth!);
  });

  it('keeps the water corridor readable at any scale', () => {
    expect(waterCorridorPx(0.001)).toBe(10);
    expect(waterCorridorPx(0.5)).toBe(20);
    expect(waterCorridorPx(10)).toBe(36);
    // A long river on the big preview: 3% of the short side.
    expect(waterCorridorPx(0.05, 600)).toBe(18);
  });

  it('labels the start, the finish, each km and the scale', () => {
    const texts = draw(COURSE).texts();
    expect(texts).toEqual(expect.arrayContaining(['Start', 'Finish', '1 km', '2 km', '3 km']));
    expect(texts.some((t) => typeof t === 'string' && /^\d+(\.\d)? (m|km)$/.test(t) && !['1 km', '2 km', '3 km'].includes(t))).toBe(true);
  });

  it('returns the labels it drew', () => {
    const r = recorder();
    expect(drawRouteMap(r.ctx, { points: COURSE, bounds: boundsOf(COURSE), width: 400, height: 300 })).toEqual([
      'Start',
      'Finish',
    ]);
  });

  it('gives a loop one shared start/finish label', () => {
    const loop = [...COURSE, { x: 0, y: 1500 }, { x: 0, y: 5 }];
    const texts = draw(loop).texts();
    expect(texts).toContain('Start / Finish');
    expect(texts).not.toContain('Start');
    expect(texts).not.toContain('Finish');
  });

  it('keeps the minimap lean: start/finish labels, no km numbers, no scale bar', () => {
    const { texts, calls } = draw(COURSE, { highlightMode: true });
    expect(texts()).toEqual(['Start', 'Finish']);
    expect(calls.some((c) => c.op === 'fillRect' && c.fillStyle === 'rgba(255, 255, 255, 0.9)')).toBe(false);
  });

  it('splits the line at the rower’s progress', () => {
    const { calls } = draw(COURSE, { progressPercent: 50 });
    const strokes = calls.filter((c) => c.op === 'stroke').map((c) => c.strokeStyle);
    expect(strokes).toContain(ROUTE_MAP_COLOURS.completed);
    expect(strokes).toContain(ROUTE_MAP_COLOURS.remaining);
    expect(strokes).not.toContain(ROUTE_MAP_COLOURS.route);
  });

  it('draws the same picture every time (no random texture)', () => {
    const a = draw(COURSE).calls.map((c) => JSON.stringify(c));
    const b = draw(COURSE).calls.map((c) => JSON.stringify(c));
    expect(a).toEqual(b);
  });

  it('draws nothing for a route with fewer than two points', () => {
    expect(draw([{ x: 0, y: 0 }]).calls).toEqual([]);
  });
});

describe('scheduleMapDraw (#729)', () => {
  it('runs the draw later, as its own task, and can be cancelled', async () => {
    const draw = vi.fn();
    scheduleMapDraw(draw);
    expect(draw).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(draw).toHaveBeenCalledOnce());

    const cancelled = vi.fn();
    scheduleMapDraw(cancelled)();
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('uses idle time when the browser has it', () => {
    const g = globalThis as Record<string, unknown>;
    const ric = vi.fn(() => 7);
    const cic = vi.fn();
    g.requestIdleCallback = ric;
    g.cancelIdleCallback = cic;
    try {
      const draw = vi.fn();
      const cancel = scheduleMapDraw(draw);
      expect(ric).toHaveBeenCalledWith(draw, { timeout: 200 });
      cancel();
      expect(cic).toHaveBeenCalledWith(7);
    } finally {
      delete g.requestIdleCallback;
      delete g.cancelIdleCallback;
    }
  });
});
