import { describe, expect, it, vi } from 'vitest';
import { StartGate } from '../lib/ui/startGate.svelte';

// #741 VP-21 FR5 — Start and the demo row wait for the route's water data
// by default, with a visible "start now with simple scenery" escape.
describe('StartGate (#741 FR5)', () => {
  it('starts at once when the route data is in', () => {
    const gate = new StartGate();
    const run = vi.fn();
    gate.request('demo', false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.pending).toBeNull();
  });

  it('holds a start while the route data loads, and runs it when it lands', () => {
    const gate = new StartGate();
    const run = vi.fn();
    gate.request('workout', true, run);
    expect(run).not.toHaveBeenCalled();
    expect(gate.pending).toBe('workout');
    gate.update(true);
    expect(run).not.toHaveBeenCalled();
    gate.update(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.pending).toBeNull();
    gate.update(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts now with simple scenery when asked', () => {
    const gate = new StartGate();
    const run = vi.fn();
    gate.request('demo', true, run);
    gate.startNow();
    expect(run).toHaveBeenCalledTimes(1);
    gate.update(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a later request replaces a held one, and cancel drops it', () => {
    const gate = new StartGate();
    const first = vi.fn();
    const second = vi.fn();
    gate.request('workout', true, first);
    gate.request('demo', true, second);
    expect(gate.pending).toBe('demo');
    gate.cancel();
    gate.update(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
