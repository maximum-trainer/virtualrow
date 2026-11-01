import { describe, it, expectTypeOf } from 'vitest';
import type { BankSide } from '../components/rower3d/sceneryClearance';

/**
 * #588 FR1 / AC1 — the only surviving export of `sceneryClearance.ts` is the
 * `BankSide` string-literal union, which `segmentScenery.ts` consumes as a
 * type. Pin that shape so a later cleanup can't widen or rename it without
 * noticing the downstream consumer. The pre-#625 scene-mutator behaviour the
 * file used to carry retired with the React three.js path at the cutover.
 */
describe('sceneryClearance', () => {
  it('BankSide is the two-member union "left" | "right"', () => {
    expectTypeOf<BankSide>().toEqualTypeOf<'left' | 'right'>();
  });
});
