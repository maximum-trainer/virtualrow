import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeAdapter,
  isSoftwareAdapter,
  prewarmDevice,
  requestDevice,
  resetPrewarmForTests,
  softwareAttachRequested,
} from '../device';
import { resetWebGPUHealth, readWebGPUHealth } from '../health';
import {
  installGPUStub,
  makeMockAdapter,
  makeMockGPU,
} from '../../__tests__/_mockWebGPU';

describe('device', () => {
  beforeEach(() => {
    resetWebGPUHealth();
    // The prewarm tests below can leave a device made ahead of time; under
    // the shuffled order requestDevice would take it instead of asking.
    resetPrewarmForTests();
  });

  it('describes an adapter', () => {
    const a = makeMockAdapter();
    expect(describeAdapter(a)).toContain('mock');
    const bare = { info: undefined } as unknown as GPUAdapter;
    expect(describeAdapter(bare)).toBe('unknown');
  });

  it('spots a software adapter', () => {
    expect(isSoftwareAdapter(makeMockAdapter({ software: true }))).toBe(true);
    expect(isSoftwareAdapter(makeMockAdapter({ software: false }))).toBe(false);
    expect(isSoftwareAdapter({ info: undefined } as unknown as GPUAdapter)).toBe(false);
  });

  it('falls back when WebGPU is absent', async () => {
    const session = await requestDevice(undefined);
    expect(session.state.kind).toBe('unavailable');
    expect(readWebGPUHealth()?.fallbackReason).toBe('webgpu-unsupported');
  });

  it('falls back when the adapter request throws', async () => {
    const session = await requestDevice({ gpu: makeMockGPU('throw') });
    expect(session.state).toEqual({ kind: 'unavailable', reason: 'adapter-request-failed' });
  });

  it('falls back on a software adapter', async () => {
    const session = await requestDevice({
      gpu: makeMockGPU(makeMockAdapter({ software: true })),
    });
    expect(session.state).toEqual({ kind: 'unavailable', reason: 'software-adapter' });
  });

  // #737 VP-19 FR5 — an opt-in switch lets visual checks render on a
  // software adapter; health still says it is one.
  it('attaches on a software adapter only when asked to, and still reports it', async () => {
    const session = await requestDevice(
      { gpu: makeMockGPU(makeMockAdapter({ software: true })) },
      { allowSoftware: true },
    );
    expect(session.state.kind).toBe('ready');
    expect(session.state.kind === 'ready' && session.state.software).toBe(true);
    expect(readWebGPUHealth()?.isSoftware).toBe(true);
    session.dispose();
  });

  it('reads the software switch from ?review=1 or __VIRTUALROW_ALLOW_SOFTWARE, and nothing else', () => {
    const at = (search: string, flag?: unknown) =>
      ({ location: { search }, __VIRTUALROW_ALLOW_SOFTWARE: flag }) as unknown as Window;
    expect(softwareAttachRequested(undefined)).toBe(false);
    expect(softwareAttachRequested(at(''))).toBe(false);
    expect(softwareAttachRequested(at('?review=0'))).toBe(false);
    expect(softwareAttachRequested(at('?tier=low&review=1'))).toBe(true);
    expect(softwareAttachRequested(at('', true))).toBe(true);
    expect(softwareAttachRequested(at('', 'yes'))).toBe(false);
  });

  it('falls back on a device request failure', async () => {
    const session = await requestDevice({
      gpu: makeMockGPU(makeMockAdapter({ deviceFails: true })),
    });
    expect(session.state).toEqual({ kind: 'unavailable', reason: 'device-request-failed' });
  });

  it('returns a device on success', async () => {
    const session = await requestDevice({ gpu: makeMockGPU(makeMockAdapter()) });
    expect(session.state.kind).toBe('ready');
    session.dispose();
    // Disposing twice is a no-op.
    session.dispose();
  });

  it('asks for texture-compression-bc when the adapter has it (#562 AC8)', async () => {
    // Replace the adapter's requestDevice with a spy that captures the opts
    // and still returns the mock device shape the real one does. The device
    // itself comes from a sibling makeMockAdapter — one real call so the
    // `lost` promise is wired up and the test does not throw at teardown.
    const inner = makeMockAdapter();
    const innerDevice = await inner.requestDevice();
    const adapter = makeMockAdapter();
    (adapter as unknown as { features: Set<string> }).features = new Set(['texture-compression-bc']);
    let seenFeatures: readonly string[] = [];
    (adapter as unknown as { requestDevice: unknown }).requestDevice = async (opts?: {
      requiredFeatures?: readonly string[];
    }) => {
      seenFeatures = opts?.requiredFeatures ?? [];
      return innerDevice;
    };
    const session = await requestDevice({ gpu: makeMockGPU(adapter) });
    expect(session.state.kind).toBe('ready');
    expect(seenFeatures).toContain('texture-compression-bc');
  });

  it('omits texture-compression-bc when the adapter cannot do it', async () => {
    const inner = makeMockAdapter();
    const innerDevice = await inner.requestDevice();
    const adapter = makeMockAdapter();
    let seenFeatures: readonly string[] | undefined;
    (adapter as unknown as { requestDevice: unknown }).requestDevice = async (opts?: {
      requiredFeatures?: readonly string[];
    }) => {
      seenFeatures = opts?.requiredFeatures;
      return innerDevice;
    };
    const session = await requestDevice({ gpu: makeMockGPU(adapter) });
    expect(session.state.kind).toBe('ready');
    expect(seenFeatures).toEqual([]);
  });

  it('notifies the caller on device loss and marks second loss as unavailable', async () => {
    const onDeviceLost = vi.fn();
    const session = await requestDevice(
      { gpu: makeMockGPU(makeMockAdapter()) },
      { onDeviceLost, isRetry: false },
    );
    expect(session.state.kind).toBe('ready');
    if (session.state.kind !== 'ready') return;
    (session.state.device as unknown as { __triggerLost(): void }).__triggerLost();
    await Promise.resolve();
    expect(onDeviceLost).toHaveBeenCalledWith(null);
    expect(readWebGPUHealth()?.deviceLostCount).toBe(1);

    // A retry whose device also dies lifts the fallback to renderer-unavailable.
    const onSecondLost = vi.fn();
    const retry = await requestDevice(
      { gpu: makeMockGPU(makeMockAdapter()) },
      { onDeviceLost: onSecondLost, isRetry: true },
    );
    if (retry.state.kind !== 'ready') throw new Error('expected ready');
    (retry.state.device as unknown as { __triggerLost(): void }).__triggerLost();
    await Promise.resolve();
    expect(onSecondLost).toHaveBeenCalledWith('renderer-unavailable');
    expect(readWebGPUHealth()?.fallbackReason).toBe('renderer-unavailable');
  });

  it('installs the GPU stub for integration', () => {
    installGPUStub(makeMockGPU(makeMockAdapter()));
    expect((globalThis.navigator as unknown as { gpu?: unknown }).gpu).toBeTruthy();
    installGPUStub(undefined);
    expect((globalThis.navigator as unknown as { gpu?: unknown }).gpu).toBeUndefined();
  });
});

