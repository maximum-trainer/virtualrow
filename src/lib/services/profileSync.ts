/**
 * Cross-device sync for profile preferences through the virtualrow Worker
 * (#37, #477). The local adapter stays the source the UI reads synchronously;
 * this layer timestamps each write, pushes it to the Worker, and on `sync()`
 * reconciles with the server copy by last-write-wins on that timestamp.
 *
 * First sync on a device with a local choice and an empty server uploads the
 * local copy once (a guest's pick survives signing in). After that the newer
 * timestamp wins in both directions.
 */
import { authService } from './authService';
import { createProfileApiClient, type ProfileApiClient } from './profileApiClient';
import {
  createLocalStorageRowerAppearanceService,
  ROWER_APPEARANCE_STORAGE_KEY,
  sanitizeAppearance,
  type RowerAppearancePreference,
  type RowerAppearanceService,
} from './rowerAppearanceService';

export const ROWER_APPEARANCE_UPDATED_AT_KEY = `${ROWER_APPEARANCE_STORAGE_KEY}:updatedAt`;

export interface SyncedAppearanceOptions {
  local: RowerAppearanceService;
  client: ProfileApiClient;
  now?: () => number;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

export function createSyncedRowerAppearanceService(options: SyncedAppearanceOptions): RowerAppearanceService {
  const { local, client } = options;
  const now = options.now ?? Date.now;
  const storage = options.storage ?? safeLocalStorage();

  /** Local write time; 0 for a choice saved before sync existed; null when none. */
  const localUpdatedAt = (): number | null => {
    const stamped = Number(storage?.getItem(ROWER_APPEARANCE_UPDATED_AT_KEY));
    if (Number.isFinite(stamped) && stamped > 0) return stamped;
    return storage?.getItem(ROWER_APPEARANCE_STORAGE_KEY) ? 0 : null;
  };
  const stamp = (at: number) => {
    try {
      storage?.setItem(ROWER_APPEARANCE_UPDATED_AT_KEY, String(at));
    } catch {
      // Unstamped writes just lose the next tie-break.
    }
  };
  const push = (appearance: RowerAppearancePreference, at: number) => {
    void client.put('appearance', appearance, at);
  };

  return {
    read: () => local.read(),
    write: (appearance) => {
      local.write(appearance);
      const at = now();
      stamp(at);
      push(appearance, at);
    },
    async sync() {
      const server = await client.get<unknown>('appearance');
      if (!server) return null;
      const mine = localUpdatedAt();
      if (server.value == null || server.updatedAt == null) {
        if (mine != null) {
          const at = mine || now();
          stamp(at);
          push(local.read(), at);
        }
        return null;
      }
      if (mine == null || server.updatedAt > mine) {
        const next = sanitizeAppearance(server.value);
        local.write(next);
        stamp(server.updatedAt);
        return next;
      }
      if (mine > server.updatedAt) push(local.read(), mine);
      return null;
    },
  };
}

/** The Worker's base URL, baked at build time; unset keeps the app local-only. */
export function readApiBaseUrl(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const value = env?.VITE_API_BASE_URL;
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function createDefaultRowerAppearanceService(
  baseUrl: string | null = readApiBaseUrl(),
): RowerAppearanceService {
  const local = createLocalStorageRowerAppearanceService();
  if (!baseUrl) return local;
  const client = createProfileApiClient({ baseUrl, getToken: () => authService.getAccessToken() });
  return createSyncedRowerAppearanceService({ local, client });
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
