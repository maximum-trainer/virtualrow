export interface Athlete {
  id: string;
  name: string;
  email: string;
}

export type FetchAthlete = (token: string) => Promise<Athlete | null>;

const INTERVALS_PROFILE_URL = 'https://intervals.icu/api/v1/athlete/0';

// intervals.icu resolves /athlete/0 to the athlete that owns the bearer token.
export const fetchIntervalsAthlete: FetchAthlete = async (token) => {
  const res = await fetch(INTERVALS_PROFILE_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const raw = (await res.json()) as { id?: string | number; name?: string; email?: string };
  if (raw.id == null) return null;
  return { id: String(raw.id), name: raw.name?.trim() || `Athlete ${raw.id}`, email: raw.email ?? '' };
};

async function tokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Per-isolate cache so each token costs one intervals.icu round trip per TTL.
// Keys are token hashes, so a heap dump never holds a usable token.
export function createAthleteVerifier(fetchAthlete: FetchAthlete, now: () => number, ttlMs = 10 * 60_000) {
  const cache = new Map<string, { athlete: Athlete; expires: number }>();
  return async function verify(request: Request): Promise<Athlete | null> {
    const header = request.headers.get('Authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/.exec(header);
    if (!match?.[1]) return null;
    const key = await tokenKey(match[1]);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.athlete;
    const athlete = await fetchAthlete(match[1]);
    if (athlete) cache.set(key, { athlete, expires: now() + ttlMs });
    else cache.delete(key);
    return athlete;
  };
}
