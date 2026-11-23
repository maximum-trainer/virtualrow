import { describe, expect, it, vi } from 'vitest';
import { createProfileApiClient } from '../lib/services/profileApiClient';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('profileApiClient (#37/#477)', () => {
  it('GETs a field with the bearer token and returns the stored copy', async () => {
    const fetchMock = vi.fn(async () => json({ value: { top: 'red' }, updatedAt: 5 }));
    const client = createProfileApiClient({ baseUrl: 'https://api.test/', getToken: () => 'tok', fetch: fetchMock });
    await expect(client.get('appearance')).resolves.toEqual({ value: { top: 'red' }, updatedAt: 5 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/profile/appearance');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
  });

  it('PUTs { value, updatedAt } as JSON', async () => {
    const fetchMock = vi.fn(async () => json({ value: 1, updatedAt: 9 }));
    const client = createProfileApiClient({ baseUrl: 'https://api.test', getToken: () => 'tok', fetch: fetchMock });
    await client.put('colours', 1, 9);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ value: 1, updatedAt: 9 });
  });

  it('returns the newer server copy on a 409', async () => {
    const fetchMock = vi.fn(async () => json({ value: 'new', updatedAt: 20 }, 409));
    const client = createProfileApiClient({ baseUrl: 'https://api.test', getToken: () => 'tok', fetch: fetchMock });
    await expect(client.put('appearance', 'old', 10)).resolves.toEqual({ value: 'new', updatedAt: 20 });
  });

  it('skips the network and returns null with no token', async () => {
    const fetchMock = vi.fn();
    const client = createProfileApiClient({ baseUrl: 'https://api.test', getToken: () => null, fetch: fetchMock });
    await expect(client.get('appearance')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on an error status or a network failure', async () => {
    const unauthorized = createProfileApiClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: vi.fn(async () => json({ error: 'unauthorized' }, 401)),
    });
    await expect(unauthorized.get('appearance')).resolves.toBeNull();
    const offline = createProfileApiClient({
      baseUrl: 'https://api.test',
      getToken: () => 'tok',
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await expect(offline.get('appearance')).resolves.toBeNull();
  });
});
