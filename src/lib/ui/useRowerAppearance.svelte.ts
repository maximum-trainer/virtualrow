/**
 * The rower's clothing/hair/hat choices, remembered (issue #474) — Svelte-runes
 * port of the React `useRowerAppearance` hook.
 *
 * Backed by the framework-free `rowerAppearanceService`, so the stored shape is
 * the same one the (future) scene reads. The scene-side `resolveAppearanceColors`
 * is deliberately NOT pulled in here — it is three.js code that lands with the
 * workout/scene slice.
 */
import { createDefaultRowerAppearanceService } from '../services/profileSync';
import {
  DEFAULT_ROWER_APPEARANCE,
  type RowerAppearancePreference,
  type RowerAppearanceService,
} from '../services/rowerAppearanceService';

export class RowerAppearanceStore {
  readonly #service: RowerAppearanceService;

  appearance = $state<RowerAppearancePreference>({ ...DEFAULT_ROWER_APPEARANCE });

  constructor(service: RowerAppearanceService = createDefaultRowerAppearanceService()) {
    this.#service = service;
    this.appearance = service.read();
    void this.sync();
  }

  /**
   * Pull the signed-in athlete's server copy (#477) and show it when it is
   * newer. A no-op for guests, offline, or when no API is configured.
   */
  async sync(): Promise<void> {
    const next = await this.#service.sync?.();
    if (next) this.appearance = next;
  }

  setSlot<K extends keyof RowerAppearancePreference>(
    slot: K,
    value: RowerAppearancePreference[K],
  ): void {
    const next = { ...this.appearance, [slot]: value };
    this.#service.write(next);
    this.appearance = next;
  }

  reset(): void {
    this.#service.write(DEFAULT_ROWER_APPEARANCE);
    this.appearance = { ...DEFAULT_ROWER_APPEARANCE };
  }
}
