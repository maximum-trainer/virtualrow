/**
 * Challenge status label derived from the clock (#415 FR2.3 / AC2.3).
 *
 * rownative's own rule: `rowStart > now` → **Upcoming**; `now > submitEnd` →
 * **Submissions closed**; otherwise **Open**. It is only a label — rowing a
 * past challenge's course on a Tuesday in February is fine (FR3.4) because
 * nothing is being submitted.
 *
 * The function takes `now` so a test can pin a time without faking `Date`.
 */
import type { Challenge } from '../services/challengesService';

export type ChallengeLabel = 'Upcoming' | 'Open' | 'Submissions closed';

export function challengeStatusLabel(challenge: Challenge, now: Date = new Date()): ChallengeLabel {
  const t = now.getTime();
  if (challenge.rowStart.getTime() > t) return 'Upcoming';
  if (t > challenge.submitEnd.getTime()) return 'Submissions closed';
  return 'Open';
}

/** Format a row window as "1 Nov – 30 Nov 2026" for a card header. */
export function formatChallengeWindow(challenge: Challenge): string {
  const fmt: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  const start = challenge.rowStart.toLocaleDateString('en-GB', fmt);
  const end = challenge.rowEnd.toLocaleDateString('en-GB', {
    ...fmt,
    year: 'numeric',
  });
  return `${start} – ${end}`;
}
