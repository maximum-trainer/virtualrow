import { afterEach, describe, expect, it, vi } from 'vitest';
import { RownativeService, bundledRownativeIndexUrl } from '../lib/services/rownativeService';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('RownativeService.getBundledIndex (#822)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns parsed, filtered rows from the bundled snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: '1', name: 'A', country: 'US', distanceMeters: 1000, status: 'established', lat: 42, lng: -71 },
        { id: 'bad', name: '', country: 'US', distanceMeters: 0, status: 'established', lat: 0, lng: 0 },
      ]),
    );

    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    const rows = await service.getBundledIndex();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(bundledRownativeIndexUrl());
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('1');
  });

  it('caches on success — a second call does not refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ id: '1', name: 'A', lat: 1, lng: 1 }]),
    );
    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    const a = await service.getBundledIndex();
    const b = await service.getBundledIndex();
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls into one request', async () => {
    let resolveFetch!: (value: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    const [p1, p2] = [service.getBundledIndex(), service.getBundledIndex()];
    resolveFetch(jsonResponse([{ id: '1', name: 'A', lat: 1, lng: 1 }]));
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns [] on a non-OK response, without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    expect(await service.getBundledIndex()).toEqual([]);
  });

  it('returns [] on a fetch rejection', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    expect(await service.getBundledIndex()).toEqual([]);
  });

  it('returns [] when the payload is not an array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ not: 'array' }));
    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    expect(await service.getBundledIndex()).toEqual([]);
  });

  it('honours a caller-supplied URL (SvelteKit deploy base)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ id: '1', name: 'A', lat: 1, lng: 1 }]),
    );
    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    await service.getBundledIndex('/virtualrow/app/assets/rownative/rownative-index.json');
    expect(fetchMock).toHaveBeenCalledWith('/virtualrow/app/assets/rownative/rownative-index.json');
  });
});
