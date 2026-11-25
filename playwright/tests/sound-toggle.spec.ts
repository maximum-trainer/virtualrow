import { test, expect } from '../fixtures/crash-watch';

/**
 * #884 — flipping the Sound switch on during a demo row must produce audible
 * output, not just open a silent AudioContext.
 *
 * The test replaces `window.AudioContext` before page load with a bookkeeping
 * stub that records what the page connected: the production `AudioService`
 * builds a master gain, so the water bed (a `BufferSource` → `BiquadFilter` →
 * `Gain` → master) and splash / cue calls each become one or more `connect()`
 * links on that graph. An empty graph means the toggle wired to nothing —
 * exactly the #884 regression we are closing.
 *
 * No GPU and no real hardware — the demo button starts the pipeline through
 * the same path as a connected rower, so this spec runs on every CI shard.
 */

test('a demo row with the Sound switch on produces a live audio graph', async ({ page }) => {
  await page.addInitScript(() => {
    // A minimal AudioContext stub that records what the service built. Returns
    // chainable node stubs with a counting `connect` so one call records a
    // link even when the production code chains `.connect().connect().connect()`.
    type Node = { kind: string; connect: (dest: unknown) => Node; start?: () => void; stop?: () => void; disconnect?: () => void; buffer?: unknown; loop?: boolean; frequency?: { value: number }; Q?: { value: number }; type?: string; gain?: { value: number; setValueAtTime: () => void; linearRampToValueAtTime: () => void } };
    const log = { connects: 0, sources: 0, filters: 0, gains: 0, oscillators: 0, resumes: 0, closed: false };
    (window as unknown as { __VIRTUALROW_AUDIO_LOG__: typeof log }).__VIRTUALROW_AUDIO_LOG__ = log;

    const bump = (key: 'sources' | 'filters' | 'gains' | 'oscillators'): void => {
      log[key] += 1;
    };
    const node = (kind: 'source' | 'filter' | 'gain' | 'oscillator'): Node => {
      bump((`${kind}s` as 'sources' | 'filters' | 'gains' | 'oscillators'));
      const n: Node = {
        kind,
        connect: (dest) => {
          log.connects++;
          return dest as Node;
        },
      };
      if (kind === 'source') {
        n.start = () => {};
        n.stop = () => {};
        n.disconnect = () => {};
      }
      if (kind === 'oscillator') {
        n.start = () => {};
        n.stop = () => {};
        n.frequency = { value: 0 };
        n.type = 'sine';
      }
      if (kind === 'filter') {
        n.frequency = { value: 0 };
        n.Q = { value: 0 };
        n.type = 'bandpass';
      }
      if (kind === 'gain') {
        n.gain = {
          value: 0,
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
        };
      }
      return n;
    };

    class StubAudioContext {
      sampleRate = 48000;
      currentTime = 0;
      destination = { kind: 'destination' };
      state = 'suspended';
      createGain() {
        return node('gain');
      }
      createBufferSource() {
        return node('source');
      }
      createBiquadFilter() {
        return node('filter');
      }
      createOscillator() {
        return node('oscillator');
      }
      createBuffer(_channels: number, length: number) {
        return {
          getChannelData: () => new Float32Array(length),
        };
      }
      async resume() {
        log.resumes++;
        this.state = 'running';
      }
      async close() {
        log.closed = true;
        this.state = 'closed';
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = StubAudioContext;
  });

  await page.goto('./');

  // Start a demo row: no mock-bluetooth, no sign-in needed (the demo button
  // runs the same pipeline a connected PM5 would).
  const demo = page.locator('.btn-try-demo');
  await expect(demo).toBeVisible({ timeout: 15_000 });
  await demo.click();
  // The shell navigates to /row on the start event; wait for the Sound switch
  // (the one ambient control on the workout view).
  const soundSwitch = page.getByRole('switch', { name: 'Sound' });
  await expect(soundSwitch).toBeVisible({ timeout: 15_000 });

  // Flip it on. This is the gesture `AudioService.enable()` needs — a browser
  // will not start an AudioContext without one.
  await soundSwitch.check();
  await expect(soundSwitch).toBeChecked();

  // Within 500 ms the service should have built the master graph (gain +
  // resume) AND the water-bed subscriber should have landed its own source.
  await page.waitForFunction(
    () => {
      const l = (window as unknown as { __VIRTUALROW_AUDIO_LOG__?: { gains: number; sources: number; resumes: number; connects: number } }).__VIRTUALROW_AUDIO_LOG__;
      return !!l && l.resumes >= 1 && l.gains >= 1 && l.sources >= 1 && l.connects >= 3;
    },
    null,
    { timeout: 500 },
  );

  // Flipping it off must stop the water bed and close the hardware handle.
  await soundSwitch.uncheck();
  await page.waitForFunction(
    () => {
      const l = (window as unknown as { __VIRTUALROW_AUDIO_LOG__?: { closed: boolean } }).__VIRTUALROW_AUDIO_LOG__;
      return !!l && l.closed === true;
    },
    null,
    { timeout: 500 },
  );
});
