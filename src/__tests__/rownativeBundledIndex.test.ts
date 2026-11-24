import { describe, expect, it } from 'vitest';
import {
  buildBundledIndex,
  isUsableMirrorEntry,
  projectToBundled,
  readBundledIndex,
  type RownativeMirrorIndexEntry,
} from '../lib/services/rownativeBundledIndex';

const ok: RownativeMirrorIndexEntry = {
  id: '1',
  name: 'Quinsig South to North',
  country: 'United States',
  center_lat: 42.27,
  center_lon: -71.75,
  distance_m: 5306,
  status: 'established',
};

describe('isUsableMirrorEntry (#822)', () => {
  it('accepts an established row with valid coords', () => {
    expect(isUsableMirrorEntry(ok)).toBe(true);
  });

  it('rejects provisional rows', () => {
    expect(isUsableMirrorEntry({ ...ok, status: 'provisional' })).toBe(false);
  });

  it('rejects missing or blank id', () => {
    expect(isUsableMirrorEntry({ ...ok, id: '' })).toBe(false);
    expect(isUsableMirrorEntry({ ...ok, id: undefined })).toBe(false);
  });

  it('rejects missing or blank name', () => {
    expect(isUsableMirrorEntry({ ...ok, name: '' })).toBe(false);
    expect(isUsableMirrorEntry({ ...ok, name: 123 })).toBe(false);
  });

  it('rejects NaN / out-of-range coordinates', () => {
    expect(isUsableMirrorEntry({ ...ok, center_lat: Number.NaN })).toBe(false);
    expect(isUsableMirrorEntry({ ...ok, center_lon: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isUsableMirrorEntry({ ...ok, center_lat: 95 })).toBe(false);
    expect(isUsableMirrorEntry({ ...ok, center_lon: -200 })).toBe(false);
  });

  it('rejects non-numeric coordinates', () => {
    expect(isUsableMirrorEntry({ ...ok, center_lat: '42.27' as unknown as number })).toBe(false);
  });
});

describe('projectToBundled (#822)', () => {
  it('maps upstream keys onto the browser shape', () => {
    expect(projectToBundled(ok)).toEqual({
      id: '1',
      name: 'Quinsig South to North',
      country: 'United States',
      distanceMeters: 5306,
      status: 'established',
      lat: 42.27,
      lng: -71.75,
    });
  });

  it('defaults a missing country to "Unknown"', () => {
    const row = projectToBundled({ ...ok, country: undefined });
    expect(row.country).toBe('Unknown');
  });

  it('defaults a missing distance to 0', () => {
    const row = projectToBundled({ ...ok, distance_m: undefined });
    expect(row.distanceMeters).toBe(0);
  });
});

describe('buildBundledIndex (#822)', () => {
  it('drops provisional rows and sorts by id', () => {
    const out = buildBundledIndex([
      { ...ok, id: 'bravo' },
      { ...ok, id: 'alpha' },
      { ...ok, id: 'skipped', status: 'provisional' },
      { ...ok, id: 'nolatlng', center_lat: undefined },
    ]);
    expect(out.map((r) => r.id)).toEqual(['alpha', 'bravo']);
  });

  it('is empty when the input is empty', () => {
    expect(buildBundledIndex([])).toEqual([]);
  });
});

describe('readBundledIndex (#822)', () => {
  it('passes through a well-formed snapshot', () => {
    const snapshot = buildBundledIndex([ok, { ...ok, id: '2', name: 'Other' }]);
    expect(readBundledIndex(snapshot)).toEqual(snapshot);
  });

  it('returns [] for anything that is not an array', () => {
    expect(readBundledIndex(null)).toEqual([]);
    expect(readBundledIndex({ not: 'an array' })).toEqual([]);
    expect(readBundledIndex('oops')).toEqual([]);
  });

  it('silently drops rows with invalid coordinates', () => {
    const out = readBundledIndex([
      { id: 'a', name: 'A', country: 'X', distanceMeters: 0, status: 'established', lat: 10, lng: 10 },
      { id: 'b', name: 'B', country: 'X', distanceMeters: 0, status: 'established', lat: Number.NaN, lng: 10 },
      { id: '', name: 'C', country: 'X', distanceMeters: 0, status: 'established', lat: 0, lng: 0 },
    ]);
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  it('fills missing optional fields with safe defaults', () => {
    const [row] = readBundledIndex([{ id: 'a', name: 'A', lat: 10, lng: 10 }]);
    expect(row).toMatchObject({ country: 'Unknown', distanceMeters: 0, status: 'established' });
  });
});
