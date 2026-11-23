/**
 * Client for the virtualrow Worker's per-field profile API (#37, #477).
 *
 * `GET/PUT {baseUrl}/api/profile/{field}` with the athlete's intervals.icu
 * access token as a Bearer. Every failure (no token, network, 401, 5xx)
 * resolves to `null` so callers fall back to their local copy: the server is
 * a sync target, never a hard dependency.
 */
export type ProfileField = 'appearance' | 'colours';

export interface StoredProfileValue<T = unknown> {
  value: T | null;
  updatedAt: number | null;
}

export interface ProfileApiClient {
  get<T>(field: ProfileField): Promise<StoredProfileValue<T> | null>;
  /** On a 409 (server holds a newer copy) resolves to that newer copy. */
  put<T>(field: ProfileField, value: T, updatedAt: number): Promise<StoredProfileValue<T> | null>;
}

export interface ProfileApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: typeof fetch;
}

export function createProfileApiClient(options: ProfileApiClientOptions): ProfileApiClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(field: ProfileField, init: RequestInit): Promise<StoredProfileValue<T> | null> {
    const token = options.getToken();
    if (!token) return null;
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      const res = await doFetch(`${base}/api/profile/${field}`, { ...init, headers });
      if (!res.ok && res.status !== 409) return null;
      const body = (await res.json()) as StoredProfileValue<T>;
      return { value: body.value ?? null, updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : null };
    } catch {
      return null;
    }
  }

  return {
    get: (field) => call(field, { method: 'GET' }),
    put: (field, value, updatedAt) =>
      call(field, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, updatedAt }),
      }),
  };
}
