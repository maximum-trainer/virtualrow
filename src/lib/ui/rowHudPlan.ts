/**
 * Which metrics go on the stage, and what they are called (#335).
 *
 * The row screen used to put eight cards in a panel *below* the canvas. On a
 * phone propped against an erg that panel is below the fold, so the numbers a
 * rower is rowing to were the one thing they could not see. The strip is on the
 * stage now, and a stage is only so wide: six tiles at 32px are legible on a
 * laptop and unreadable on a 390px phone.
 *
 * So the tile list is a function of the viewport rather than a constant, and it
 * lives here rather than in the component because "which numbers matter when
 * there is only room for four" is a decision worth testing on its own.
 *
 * Average and maximum heart rate are not on either list. They are summaries of
 * a row, not instruments to row by, and both already appear on the summary
 * screen the row ends at.
 */

/** A number the strip can show. The keys, not the labels — those are below. */
export type HudMetric = 'split' | 'spm' | 'power' | 'hr' | 'distance' | 'time';

/**
 * The narrowest stage that still fits six tiles.
 *
 * Six tiles at the 11px label and 32px value the design asks for need about
 * 150px each before the value starts to truncate; 900px is that with the
 * stage's own insets.
 */
export const WIDE_HUD_MIN_PX = 900;

/** Everything, in the order a rower scans it: pace first, time last. */
const WIDE: readonly HudMetric[] = ['split', 'spm', 'power', 'hr', 'distance', 'time'];

/**
 * The four that survive a phone.
 *
 * Power and elapsed time go. Power because it is a restatement of the split
 * that the split says better, and time because a rower on a phone is looking at
 * the boat, not clock-watching - and both are on the summary.
 */
const NARROW: readonly HudMetric[] = ['split', 'spm', 'hr', 'distance'];

export const metricTiles = (viewportWidth: number): readonly HudMetric[] =>
  viewportWidth >= WIDE_HUD_MIN_PX ? WIDE : NARROW;

/**
 * What each tile is called on screen, and what it is measured in.
 *
 * The wording is the wording the panel below the stage had - it reads as a
 * label rather than an abbreviation, so a rower who has used the app before
 * does not have to re-learn the screen to find the number they were watching.
 *
 * The unit is here rather than beside the number because #344 puts the values
 * at 32px, and at that size `187 W` does not fit a tile on a 320px phone. Said
 * once, in the label, it is also said to a screen reader once - where `187 W`
 * under a heading of `Power` said watts twice and `3 m` said metres twice.
 */
export const HUD_METRIC_LABEL: Record<HudMetric, string> = {
  split: 'Split (/500m)',
  spm: 'SPM',
  power: 'Power (W)',
  hr: 'Heart Rate (bpm)',
  distance: 'Meters',
  time: 'Time',
};

/** A DOM rectangle, in CSS px, as `getBoundingClientRect` reports it. */
export interface HudRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** How far each HUD edge reaches into the stage, in CSS px (#733 VP-15). */
export interface HudInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Which part of the stage the HUD covers (#733 FR1), from the stage's rect
 * and the rects of the panels drawn over it. A panel in the lower half pushes
 * the bottom inset up to its top edge; one in the upper half pushes the top
 * inset down to its bottom edge. Side insets stay 0: the panels span the
 * stage, so moving the boat sideways would not uncover it. Hidden (zero-size)
 * and off-stage panels are ignored.
 */
export const hudInsetsFromRects = (stage: HudRect, panels: readonly HudRect[]): HudInsets => {
  const height = stage.bottom - stage.top;
  const mid = stage.top + height / 2;
  let top = 0;
  let bottom = 0;
  for (const p of panels) {
    if (p.right - p.left <= 0 || p.bottom - p.top <= 0) continue;
    if (p.bottom <= stage.top || p.top >= stage.bottom) continue;
    if (p.right <= stage.left || p.left >= stage.right) continue;
    const centre = (p.top + p.bottom) / 2;
    if (centre >= mid) bottom = Math.max(bottom, stage.bottom - Math.max(p.top, stage.top));
    else top = Math.max(top, Math.min(p.bottom, stage.bottom) - stage.top);
  }
  return { top, right: 0, bottom, left: 0 };
};

/**
 * Below this stage height the workout block and the metrics collapse to one
 * line each (#733 FR4), so the HUD keeps to about a quarter of the stage.
 */
export const COMPACT_HUD_MAX_STAGE_PX = 800;

export const isCompactHud = (stageHeight: number): boolean =>
  stageHeight > 0 && stageHeight < COMPACT_HUD_MAX_STAGE_PX;