// #729 (Dan's choice, 2026-11-23): get the device on start-button hover or
// focus, so Chrome's synchronous adapter/device work lands before the click.
describe('prewarmDevice (#729)', () => {
  beforeEach(() => {
    resetWebGPUHealth();
    resetPrewarmForTests();
  });

  const spyGPU = (adapter: GPUAdapter | 'throw') => {
    const gpu = makeMockGPU(adapter);
    const requestAdapter = vi.spyOn(gpu, 'requestAdapter');
    return { gpu, requestAdapter };
  };

  it('hands the device it made to the next attach, without asking again', async () => {
    const adapter = makeMockAdapter();
    const requestDeviceSpy = vi.spyOn(adapter, 'requestDevice');
    const { gpu, requestAdapter } = spyGPU(adapter);
    prewarmDevice({ gpu });
    prewarmDevice({ gpu }); // idempotent
    await vi.waitFor(() => expect(requestDeviceSpy).toHaveBeenCalled());
    const early = await requestDeviceSpy.mock.results[0]?.value;
    const session = await requestDevice({ gpu });
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(requestDeviceSpy).toHaveBeenCalledOnce();
    expect(session.state.kind === 'ready' && session.state.device).toBe(early);
    expect(readWebGPUHealth()?.adapter).toContain('mock');
    session.dispose();
  });

  it('is taken once: the next attach asks for its own device', async () => {
    const { gpu, requestAdapter } = spyGPU(makeMockAdapter());
    prewarmDevice({ gpu });
    (await requestDevice({ gpu })).dispose();
    const second = await requestDevice({ gpu });
    expect(second.state.kind).toBe('ready');
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    second.dispose();
  });

  it('is not used by a retry after a device loss', async () => {
    const { gpu, requestAdapter } = spyGPU(makeMockAdapter());
    prewarmDevice({ gpu });
    const retry = await requestDevice({ gpu }, { isRetry: true });
    expect(retry.state.kind).toBe('ready');
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    retry.dispose();
  });

  it('keeps nothing for a software adapter, so the attach declines it as before', async () => {
    const { gpu, requestAdapter } = spyGPU(makeMockAdapter({ software: true }));
    prewarmDevice({ gpu });
    const session = await requestDevice({ gpu });
    expect(session.state).toEqual({ kind: 'unavailable', reason: 'software-adapter' });
    expect(requestAdapter).toHaveBeenCalledTimes(2);
  });

  it('drops a device that was lost while waiting', async () => {
    const adapter = makeMockAdapter();
    const requestDeviceSpy = vi.spyOn(adapter, 'requestDevice');
    const { gpu } = spyGPU(adapter);
    prewarmDevice({ gpu });
    await vi.waitFor(() => expect(requestDeviceSpy).toHaveBeenCalled());
    const early = (await requestDeviceSpy.mock.results[0]?.value) as GPUDevice & {
      __triggerLost: () => void;
    };
    early.__triggerLost();
    const session = await requestDevice({ gpu });
    expect(session.state.kind).toBe('ready');
    expect(session.state.kind === 'ready' && session.state.device).not.toBe(early);
    session.dispose();
  });

  it('swallows a failed request; the attach then asks and reports as usual', async () => {
    const { gpu } = spyGPU('throw');
    prewarmDevice({ gpu });
    const session = await requestDevice({ gpu });
    expect(session.state).toEqual({ kind: 'unavailable', reason: 'adapter-request-failed' });
  });

  it('does nothing without WebGPU', () => {
    expect(() => prewarmDevice(undefined)).not.toThrow();
    expect(() => prewarmDevice({})).not.toThrow();
  });
});
