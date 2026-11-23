/**
 * #729 FR5 — `performance.measure` entries for the costly steps of starting
 * a ride (`vr:attach:<phase>`), so they show in DevTools' Performance panel
 * and a spec can read them with `performance.getEntriesByName`.
 *
 * A host without the User Timing API (SSR) just runs the step.
 */
const timing = (): Performance | null =>
  typeof performance !== 'undefined' && typeof performance.measure === 'function' ? performance : null;

const record = (phase: string, startMs: number): void => {
  const perf = timing();
  if (!perf) return;
  try {
    perf.measure(`vr:attach:${phase}`, { start: startMs, end: perf.now() });
  } catch {
    // A measure is a diagnostic; never fail a ride over one.
  }
};

/** Time a synchronous step as `vr:attach:<phase>`. */
export const measureAttach = <T>(phase: string, step: () => T): T => {
  const start = timing()?.now() ?? 0;
  try {
    return step();
  } finally {
    record(phase, start);
  }
};

/** Time an asynchronous step as `vr:attach:<phase>`, settled or not. */
export const measureAttachAsync = async <T>(phase: string, step: () => Promise<T>): Promise<T> => {
  const start = timing()?.now() ?? 0;
  try {
    return await step();
  } finally {
    record(phase, start);
  }
};
