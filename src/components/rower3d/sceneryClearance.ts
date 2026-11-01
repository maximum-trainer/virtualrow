// ============================================================================
// SCENERY CLEARANCE — only the `BankSide` type survives.
//
// Pre-#625 this file carried a THREE-based `landClearance` helper plus
// `waterEdgesAt` / `waterHalfWidthAt` / `nearestBankOffset` / `sideOfOffset`
// and `publishSceneryClearance`. The WebGPU engine took over at the cutover
// and the three.js scene went with the rest of the React path; the clearance
// helpers were re-implemented in-place inside `src/lib/scenery/` (see
// `landscapeLayout.ts`, `sceneryStructures.ts`, `sceneryPlacement.ts` and
// `foliagePlan.ts`), and `landClearance` had no surviving caller.
//
// #588 FR1 — this file no longer imports `three`, so the surviving `BankSide`
// consumer in `segmentScenery.ts` can be ported without the React-era
// dependency hanging on.
// ============================================================================

/** Which side of the route, facing along it. Left is `-perp`, right `+perp`. */
export type BankSide = 'left' | 'right';
