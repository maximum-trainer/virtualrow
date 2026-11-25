/**
 * #449 FR2 / FR3 / D3 / D5 / AC2 / AC12: which rownative courses a monthly
 * scenery-generation run should process, worked out from the course index and
 * the committed processed-courses snapshot.
 */

import { describe, expect, it } from 'vitest';
import { planRun, loadIndex, formatPlan } from '../scenery-generation/plan.mjs';

const index = (...ids) => ids.map((id) => ({ id, name: `Course ${id}` }));
const snapshot = (courses = {}) => ({ $schemaVersion: 1, courses });
const done = (courseSha) => ({ courseSha, generatedAt: '2026-11-01T04:00:00Z', workflowRunId: '1' });

describe('planRun (#449 FR2, D3, D5)', () => {
  it('lists every course missing from the snapshot as new, in id order', () => {
    const plan = planRun({ index: index('30', '4', '116'), snapshot: snapshot(), max: 5 });
    expect(plan.toProcess).toEqual([
      { id: '116', reason: 'new' },
      { id: '30', reason: 'new' },
      { id: '4', reason: 'new' },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it('prints exactly the three omitted courses on a dry run (AC2)', () => {
    const plan = planRun({
      index: index('1', '2', '3', '4', '5'),
      snapshot: snapshot({ 1: done('a'), 3: done('c') }),
      max: 5,
    });
    expect(plan.toProcess.map((c) => c.id)).toEqual(['2', '4', '5']);
    expect(formatPlan(plan, { dryRun: true })).toContain('would process: 2, 4, 5');
  });

  it('caps a run at max and defers the rest to the next run (D5)', () => {
    const plan = planRun({ index: index('a', 'b', 'c', 'd'), snapshot: snapshot(), max: 2 });
    expect(plan.toProcess.map((c) => c.id)).toEqual(['a', 'b']);
    expect(plan.deferred.map((c) => c.id)).toEqual(['c', 'd']);
  });

  it('re-processes a course whose file hash changed, and skips an unchanged one (D3, AC12)', () => {
    const plan = planRun({
      index: index('1', '2'),
      snapshot: snapshot({ 1: done('old'), 2: done('same') }),
      max: 5,
      currentShas: { 1: 'new', 2: 'same' },
    });
    expect(plan.toProcess).toEqual([{ id: '1', reason: 'changed' }]);
  });

  it('processes nothing when every course is already done (AC12)', () => {
    const plan = planRun({ index: index('1'), snapshot: snapshot({ 1: done('x') }), max: 5 });
    expect(plan.toProcess).toEqual([]);
    expect(formatPlan(plan, { dryRun: false })).toContain('nothing to process');
  });

  it('drops ids that fail the rownative id pattern instead of using them in paths', () => {
    const plan = planRun({ index: index('ok-1', '../etc', ''), snapshot: snapshot(), max: 5 });
    expect(plan.toProcess.map((c) => c.id)).toEqual(['ok-1']);
    expect(plan.invalid).toEqual(['../etc', '']);
  });

  it('treats a max below one as one', () => {
    expect(planRun({ index: index('a', 'b'), snapshot: snapshot(), max: 0 }).toProcess).toHaveLength(1);
  });
});

describe('loadIndex (#449 FR2)', () => {
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

  it('uses the live index when it loads', async () => {
    const result = await loadIndex({ fetchFn: ok(index('9')), readBundled: async () => index('1') });
    expect(result).toEqual({ source: 'network', entries: index('9') });
  });

  it('falls back to the bundled copy when the live index fails', async () => {
    const result = await loadIndex({
      fetchFn: async () => ({ ok: false, status: 503 }),
      readBundled: async () => index('1'),
    });
    expect(result).toEqual({ source: 'bundled', entries: index('1') });
  });

  it('falls back when the live index is not a list', async () => {
    const result = await loadIndex({ fetchFn: ok({ nope: true }), readBundled: async () => index('1') });
    expect(result.source).toBe('bundled');
  });
});
