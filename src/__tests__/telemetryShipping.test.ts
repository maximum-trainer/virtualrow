import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetry, openTelemetry, recordTelemetry } from '../lib/utils/sceneTelemetryLog';
import { startTelemetryShipping, stopTelemetryShippingForTests } from '../lib/utils/telemetryShipping';
import { readApiBaseUrl } from '../lib/services/apiBaseUrl';
import { crashReportsPreferenceStore } from '../lib/services/crashReportsPreferenceStore';
import { TELEMETRY_FLUSH_MS, type TelemetryShipperOptions } from '../lib/services/telemetryShipper';

describe('startTelemetryShipping (#421)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    openTelemetry(null);
  });
  afterEach(() => {
    stopTelemetryShippingForTests();
    clearTelemetry();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('is off without an API base URL', async () => {
    expect(readApiBaseUrl()).toBeNull();
    const send = vi.fn<TelemetryShipperOptions['send']>(async () => true);
    startTelemetryShipping({ build: 'abc', send });
    recordTelemetry('error', { message: 'x' });
    await vi.advanceTimersByTimeAsync(TELEMETRY_FLUSH_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it('ships the recovered log plus new events every 30 s', async () => {
    const send = vi.fn<TelemetryShipperOptions['send']>(async () => true);
    startTelemetryShipping({ build: 'abc', endpoint: 'https://api.test', send });
    recordTelemetry('context-created');
    await vi.advanceTimersByTimeAsync(TELEMETRY_FLUSH_MS);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(send.mock.calls[0]?.[1] ?? '{}');
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(['run-start', 'context-created']);
  });

  it('flushes by beacon on page hide', async () => {
    const send = vi.fn<TelemetryShipperOptions['send']>(async () => true);
    startTelemetryShipping({ build: 'abc', endpoint: 'https://api.test', send });
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[0]?.[2]).toBe(true);
  });

  it('respects the crash-report opt-out', async () => {
    crashReportsPreferenceStore.setEnabled(false);
    const send = vi.fn<TelemetryShipperOptions['send']>(async () => true);
    startTelemetryShipping({ build: 'abc', endpoint: 'https://api.test', send });
    recordTelemetry('error');
    await vi.advanceTimersByTimeAsync(TELEMETRY_FLUSH_MS);
    expect(send).not.toHaveBeenCalled();
  });
});
