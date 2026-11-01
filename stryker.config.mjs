// StrykerJS mutation-testing config (#588 FR4 / AC4, D3-a).
//
// Scope is deliberately narrow: the WebGPU engine's plan layer, the
// smoothing/physics helper on the engine seam, and the FIT encoder.
// These are the modules where a passing test can silently stop
// exercising behaviour — a hole in the engine's pure CPU plans or in
// the FIT bytes we hand intervals.icu is the exact failure mode the
// pre-#549 black-canvas bug trained us to watch for.
//
// `test:mutation` runs it; `test:mutation:ci` is the gated variant the
// CI workflow calls — it adds a wall-clock cap (NFR3) and tightens the
// non-zero-exit codes.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'vitest',
  // The vitest runner picks up `vitest.config.ts` on its own; nothing to
  // forward here.
  vitest: {
    configFile: 'vitest.config.ts',
  },
  coverageAnalysis: 'perTest',
  // Static mutants land at module-top-level code; our 17-file scope's
  // first run flagged 24% of mutants as static and estimated 70% of
  // the run spent on them. Skipping them trades a small coverage loss
  // for a ~3x speedup — critical for the "every build" directive
  // (D10 override) staying under the CI wall-clock cap. Keep them off
  // unless a specific module's static initialisation becomes the
  // bug source.
  ignoreStatic: true,
  // D3-a: engine plan layer + physics-adjacent helpers + FIT encoder.
  // Nothing else is mutated — StrykerJS runs expand quadratically with
  // the file set and this scope keeps a full run comfortably under the
  // NFR3 cap. Extend with care; a wider scope deserves its own PR.
  mutate: [
    'src/lib/renderer/plan/**/*.ts',
    '!src/lib/renderer/plan/**/__tests__/**',
    '!src/lib/renderer/plan/**/*.test.ts',
    'src/lib/renderer/engine/distanceSmoother.ts',
    'src/lib/services/fitEncoderService.ts',
  ],
  // #588 AC4 — baseline survived-mutant count stays in CLAUDE.md.
  // Thresholds here mirror it: the gate flips red when the ratio drops
  // enough that the baseline no longer holds. Starts permissive; raise
  // as surviving mutants are killed.
  thresholds: {
    high: 90,
    low: 70,
    break: 60,
  },
  htmlReporter: {
    fileName: 'reports/mutation/mutation.html',
  },
  // NFR3 — individual spec-run timeout. Keeps a hung mutant from
  // monopolising the wall clock.
  timeoutMS: 60_000,
  timeoutFactor: 3,
  // Concurrency defaults to the host's CPU count, which starves CI
  // runners of memory. A conservative cap (`maxTestRunnerReuse` not
  // supported by the vitest runner — rely on concurrency alone).
  concurrency: 2,
  tempDirName: '.stryker-tmp',
  // Keep the HTML report small on disk by only emitting the survived
  // and killed states in detail; untested mutants are summarised.
  logLevel: 'info',
  fileLogLevel: 'warn',
};
