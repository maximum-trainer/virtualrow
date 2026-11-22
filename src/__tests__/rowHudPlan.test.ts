import { describe, it, expect } from 'vitest';

import { metricTiles, HUD_METRIC_LABEL, WIDE_HUD_MIN_PX } from '../lib/ui/rowHudPlan';

// #542 P1 workout view: which HUD tiles show is a function of the viewport,
// ported verbatim from rowHudPlan.ts.
describe('rowHudPlan.metricTiles', () => {
  it('shows all six tiles at or above the wide threshold', () => {
    expect(metricTiles(WIDE_HUD_MIN_PX)).toEqual(['split', 'spm', 'power', 'hr', 'distance', 'time']);
    expect(metricTiles(1280)).toEqual(['split', 'spm', 'power', 'hr', 'distance', 'time']);
  });

  it('drops power and time to four tiles below the wide threshold', () => {
    expect(metricTiles(WIDE_HUD_MIN_PX - 1)).toEqual(['split', 'spm', 'hr', 'distance']);
    expect(metricTiles(390)).toEqual(['split', 'spm', 'hr', 'distance']);
  });

  it('labels every metric with its unit', () => {
    expect(HUD_METRIC_LABEL).toEqual({
      split: 'Split (/500m)',
      spm: 'SPM',
      power: 'Power (W)',
      hr: 'Heart Rate (bpm)',
      distance: 'Meters',
      time: 'Time',
    });
  });
});

// #733 VP-15 — the HUD tells the engine which part of the stage it covers.
describe('hudInsetsFromRects (#733 FR1)', () => {
  const stage = { left: 0, top: 100, right: 1280, bottom: 820 };

  it('is no insets when nothing covers the stage', async () => {
    const { hudInsetsFromRects } = await import('../lib/ui/rowHudPlan');
    expect(hudInsetsFromRects(stage, [])).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('takes the bottom inset from the highest panel in the lower half', async () => {
    const { hudInsetsFromRects } = await import('../lib/ui/rowHudPlan');
    const strip = { left: 0, top: 640, right: 1280, bottom: 820 };
    const block = { left: 0, top: 500, right: 1280, bottom: 640 };
    const gap = { left: 500, top: 470, right: 780, bottom: 495 };
    expect(hudInsetsFromRects(stage, [strip, block, gap]).bottom).toBe(820 - 470);
  });

  it('takes the top inset from panels in the upper half', async () => {
    const { hudInsetsFromRects } = await import('../lib/ui/rowHudPlan');
    const banner = { left: 0, top: 100, right: 1280, bottom: 160 };
    expect(hudInsetsFromRects(stage, [banner])).toEqual({ top: 60, right: 0, bottom: 0, left: 0 });
  });

  it('ignores hidden (zero-size) and off-stage elements', async () => {
    const { hudInsetsFromRects } = await import('../lib/ui/rowHudPlan');
    const hidden = { left: 0, top: 0, right: 0, bottom: 0 };
    const below = { left: 0, top: 900, right: 1280, bottom: 950 };
    expect(hudInsetsFromRects(stage, [hidden, below]).bottom).toBe(0);
  });
});

describe('compact HUD (#733 FR4)', () => {
  it('compacts on stages shorter than 800 px', async () => {
    const { COMPACT_HUD_MAX_STAGE_PX, isCompactHud } = await import('../lib/ui/rowHudPlan');
    expect(COMPACT_HUD_MAX_STAGE_PX).toBe(800);
    expect(isCompactHud(799)).toBe(true);
    expect(isCompactHud(800)).toBe(false);
    expect(isCompactHud(0)).toBe(false);
  });
});
