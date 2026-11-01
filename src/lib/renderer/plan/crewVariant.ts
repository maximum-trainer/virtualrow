/**
 * Which crewed scull the WebGPU engine should draw for an athlete (#578 FR1/FR3).
 *
 * The React side had this logic in `src/components/rower3d/crewModel.ts` since
 * #229 / #232 / #443; the engine imported the same helpers through its options,
 * which left the "who picks the gender" rule split between the shell and the
 * engine. The plan layer re-exports a thin, GPU-free resolver so the engine
 * owns its own policy and a seam test can pin it without touching the React
 * tree.
 *
 * Pure + synchronous: callers (the shell today, a future per-session chooser
 * tomorrow) can pass through whatever profile/preference pair they have and
 * take the returned enum as truth.
 */
import { resolveCrew as resolveCrewReact, type Crew } from '../../../components/rower3d/crewModel';

export type { Crew } from '../../../components/rower3d/crewModel';

/**
 * Pick the engine's crew model.
 *
 * D5-a (locked): "default male" when neither preference nor profile picks a
 * gender. Hard-coded here so a cold-start guest sees the same rower every
 * session instead of a config-driven surprise.
 */
export const resolveCrewVariant = (
  gender?: 'male' | 'female' | null,
  preference: 'auto' | Crew = 'auto',
): Crew => resolveCrewReact(gender, preference);
