import { describe, it, expect, vi } from 'vitest';

import {
  ChallengesService,
  isRaceable,
  paceOf,
  type ChallengeResult,
} from '../lib/services/challengesService';
import type { ChallengesPort } from '../lib/ports';

/**
 * #415 Phase 1 — read-only client for rownative's Speed Orders API.
 *
 * Covers FR1 (AC1.1 parse, AC1.2 results, AC1.3 read-only port surface,
 * AC1.4 per-status cache, AC1.5 fault tolerance → `[]`, AC1.6 hard-coded
 * fetch origin) and the two pure helpers (`isRaceable`, `paceOf`) that
 * Phase 3 will use to drive the ghost at a leaderboard pace.
 *
 * The service is written against injected `fetch`, so no network is used.
 */

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const liveChallenge = {
  id: 'test-challenge-enschede',
  name: 'Test Challenge Enschede',
  courseId: '273',
  courseName: 'Twentekanaal 1 km',
  distance_m: 1044,
  rowStart: '2026-11-01T06:00:00Z',
  rowEnd: '2026-11-30T18:00:00Z',
  submitEnd: '2026-12-01T18:00:00Z',
  hasHandicap: false,
  organizerName: null,
  resultsCount: 12,
  notes: null,
};

const liveResult = {
  rank: 1,
  displayName: 'Sander Roosendaal',
  rawTimeS: 278.0,
  correctedTimeS: null,
  points: null,
  boatType: null,
  workoutDate: '2026-11-02',
  validationStatus: 'valid',
};

describe('ChallengesService.listChallenges', () => {
  it('parses the live response shape into typed Challenges (AC1.1)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okJson({ challenges: [liveChallenge] }));
    const service = new ChallengesService(fetchImpl);

    const [c] = await service.listChallenges('active');

    expect(c.id).toBe('test-challenge-enschede');
    expect(c.courseId).toBe('273');
    expect(c.distanceMeters).toBe(1044);
    expect(c.rowStart).toBeInstanceOf(Date);
    expect(c.rowStart.toISOString()).toBe('2026-11-01T06:00:00.000Z');
    expect(c.hasHandicap).toBe(false);
    expect(c.resultsCount).toBe(12);
    // null-valued optional fields survive unchanged, not coerced to defaults.
    expect(c.organizerName).toBeNull();
    expect(c.notes).toBeNull();
  });

  it('fetches rownative.icu, not an arbitrary host (AC1.6)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okJson({ challenges: [] }));
    const service = new ChallengesService(fetchImpl);

    await service.listChallenges('upcoming');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://rownative.icu/api/challenges?status=upcoming');
  });

  it('serves repeat callers from the per-status cache (AC1.4)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ challenges: [liveChallenge] }));
    const service = new ChallengesService(fetchImpl);

    await service.listChallenges('active');
    await service.listChallenges('active');
    await service.listChallenges('active');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('separates the cache per status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ challenges: [] }));
    const service = new ChallengesService(fetchImpl);

    await service.listChallenges('active');
    await service.listChallenges('upcoming');
    await service.listChallenges('past');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('resolves to [] on HTTP 500 (AC1.5)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const service = new ChallengesService(fetchImpl);

    await expect(service.listChallenges('active')).resolves.toEqual([]);
  });

  it('resolves to [] on a thrown fetch (AC1.5)', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const service = new ChallengesService(fetchImpl);

    await expect(service.listChallenges('active')).resolves.toEqual([]);
  });

  it('resolves to [] when the body is an HTML error page (AC1.5)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response('<!doctype html><html><body>oops</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const service = new ChallengesService(fetchImpl);

    await expect(service.listChallenges('active')).resolves.toEqual([]);
  });

  it('drops rows whose structural fields are missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      okJson({
        challenges: [
          { ...liveChallenge, id: null }, // no id
          { ...liveChallenge, distance_m: 0 }, // zero distance
          { ...liveChallenge, rowStart: 'not-a-date' }, // bad window
          liveChallenge, // kept
        ],
      }),
    );
    const service = new ChallengesService(fetchImpl);

    const list = await service.listChallenges('active');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(liveChallenge.id);
  });
});

