/**
 * #745 VP-25 FR1 — the bank rises and falls with the route's real elevation
 * (`getTerrainReliefForProgress`, already clamped to
 * `MAX_TERRAIN_RELIEF_SCENE_UNITS` by `buildTerrainProfile`), as the React
 * scene's banks did. Water stays flat.
 *
 * The React bank was one quad across, waterline to reach, so it ramped the
 * whole width. The engine's bank is 60 m of land with kit props standing on
 * it, so it climbs from the waterline over a short embankment and then holds
 * the relief: a prop placed at the relief height stands on the ground
 * wherever it is on the bank ({@link bankReliefAt} is the shared rule).
 */

/** Metres from the waterline over which the bank climbs to the relief height. */
export const BANK_RELIEF_RAMP_METRES = 10;

/** 0 at the waterline, 1 from {@link BANK_RELIEF_RAMP_METRES} out, smooth between. */
export const bankReliefRamp = (shoreDistMetres: number): number => {
  const x = Math.max(0, Math.min(1, shoreDistMetres / BANK_RELIEF_RAMP_METRES));
  return x * x * (3 - 2 * x);
};

/** Height above the flat bank of land `shoreDistMetres` from the water, where the route's relief is `relief`. */
export const bankReliefAt = (relief: number, shoreDistMetres: number): number =>
  relief * bankReliefRamp(shoreDistMetres);
