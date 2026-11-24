/**
 * Rownative bundled-index helpers (#822 phase 1).
 *
 * The public GitHub mirror's `courses/index.json` already carries each
 * course's `center_lat` / `center_lon`, so showing every course as a map
 * pin needs no per-course fetch: the build script snapshots the index
 * (filtering out provisional / unusable entries), the browser reads the
 * snapshot from `/assets/rownative/rownative-index.json` on load, and
 * guests see every rownative pin without any runtime network call
 * (NFR3 of #822).
 *
 * Both the Node build script and the browser-side `rownativeService`
 * share these pure helpers so the filtering rule has one home.
 */

/**
 * A row of the upstream `courses/index.json` snapshot used as input.
 *
 * Only the fields we care about are listed; upstream may carry more
 * (e.g. `notes`, `has_path`) and they are ignored.
 */
export interface RownativeMirrorIndexEntry {
  id?: unknown;
  name?: unknown;
  country?: unknown;
  center_lat?: unknown;
  center_lon?: unknown;
  distance_m?: unknown;
  status?: unknown;
}

/** The bundled snapshot row shipped to the browser. */
export interface RownativeBundledCourse {
  id: string;
  name: string;
  country: string;
  distanceMeters: number;
  status: string;
  lat: number;
  lng: number;
}

/**
 * Filter rule — the "active + geometry" set Dan agreed on
 * (issue #822, filtered set): `status === 'established'` (upstream's
 * equivalent of "active"; the other value is `'provisional'`) and
 * a valid `(center_lat, center_lon)` pair in the WGS84 envelope.
 *
 * The id, name and country must also be non-empty strings for the row
 * to be usable on the map.
 */
export function isUsableMirrorEntry(entry: RownativeMirrorIndexEntry): boolean {
  if (typeof entry.id !== 'string' || entry.id.length === 0) return false;
  if (typeof entry.name !== 'string' || entry.name.length === 0) return false;
  if (entry.status !== 'established') return false;
  const lat = entry.center_lat;
  const lng = entry.center_lon;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return false;
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

/**
 * Project one usable mirror entry into a bundled-snapshot row.
 *
 * Caller checks {@link isUsableMirrorEntry} first.
 */
export function projectToBundled(entry: RownativeMirrorIndexEntry): RownativeBundledCourse {
  return {
    id: entry.id as string,
    name: entry.name as string,
    country: typeof entry.country === 'string' && entry.country.length > 0 ? entry.country : 'Unknown',
    distanceMeters: typeof entry.distance_m === 'number' && Number.isFinite(entry.distance_m) ? entry.distance_m : 0,
    status: entry.status as string,
    lat: entry.center_lat as number,
    lng: entry.center_lon as number,
  };
}

/**
 * Walk a raw upstream index, drop everything the filter rule refuses,
 * project the rest to the bundled shape and sort by id so the snapshot
 * on disk has stable diffs.
 */
export function buildBundledIndex(entries: readonly RownativeMirrorIndexEntry[]): RownativeBundledCourse[] {
  return entries
    .filter(isUsableMirrorEntry)
    .map(projectToBundled)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Reverse — read an array that is already a snapshot (whatever its
 * provenance) and keep only the rows that still satisfy the runtime
 * invariants (valid coords + non-empty id/name). Used by the browser
 * loader so a corrupt or outdated snapshot can never introduce a NaN
 * centroid into the clustering layer.
 */
export function readBundledIndex(raw: unknown): RownativeBundledCourse[] {
  if (!Array.isArray(raw)) return [];
  const out: RownativeBundledCourse[] = [];
  for (const row of raw as unknown[]) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<RownativeBundledCourse>;
    if (typeof r.id !== 'string' || r.id.length === 0) continue;
    if (typeof r.name !== 'string' || r.name.length === 0) continue;
    if (typeof r.lat !== 'number' || !Number.isFinite(r.lat) || r.lat < -90 || r.lat > 90) continue;
    if (typeof r.lng !== 'number' || !Number.isFinite(r.lng) || r.lng < -180 || r.lng > 180) continue;
    out.push({
      id: r.id,
      name: r.name,
      country: typeof r.country === 'string' && r.country.length > 0 ? r.country : 'Unknown',
      distanceMeters: typeof r.distanceMeters === 'number' && Number.isFinite(r.distanceMeters) ? r.distanceMeters : 0,
      status: typeof r.status === 'string' ? r.status : 'established',
      lat: r.lat,
      lng: r.lng,
    });
  }
  return out;
}
