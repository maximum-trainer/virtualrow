import { describe, it, expect } from 'vitest';

import { challengeStatusLabel, formatChallengeWindow } from '../lib/ui/challengeStatus';
import type { Challenge } from '../lib/services/challengesService';

/**
 * #415 FR2.3 / AC2.3 — status label derived from the clock. Three windows
 * either side of `rowStart` and `submitEnd`, plus the boundary instants
 * (rowStart == now → Open; submitEnd == now → Open; one millisecond later
 * → Submissions closed).
 */

function makeChallenge(partial: Partial<Challenge>): Challenge {
  return {
    id: 'c',
    name: 'Challenge',
    courseId: '273',
    courseName: 'Twentekanaal 1 km',
    distanceMeters: 1044,
    rowStart: new Date('2026-11-01T06:00:00Z'),
    rowEnd: new Date('2026-11-30T18:00:00Z'),
    submitEnd: new Date('2026-12-01T18:00:00Z'),
    hasHandicap: false,
    organizerName: null,
    resultsCount: 0,
    notes: null,
    ...partial,
  };
}

describe('challengeStatusLabel', () => {
  const challenge = makeChallenge({});

  it('is Upcoming while now is before rowStart', () => {
    expect(challengeStatusLabel(challenge, new Date('2026-10-31T23:59:59Z'))).toBe('Upcoming');
  });

  it('is Open at the rowStart boundary', () => {
    expect(challengeStatusLabel(challenge, challenge.rowStart)).toBe('Open');
  });

  it('is Open between rowStart and submitEnd', () => {
    expect(challengeStatusLabel(challenge, new Date('2026-11-15T12:00:00Z'))).toBe('Open');
  });

  it('is still Open at the submitEnd instant', () => {
    expect(challengeStatusLabel(challenge, challenge.submitEnd)).toBe('Open');
  });

  it('is Submissions closed one millisecond past submitEnd', () => {
    const after = new Date(challenge.submitEnd.getTime() + 1);
    expect(challengeStatusLabel(challenge, after)).toBe('Submissions closed');
  });

  it('is Submissions closed long after submitEnd', () => {
    expect(challengeStatusLabel(challenge, new Date('2027-01-01T00:00:00Z'))).toBe('Submissions closed');
  });
});

describe('formatChallengeWindow', () => {
  it('renders "1 Nov – 30 Nov 2026" for the standard month-long window', () => {
    const challenge = makeChallenge({
      rowStart: new Date('2026-11-01T06:00:00Z'),
      rowEnd: new Date('2026-11-30T18:00:00Z'),
    });
    const text = formatChallengeWindow(challenge);
    expect(text).toContain('Nov');
    expect(text).toContain('2026');
    expect(text).toContain('–');
  });
});
