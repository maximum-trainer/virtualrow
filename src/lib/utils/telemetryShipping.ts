import { crashReportsPreferenceStore } from '../services/crashReportsPreferenceStore';
import { readApiBaseUrl } from '../services/apiBaseUrl';
import {
  browserSend,
  createTelemetryShipper,
  TELEMETRY_FLUSH_MS,
  type TelemetryShipperOptions,
} from '../services/telemetryShipper';
import { readTelemetry, subscribeTelemetry } from './sceneTelemetryLog';

let stop: (() => void) | null = null;

/**
 * Start shipping the telemetry log to the Worker (#421). A no-op without
 * `VITE_API_BASE_URL`, or when already started. Call after `startTelemetry()`
 * so the recovered previous run (often the one that crashed) ships too.
 */
export function startTelemetryShipping(
  options: { build: string; endpoint?: string | null; send?: TelemetryShipperOptions['send'] },
): void {
  const endpoint = options.endpoint === undefined ? readApiBaseUrl() : options.endpoint;
  if (stop || !endpoint || typeof window === 'undefined') return;

  const shipper = createTelemetryShipper({
    endpoint,
    runId: crypto.randomUUID(),
    build: options.build,
    isEnabled: () => crashReportsPreferenceStore.isEnabled(),
    send: options.send ?? browserSend,
  });
  for (const event of readTelemetry()) shipper.enqueue(event);
  const unsubscribe = subscribeTelemetry((event) => shipper.enqueue(event));
  const timer = window.setInterval(() => void shipper.flush(), TELEMETRY_FLUSH_MS);
  const onHide = () => void shipper.flush(true);
  window.addEventListener('pagehide', onHide);

  stop = () => {
    unsubscribe();
    window.clearInterval(timer);
    window.removeEventListener('pagehide', onHide);
    stop = null;
  };
}

/** For tests: take the subscription, timer and listener off again. */
export function stopTelemetryShippingForTests(): void {
  stop?.();
}
