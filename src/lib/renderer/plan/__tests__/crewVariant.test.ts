/**
 * Vitest for the engine-side crew-variant resolver (#578 FR1/FR3/AC1/AC2).
 *
 * The engine owns the "which GLB to load" policy for its own attach surface:
 * the shell computes a `resolveCrewVariant(gender, preference)` and passes
 * the enum through `opts.crew`. This test pins the three cases the ACs call
 * out so a future rewrite of the shell's resolver cannot drift the engine's
 * contract.
 */

import { describe, expect, it } from 'vitest';
import { resolveCrewVariant } from '../crewVariant';

describe('resolveCrewVariant (#578 FR1/FR3)', () => {
  it('AC1: female profile with no stated preference renders female', () => {
    expect(resolveCrewVariant('female')).toBe('female');
  });

  it('AC1: male profile with no stated preference renders male', () => {
    expect(resolveCrewVariant('male')).toBe('male');
  });

  it('AC2: guest / demo (no profile) renders the male default', () => {
    expect(resolveCrewVariant(null)).toBe('male');
    expect(resolveCrewVariant(undefined)).toBe('male');
  });

  it('an explicit preference beats the profile (preference-wins)', () => {
    expect(resolveCrewVariant('female', 'male')).toBe('male');
    expect(resolveCrewVariant('male', 'female')).toBe('female');
  });

  it("'auto' preference defers to the profile", () => {
    expect(resolveCrewVariant('female', 'auto')).toBe('female');
    expect(resolveCrewVariant('male', 'auto')).toBe('male');
    expect(resolveCrewVariant(null, 'auto')).toBe('male');
  });
});
