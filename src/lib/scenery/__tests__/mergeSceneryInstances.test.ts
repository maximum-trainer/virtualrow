import { describe, expect, it } from 'vitest';
import { mergeSceneryInstances } from '../mergeSceneryInstances';
import type { Mat4 } from '../../renderer/math/mat4';

const m = (tag: number): Mat4 => new Float32Array(16).map((_, i) => (i === 0 ? tag : 0)) as Mat4;

describe('mergeSceneryInstances (#723 FR5)', () => {
  it('concatenates instance lists per model id from every source', () => {
    const extras = new Map<string, Mat4[]>([
      ['a06-finish-tower', [m(1)]],
      ['c01-bridge-arch-masonry', [m(2)]],
    ]);
    const routeGlb = new Map<string, Mat4[]>([
      ['a06-finish-tower', [m(3), m(4)]],
      ['b02-boathouse-uk-victorian', [m(5)]],
    ]);
    const out = mergeSceneryInstances([extras, routeGlb]);
    expect(out.get('a06-finish-tower')?.map((v) => v[0])).toEqual([1, 3, 4]);
    expect(out.get('c01-bridge-arch-masonry')?.map((v) => v[0])).toEqual([2]);
    expect(out.get('b02-boathouse-uk-victorian')?.map((v) => v[0])).toEqual([5]);
  });

  it('does not share buckets across sources (no shared reference)', () => {
    const a = new Map<string, Mat4[]>([['x', [m(1)]]]);
    const out = mergeSceneryInstances([a]);
    out.get('x')?.push(m(99));
    expect(a.get('x')).toHaveLength(1);
  });

  it('respects maxInstances per model id', () => {
    const src = new Map<string, Mat4[]>([
      ['y', [m(1), m(2), m(3), m(4)]],
      ['z', [m(5)]],
    ]);
    const out = mergeSceneryInstances([src], { maxInstances: 2 });
    expect(out.get('y')).toHaveLength(2);
    expect(out.get('y')?.map((v) => v[0])).toEqual([1, 2]);
    expect(out.get('z')).toHaveLength(1);
  });

  it('is empty when every source is empty', () => {
    expect(mergeSceneryInstances([])).toEqual(new Map());
    expect(mergeSceneryInstances([new Map(), new Map()])).toEqual(new Map());
  });
});
