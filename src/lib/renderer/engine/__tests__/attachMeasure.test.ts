import { afterEach, describe, expect, it } from 'vitest';
import { measureAttach, measureAttachAsync } from '../attachMeasure';

// #729 FR5 — the costly attach steps leave `vr:attach:<phase>` measures.
describe('attach measures (#729 FR5)', () => {
  afterEach(() => performance.clearMeasures());

  it('records a synchronous step and returns its result', () => {
    expect(measureAttach('atlas', () => 42)).toBe(42);
    expect(performance.getEntriesByName('vr:attach:atlas', 'measure')).toHaveLength(1);
  });

  it('records an asynchronous step once it settles', async () => {
    await expect(measureAttachAsync('pipelines', async () => 'ok')).resolves.toBe('ok');
    expect(performance.getEntriesByName('vr:attach:pipelines', 'measure')).toHaveLength(1);
  });

  it('still records a step that throws, and rethrows', async () => {
    await expect(
      measureAttachAsync('route', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(performance.getEntriesByName('vr:attach:route', 'measure')).toHaveLength(1);
  });
});
