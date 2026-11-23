import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileApiClient, StoredProfileValue } from '../lib/services/profileApiClient';
import {
  createDefaultRowerAppearanceService,
  createSyncedRowerAppearanceService,
  ROWER_APPEARANCE_UPDATED_AT_KEY,
} from '../lib/services/profileSync';
import {
  createLocalStorageRowerAppearanceService,
  DEFAULT_ROWER_APPEARANCE,
  ROWER_APPEARANCE_STORAGE_KEY,
} from '../lib/services/rowerAppearanceService';

const RED = { ...DEFAULT_ROWER_APPEARANCE, top: 'red' };
const FOREST = { ...DEFAULT_ROWER_APPEARANCE, shorts: 'forest' };

function fakeClient(server: StoredProfileValue | null) {
  const client = {
    get: vi.fn(async () => server),
    put: vi.fn(async (_f: string, value: unknown, updatedAt: number) => ({ value, updatedAt })),
  };
  return client as typeof client & ProfileApiClient;
}

function synced(server: StoredProfileValue | null, now = 1_000) {
  const client = fakeClient(server);
  const local = createLocalStorageRowerAppearanceService();
  return { client, service: createSyncedRowerAppearanceService({ local, client, now: () => now }) };
}

describe('profileSync: rower appearance (#477)', () => {
  beforeEach(() => localStorage.clear());

  it('stamps and pushes every write', () => {
    const { client, service } = synced(null, 42);
    service.write(RED);
    expect(service.read()).toEqual(RED);
    expect(localStorage.getItem(ROWER_APPEARANCE_UPDATED_AT_KEY)).toBe('42');
    expect(client.put).toHaveBeenCalledWith('appearance', RED, 42);
  });

  it('uploads a local choice once when the server is empty', async () => {
    localStorage.setItem(ROWER_APPEARANCE_STORAGE_KEY, JSON.stringify(RED));
    const { client, service } = synced({ value: null, updatedAt: null }, 7);
    await expect(service.sync?.()).resolves.toBeNull();
    expect(client.put).toHaveBeenCalledWith('appearance', RED, 7);
  });

  it('uploads nothing when neither side has a choice', async () => {
    const { client, service } = synced({ value: null, updatedAt: null });
    await service.sync?.();
    expect(client.put).not.toHaveBeenCalled();
  });

  it('takes the server copy when it is newer', async () => {
    localStorage.setItem(ROWER_APPEARANCE_STORAGE_KEY, JSON.stringify(RED));
    localStorage.setItem(ROWER_APPEARANCE_UPDATED_AT_KEY, '100');
    const { service } = synced({ value: FOREST, updatedAt: 200 });
    await expect(service.sync?.()).resolves.toEqual(FOREST);
    expect(service.read()).toEqual(FOREST);
    expect(localStorage.getItem(ROWER_APPEARANCE_UPDATED_AT_KEY)).toBe('200');
  });

  it('takes the server copy on a device with no local choice', async () => {
    const { service } = synced({ value: FOREST, updatedAt: 5 });
    await expect(service.sync?.()).resolves.toEqual(FOREST);
  });

  it('pushes the local copy when it is newer', async () => {
    localStorage.setItem(ROWER_APPEARANCE_STORAGE_KEY, JSON.stringify(RED));
    localStorage.setItem(ROWER_APPEARANCE_UPDATED_AT_KEY, '300');
    const { client, service } = synced({ value: FOREST, updatedAt: 200 });
    await expect(service.sync?.()).resolves.toBeNull();
    expect(client.put).toHaveBeenCalledWith('appearance', RED, 300);
  });

  it('sanitises a server value the palette no longer knows', async () => {
    const { service } = synced({ value: { ...FOREST, top: 'puce' }, updatedAt: 5 });
    const next = await service.sync?.();
    expect(next?.top).toBe(DEFAULT_ROWER_APPEARANCE.top);
    expect(next?.shorts).toBe('forest');
  });

  it('leaves the local copy alone when the server is unreachable', async () => {
    localStorage.setItem(ROWER_APPEARANCE_STORAGE_KEY, JSON.stringify(RED));
    const { client, service } = synced(null);
    await expect(service.sync?.()).resolves.toBeNull();
    expect(service.read()).toEqual(RED);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('stays local-only when no API base URL is configured', () => {
    const service = createDefaultRowerAppearanceService(null);
    expect(service.sync).toBeUndefined();
  });

  it('syncs when an API base URL is configured', () => {
    const service = createDefaultRowerAppearanceService('https://api.test');
    expect(typeof service.sync).toBe('function');
  });
});