describe('ChallengesService.challengeResults', () => {
  it('parses the leaderboard rows and ranks them (AC1.2)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      okJson({
        results: [
          { ...liveResult, rank: 3, displayName: 'Bronze' },
          { ...liveResult, rank: 1, displayName: 'Sander Roosendaal' },
          { ...liveResult, rank: 2, displayName: 'Silver' },
        ],
      }),
    );
    const service = new ChallengesService(fetchImpl);

    const results = await service.challengeResults('test-challenge-enschede');

    expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(results[0].rawTimeSeconds).toBe(278.0);
    // Optional fields come through verbatim.
    expect(results[0].correctedTimeSeconds).toBeNull();
    expect(results[0].points).toBeNull();
  });

  it('caches per-challenge (AC1.4) and URL-encodes the id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ results: [liveResult] }));
    const service = new ChallengesService(fetchImpl);

    await service.challengeResults('weird id/with slash');
    await service.challengeResults('weird id/with slash');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rownative.icu/api/challenges/weird%20id%2Fwith%20slash/results',
    );
  });

  it('resolves to [] when the leaderboard fails (AC1.5)', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('nope'));
    const service = new ChallengesService(fetchImpl);

    await expect(service.challengeResults('any')).resolves.toEqual([]);
  });

  it('drops malformed rows but keeps the rest', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      okJson({
        results: [
          { ...liveResult, rank: null },
          { ...liveResult, displayName: '' },
          { ...liveResult, rawTimeS: 'oops' },
          { ...liveResult, validationStatus: null },
          liveResult,
        ],
      }),
    );
    const service = new ChallengesService(fetchImpl);

    const results = await service.challengeResults('x');
    expect(results).toHaveLength(1);
  });
});

describe('isRaceable', () => {
  const base: ChallengeResult = {
    rank: 1,
    displayName: 'x',
    rawTimeSeconds: 1,
    correctedTimeSeconds: null,
    points: null,
    boatType: null,
    workoutDate: null,
    validationStatus: 'valid',
  };

  it('accepts valid and manual_ok', () => {
    expect(isRaceable({ ...base, validationStatus: 'valid' })).toBe(true);
    expect(isRaceable({ ...base, validationStatus: 'manual_ok' })).toBe(true);
  });

  it('rejects pending, invalid and dq (AC4.2)', () => {
    expect(isRaceable({ ...base, validationStatus: 'pending' })).toBe(false);
    expect(isRaceable({ ...base, validationStatus: 'invalid' })).toBe(false);
    expect(isRaceable({ ...base, validationStatus: 'dq' })).toBe(false);
    expect(isRaceable({ ...base, validationStatus: 'anything-else' })).toBe(false);
  });
});

describe('paceOf', () => {
  const base: ChallengeResult = {
    rank: 1,
    displayName: 'x',
    rawTimeSeconds: 277.7,
    correctedTimeSeconds: null,
    points: null,
    boatType: null,
    workoutDate: null,
    validationStatus: 'valid',
  };

  it('turns a raw time over a known distance into s/500m (#338)', () => {
    // 277.7 s over 1044 m → 277.7 / (1044 / 500) = 133.0 s/500m (≈ 2:13)
    const pace = paceOf(base, 1044)!;
    expect(pace).toBeCloseTo(133.0, 1);
  });

  it('returns null for a zero or negative distance', () => {
    expect(paceOf(base, 0)).toBeNull();
    expect(paceOf(base, -1)).toBeNull();
  });
});

describe('ChallengesPort surface (AC1.3)', () => {
  it('exposes only read methods', () => {
    // The port is a Pick<ChallengesService, 'listChallenges' | 'challengeResults'>.
    // We assemble a port-typed value from a real service instance and read
    // its own enumerable method keys off the class prototype — adding a
    // `submit` to the service would fail the length check and the key list,
    // not just the type system (which a cast could silence).
    const service = new ChallengesService();
    const port: ChallengesPort = service;
    const methods: Array<keyof ChallengesPort> = ['listChallenges', 'challengeResults'];
    for (const m of methods) {
      expect(typeof port[m]).toBe('function');
    }
    // No stray write methods accidentally added to the service itself.
    const writeShaped = Object.getOwnPropertyNames(ChallengesService.prototype).filter((n) =>
      /^(submit|create|update|delete|post|put|patch|upload)/i.test(n),
    );
    expect(writeShaped).toEqual([]);
  });
});
