import { test, expect } from '../fixtures/crash-watch';

/**
 * #884 — flipping the Sound switch on and starting a demo row must produce
 * audible output, not just open a silent AudioContext.
 *
 * The test replaces `window.AudioContext` before page load with a bookkeeping
 * stub that records what the page connected: the production `AudioService`
 * builds a master gain, and the water bed (a `BufferSource` → `BiquadFilter`
 * → `Gain` → master) adds its own source with three more `connect()` links.
 * An empty graph after the row starts means the subscribers never re-attached
 * across the shell's Routes → `/row` navigation — the #884 regression.
 *
 * The Sound switch lives on the Routes screen (`+page.svelte`), not on
 * `/row`, so the flip must happen BEFORE the demo button. Doing it after
 * races the navigation that `virtualrow:sessionStarted` kicks off and the
 * click lands on a detached element.
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

  // `SoundPicker` is on the Routes screen (the home page), not on `/row`, so
  // the switch must be flipped before the demo starts — otherwise the element
  // detaches when the shell navigates on `virtualrow:sessionStarted` and the
  // `.check()` lands on a stale handle (what reddened main after #884 shipped).
  const soundSwitch = page.getByRole('switch', { name: 'Sound' });
  await expect(soundSwitch).toBeVisible({ timeout: 15_000 });
  await soundSwitch.check();
  await expect(soundSwitch).toBeChecked();

  // The service builds its master graph synchronously inside `enable()` (the
  // gain + at least one `connect` to destination), and the browser then
  // resumes the context. Wait briefly for both before starting the row.
  await page.waitForFunction(
    () => {
      const l = (window as unknown as { __VIRTUALROW_AUDIO_LOG__?: { gains: number; resumes: number; connects: number } }).__VIRTUALROW_AUDIO_LOG__;
      return !!l && l.gains >= 1 && l.resumes >= 1 && l.connects >= 1;
    },
    null,
    { timeout: 500 },
  );

  // Start a demo row: the shell navigates to `/row` on
  // `virtualrow:sessionStarted`, and SessionStore's `sessionActive` goes
  // true, which is what the water-bed subscriber waits for.
  const demo = page.locator('.btn-try-demo');
  await expect(demo).toBeVisible({ timeout: 15_000 });
  await demo.click();
  await page.waitForURL(/\/row\/?$/, { timeout: 15_000 });

  // Within 500 ms of the workout starting, the water bed should have landed
  // its own source on the master. An empty source count would mean the
  // subscribers never re-attached across the navigation — the #884 regression.
  await page.waitForFunction(
    () => {
      const l = (window as unknown as { __VIRTUALROW_AUDIO_LOG__?: { sources: number; connects: number } }).__VIRTUALROW_AUDIO_LOG__;
      return !!l && l.sources >= 1 && l.connects >= 3;
    },
    null,
    { timeout: 500 },
  );
});
