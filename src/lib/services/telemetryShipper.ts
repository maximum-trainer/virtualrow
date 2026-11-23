/**
 * Ships the scene telemetry log to the virtualrow Worker (#421 phase 2).
 *
 * Anonymous: a random run id per page load, the build SHA, and the events the
 * log already records. Nothing is sent while the rower has crash reports
 * turned off (#473's opt-out covers this too), and nothing at all unless the
 * build sets `VITE_API_BASE_URL`.
 *
 * Batches go every 30 s and on `pagehide` (via `sendBeacon` as text/plain so
 * no CORS preflight is needed). `sample` events arrive about once a second, so
 * only the latest one per batch is kept; every other kind ships in full.
 */
import type { TelemetryEvent } from '../utils/sceneTelemetryLog';

export const TELEMETRY_FLUSH_MS = 30_000;
/** Matches the Worker's caps (workers/api/src/telemetry.ts). */
export const MAX_EVENTS_PER_BATCH = 300;
export const MAX_BATCH_BYTES = 60 * 1024;
/** Unsent events kept while offline before the oldest are dropped. */
export const MAX_QUEUED_EVENTS = 1_000;

export interface TelemetryShipperOptions {
  endpoint: string;
  runId: string;
  build: string;
  isEnabled: () => boolean;
  /** POST a JSON body; `beacon` asks for a send that survives the page going. */
  send: (url: string, body: string, beacon: boolean) => Promise<boolean>;
}

export interface TelemetryShipper {
  enqueue(event: TelemetryEvent): void;
  flush(beacon?: boolean): Promise<void>;
  pending(): number;
}

const KIND = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

export function createTelemetryShipper(options: TelemetryShipperOptions): TelemetryShipper {
  const url = `${options.endpoint.replace(/\/+$/, '')}/api/telemetry`;
  let queue: TelemetryEvent[] = [];
  let latestSample: TelemetryEvent | null = null;
  let inFlight = false;

  const envelope = (events: TelemetryEvent[]) =>
    JSON.stringify({ schemaVersion: 1, runId: options.runId, build: options.build, events });

  /** Split into batches that fit the Worker's event and byte caps. */
  const batches = (events: TelemetryEvent[]): TelemetryEvent[][] => {
    const out: TelemetryEvent[][] = [];
    let current: TelemetryEvent[] = [];
    for (const event of events) {
      if (envelope([event]).length > MAX_BATCH_BYTES) continue; // one oversized event is dropped
      const next = [...current, event];
      if (next.length > MAX_EVENTS_PER_BATCH || envelope(next).length > MAX_BATCH_BYTES) {
        out.push(current);
        current = [event];
      } else {
        current = next;
      }
    }
    if (current.length) out.push(current);
    return out;
  };

  return {
    enqueue(event) {
      if (!options.isEnabled() || !KIND.test(event.kind)) return;
      if (event.kind === 'sample') {
        latestSample = event;
        return;
      }
      queue.push(event);
      if (queue.length > MAX_QUEUED_EVENTS) queue = queue.slice(queue.length - MAX_QUEUED_EVENTS);
    },

    async flush(beacon = false) {
      if (inFlight && !beacon) return;
      if (!options.isEnabled()) {
        queue = [];
        latestSample = null;
        return;
      }
      const events = latestSample ? [...queue, latestSample].sort((a, b) => a.at - b.at) : [...queue];
      if (!events.length) return;
      queue = [];
      latestSample = null;
      inFlight = true;
      try {
        for (const batch of batches(events)) {
          const ok = await options.send(url, envelope(batch), beacon).catch(() => false);
          // Keep what did not go for the next flush (a beacon gets no retry).
          if (!ok && !beacon) {
            queue = [...batch.filter((e) => e.kind !== 'sample'), ...queue].slice(-MAX_QUEUED_EVENTS);
          }
        }
      } finally {
        inFlight = false;
      }
    },

    pending: () => queue.length + (latestSample ? 1 : 0),
  };
}

/** `fetch` for timed flushes, `sendBeacon` when the page is going away. */
export const browserSend: TelemetryShipperOptions['send'] = async (url, body, beacon) => {
  if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    return navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: beacon });
  return res.ok;
};
