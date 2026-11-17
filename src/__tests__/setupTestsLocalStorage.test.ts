// @vitest-environment node
//
// Node 22+ ships a built-in `Storage` whose prototype has a non-configurable
// `length` getter. `src/setupTests.ts`'s fallback localStorage polyfill used
// to `Object.defineProperty(Storage.prototype, 'length', …)` unconditionally,
// which threw `TypeError: Cannot redefine property: length` on Dan's Windows
// laptop and failed the whole `node`-environment suite (`bundleBudget`,
// others). The suite passed on CI because its pinned Node version did not
// expose that built-in.
//
// This spec pins the fix: in a `node`-env test, `setupTests.ts` loaded
// without throwing and gave us a working `localStorage`. If a future rewrite
// reintroduces the unconditional `defineProperty` on the built-in prototype,
// this test will trip before the rest of the Node-env suite does.
import { describe, expect, it } from 'vitest';

describe('setupTests localStorage polyfill (#680 follow-up)', () => {
  it('leaves a usable localStorage in a node-environment test', () => {
    expect(typeof globalThis.localStorage).toBe('object');
    expect(typeof globalThis.localStorage.getItem).toBe('function');
    expect(typeof globalThis.localStorage.setItem).toBe('function');
    expect(typeof globalThis.localStorage.removeItem).toBe('function');
    expect(typeof globalThis.localStorage.clear).toBe('function');
    expect(typeof globalThis.localStorage.key).toBe('function');

    globalThis.localStorage.clear();
    globalThis.localStorage.setItem('k', 'v');
    expect(globalThis.localStorage.getItem('k')).toBe('v');
    expect(globalThis.localStorage.length).toBeGreaterThanOrEqual(1);
    globalThis.localStorage.removeItem('k');
    expect(globalThis.localStorage.getItem('k')).toBeNull();
  });
});
