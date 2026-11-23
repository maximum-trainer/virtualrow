import { describe, expect, it, vi } from 'vitest';
import {
  createTelemetryShipper,
  MAX_BATCH_BYTES,
  MAX_EVENTS_PER_BATCH,
  type TelemetryShipperOptions,
} from '../lib/services/telemetryShipper';

type SendMock = ReturnType<typeof vi.fn<TelemetryShipperOptions['send']>>;

function make(overrides: Partial<Omit<TelemetryShipperOptions, 'send'>> & { send?: SendMock } = {}) {
  const send: SendMock = overrides.send ?? vi.fn<TelemetryShipperOptions['send']>(async () => true);
  const shipper = createTelemetryShipper({
    endpoint: 'https://api.test/',
    runId: 'run-0123456789',
    build: 'abc',
    isEnabled: () => true,
    ...overrides,
    send,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodies = (): any[] => send.mock.calls.map((c) => JSON.parse(c[1]));
  return { shipper, send, bodies };
}

describe('telemetryShipper (#421)', () => {
  it('posts the Worker envelope to /api/telemetry', async () => {
    const { shipper, send, bodies } = make();
    shipper.enqueue({ at: 5, kind: 'error', detail: { message: 'boom' } });
    await shipper.flush();
    expect(send.mock.calls[0]?.[0]).toBe('https://api.test/api/telemetry');
    expect(bodies()[0]).toEqual({
      schemaVersion: 1,
      runId: 'run-0123456789',
      build: 'abc',
      events: [{ at: 5, kind: 'error', detail: { message: 'boom' } }],
    });
    expect(shipper.pending()).toBe(0);
  });

  it('keeps only the latest sample per batch, in time order', async () => {
    const { shipper, bodies } = make();
    shipper.enqueue({ at: 1, kind: 'sample', detail: { fps: 60 } });
    shipper.enqueue({ at: 2, kind: 'context-created' });
    shipper.enqueue({ at: 3, kind: 'sample', detail: { fps: 58 } });
    await shipper.flush();
    expect(bodies()[0].events.map((e: { at: number }) => e.at)).toEqual([2, 3]);
  });

  it('sends nothing, and drops the queue, while crash reports are off', async () => {
    let enabled = true;
    const { shipper, send } = make({ isEnabled: () => enabled });
    shipper.enqueue({ at: 1, kind: 'error' });
    enabled = false;
    shipper.enqueue({ at: 2, kind: 'error' });
    await shipper.flush();
    expect(send).not.toHaveBeenCalled();
    enabled = true;
    await shipper.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when there is nothing to send', async () => {
    const { shipper, send } = make();
    await shipper.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('requeues a failed timed batch and retries on the next flush', async () => {
    const send = vi.fn<TelemetryShipperOptions['send']>(async () => false);
    const { shipper } = make({ send });
    shipper.enqueue({ at: 1, kind: 'error' });
    await shipper.flush();
    expect(shipper.pending()).toBe(1);
    send.mockResolvedValue(true);
    await shipper.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(shipper.pending()).toBe(0);
  });

  it('treats a thrown send as a failure', async () => {
    const send = vi.fn<TelemetryShipperOptions['send']>(async () => {
      throw new TypeError('offline');
    });
    const { shipper } = make({ send });
    shipper.enqueue({ at: 1, kind: 'error' });
    await shipper.flush();
    expect(shipper.pending()).toBe(1);
  });

  it('passes the beacon flag through on page hide', async () => {
    const { shipper, send } = make();
    shipper.enqueue({ at: 1, kind: 'page-hide' });
    await shipper.flush(true);
    expect(send.mock.calls[0]?.[2]).toBe(true);
  });

  it('splits by the event cap and the byte cap', async () => {
    const { shipper, bodies } = make();
    for (let i = 0; i < MAX_EVENTS_PER_BATCH + 5; i++) shipper.enqueue({ at: i, kind: 'context-lost' });
    await shipper.flush();
    expect(bodies().map((b) => b.events.length)).toEqual([MAX_EVENTS_PER_BATCH, 5]);

    const big = make();
    const blob = 'x'.repeat(MAX_BATCH_BYTES / 3);
    for (let i = 0; i < 4; i++) big.shipper.enqueue({ at: i, kind: 'error', detail: { blob } });
    await big.shipper.flush();
    expect(big.bodies().length).toBe(2);
    for (const call of big.send.mock.calls) expect(call[1].length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
  });

  it('drops a single event too large to ever send, and kinds the Worker would reject', async () => {
    const { shipper, bodies } = make();
    shipper.enqueue({ at: 1, kind: 'error', detail: { blob: 'x'.repeat(MAX_BATCH_BYTES) } });
    shipper.enqueue({ at: 2, kind: 'Bad Kind' });
    shipper.enqueue({ at: 3, kind: 'error' });
    await shipper.flush();
    expect(bodies()[0].events.map((e: { at: number }) => e.at)).toEqual([3]);
  });
});
