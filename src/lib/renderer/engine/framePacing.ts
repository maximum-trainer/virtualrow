/**
 * #737 VP-19 FR3 — frame pacing. The last {@link FRAME_PACING_CAPACITY}
 * frame intervals in a ring buffer, summarised as the percentiles and stall
 * counts a smoothness gate reads (`__ROWER3D_FRAME_PACING`).
 *
 * Recording and summarising are allocation-free: the summary sorts a reused
 * scratch copy in place.
 */

export const FRAME_PACING_CAPACITY = 600;

/** FR6 — the longest step the simulation takes, whatever the real interval. */
export const SIM_DT_CLAMP_MS = 100;

export interface FramePacingSummary {
  /** Intervals in the window (at most {@link FRAME_PACING_CAPACITY}). */
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Intervals in the window longer than 25 ms (a dropped frame at 60 Hz). */
  over25ms: number;
  /** Intervals in the window longer than 50 ms (a visible hitch). */
  over50ms: number;
  /** The longest interval since the pacing was created, window or not. */
  longestStallMs: number;
}

export interface FramePacing {
  readonly ring: Float64Array;
  readonly scratch: Float64Array;
  next: number;
  count: number;
  longestStallMs: number;
}

export const createFramePacing = (capacity = FRAME_PACING_CAPACITY): FramePacing => ({
  ring: new Float64Array(capacity),
  scratch: new Float64Array(capacity),
  next: 0,
  count: 0,
  longestStallMs: 0,
});

/** Record one frame interval in milliseconds. */
export const recordFrameDt = (pacing: FramePacing, dtMs: number): void => {
  if (!Number.isFinite(dtMs) || dtMs < 0) return;
  pacing.ring[pacing.next] = dtMs;
  pacing.next = (pacing.next + 1) % pacing.ring.length;
  if (pacing.count < pacing.ring.length) pacing.count += 1;
  if (dtMs > pacing.longestStallMs) pacing.longestStallMs = dtMs;
};

const emptySummary = (): FramePacingSummary => ({
  samples: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  max: 0,
  over25ms: 0,
  over50ms: 0,
  longestStallMs: 0,
});

/** Nearest-rank percentile of the first `n` sorted values. */
const rank = (sorted: Float64Array, n: number, p: number): number =>
  sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];

/** Summarise the window into `out` (or a new object) and return it. */
export const summariseFramePacing = (
  pacing: FramePacing,
  out: FramePacingSummary = emptySummary(),
): FramePacingSummary => {
  const n = pacing.count;
  out.samples = n;
  out.longestStallMs = pacing.longestStallMs;
  if (n === 0) {
    out.p50 = out.p95 = out.p99 = out.max = out.over25ms = out.over50ms = 0;
    return out;
  }
  let over25 = 0;
  let over50 = 0;
  const sorted = pacing.scratch;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i >= n) {
      sorted[i] = Number.POSITIVE_INFINITY;
      continue;
    }
    const v = pacing.ring[i];
    sorted[i] = v;
    if (v > 25) over25 += 1;
    if (v > 50) over50 += 1;
  }
  // In place, so a summary every frame allocates nothing; the unused tail
  // sorts to the end as +Infinity.
  sorted.sort();
  out.p50 = rank(sorted, n, 50);
  out.p95 = rank(sorted, n, 95);
  out.p99 = rank(sorted, n, 99);
  out.max = sorted[n - 1];
  out.over25ms = over25;
  out.over50ms = over50;
  return out;
};
