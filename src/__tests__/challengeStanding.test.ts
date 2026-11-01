import { describe, it, expect } from 'vitest';

import {
  computeChallengeStanding,
  challengeStandingLine,
} from '../lib/ui/challengeStanding';
import type { ChallengeResult } from '../lib/services/challengesService';

/**
 * #415 Phase 4 — would-have-placed on a challenge's leaderboard
 * (FR5 / AC5.1–AC5.4).
 */

function result(time: number, status = 'valid'): ChallengeResult {
  return {
    rank: 1,
    displayName: 'x',
    rawTimeSeconds: time,
    correctedTimeSeconds: null,
    points: null,
    boatType: null,
    workoutDate: null,
    validationStatus: status,
  };
}

const RESULTS = [
  result(280), // 1st at 4:40
  result(290), // 2nd at 4:50
  result(300), // 3rd at 5:00
  result(310, 'pending'), // dropped
  result(320), // 4th at 5:20
];

describe('computeChallengeStanding (AC5.1)', () => {
  it('ranks a time faster than everyone as 1st', () => {
    const s = computeChallengeStanding({
      challengeName: 'Enschede',
      courseDistanceMeters: 1044,
      rowDistanceMeters: 1044,
      rowDurationSeconds: 270,
      results: RESULTS,
    });
    expect(s).not.toBeNull();
    expect(s!.rank).toBe(1);
    expect(s!.total).toBe(4); // 4 raceable rows (the pending one is out)
    expect(s!.rowTimeLabel).toBe('4:30');
  });

  it('ranks a time between the 2nd and 3rd raceable row as 3rd', () => {
    const s = computeChallengeStanding({
      challengeName: 'Enschede',
      courseDistanceMeters: 1044,
      rowDistanceMeters: 1044,
      rowDurationSeconds: 295, // slower than 290, faster than 300
      results: RESULTS,
    });
    expect(s!.rank).toBe(3);
  });

  it('ranks a time slower than all raceable rows last', () => {
    const s = computeChallengeStanding({
      challengeName: 'Enschede',
      courseDistanceMeters: 1044,
      rowDistanceMeters: 1044,
      rowDurationSeconds: 999,
      results: RESULTS,
    });
    expect(s!.rank).toBe(5); // 4 raceable + 1 (this row), last position
  });

  it('refuses a row short of the course distance (AC5.3)', () => {
    const s = computeChallengeStanding({
      challengeName: 'Enschede',
      courseDistanceMeters: 1044,
      rowDistanceMeters: 500,
      rowDurationSeconds: 150,
      results: RESULTS,
    });
    expect(s).toBeNull();
  });

  it('tolerates a few metres short (the finish-gate crossed round-off)', () => {
    const s = computeChallengeStanding({
      challengeName: 'Enschede',
      courseDistanceMeters: 1044,
      rowDistanceMeters: 1030, // 14m under, inside 25m default slack
      rowDurationSeconds: 300,
      results: RESULTS,
    });
    expect(s).not.toBeNull();
  });

  it('returns null when there are no raceable results (AC4.5 → AC5)', () => {
    const s = computeChallengeStanding({
      challengeName: 'Empty',
      courseDistanceMeters: 1000,
      rowDistanceMeters: 1000,
      rowDurationSeconds: 300,
      results: [result(300, 'pending'), result(310, 'invalid')],
    });
    expect(s).toBeNull();
  });
});

describe('challengeStandingLine (AC5.2)', () => {
  it('states the comparison and the field size (total = raceable + the row itself)', () => {
    const line = challengeStandingLine({
      rank: 3,
      total: 11, // 11 raceable → field of 12 for the comparison
      rowTimeLabel: '4:37',
      challengeName: 'Enschede',
    });
    expect(line).toBe('Your 4:37 would have been 3rd of 12 on Enschede');
  });

  it('handles the ordinal edge cases', () => {
    expect(
      challengeStandingLine({ rank: 1, total: 10, rowTimeLabel: '4:30', challengeName: 'X' }),
    ).toContain('1st');
    expect(
      challengeStandingLine({ rank: 2, total: 10, rowTimeLabel: '4:30', challengeName: 'X' }),
    ).toContain('2nd');
    expect(
      challengeStandingLine({ rank: 3, total: 10, rowTimeLabel: '4:30', challengeName: 'X' }),
    ).toContain('3rd');
    expect(
      challengeStandingLine({ rank: 11, total: 20, rowTimeLabel: '4:30', challengeName: 'X' }),
    ).toContain('11th');
    expect(
      challengeStandingLine({ rank: 21, total: 30, rowTimeLabel: '4:30', challengeName: 'X' }),
    ).toContain('21st');
  });
});
