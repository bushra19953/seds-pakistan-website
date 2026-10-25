/**
 * §3.4 normalization equivalence for E4's census sites (jsdom).
 *
 * For every S-TS shape of the SAME instant (the forms enumerated in
 * supa-events-seam-contracts.test.ts: Firestore Timestamp-like,
 * seam {seconds,nanoseconds,toDate()}, serialized {seconds,
 * nanoseconds}, ISO string, Date, epoch ms), each converted site
 * must produce the identical result — and for a genuine Firestore
 * Timestamp that result equals today's pre-migration result.
 *
 * Real-function coverage:
 *   site #4  computeTimeLeft (registration-deadline-countdown) +
 *            a real render of the countdown component.
 *   site #3  computeCtaState (event-cta) deadline enforcement.
 *   site #10 eventDateToIso (events-workshops-section).
 *   site #11 eventDateToIso (homepage-event-feed).
 * Sites #1 (countdown in _event-client) and #2 (formatDate closure
 * in events/detail) are not exported functions; they are pinned by
 * source assertions below (both now route through eventInstantToMs
 * and neither retains a .seconds/.toDate() read), and the oracle
 * equivalence they rely on is S-TS-01..04 in the seam contracts.
 */

import React from 'react';
(globalThis as any).React = React;

import { render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

// The components under test import the firebase module graph (which
// needs TextEncoder at load in jsdom); the functions tested here are
// pure, so the hooks are mocked away.
jest.mock('@/firebase', () => ({
  useUser: () => ({ user: null, role: null, isLoading: false }),
  useFirestore: () => ({}),
  useDoc: () => ({ data: null, loading: false }),
}));
jest.mock('@/firebase/provider', () => ({
  useFirestore: () => ({}),
}));

import RegistrationDeadlineCountdown, {
  computeTimeLeft,
} from '@/components/events/registration-deadline-countdown';
import { computeCtaState } from '@/components/events/event-cta';
import { eventDateToIso as workshopsDateToIso } from '@/components/home/events-workshops-section';
import { eventDateToIso as feedDateToIso } from '@/components/home/homepage-event-feed';

// 2026-10-25 10:00:00.250 PKT == 2026-10-25 05:00:00.250 UTC.
const INSTANT_MS = Date.UTC(2026, 9, 25, 5, 0, 0) + 250;
const SECONDS = Math.floor(INSTANT_MS / 1000);
const NANOS = 250_000_000;
const ISO = new Date(INSTANT_MS).toISOString();

const FORMS: Record<string, unknown> = {
  'Firestore Timestamp-like': {
    seconds: SECONDS,
    nanoseconds: NANOS,
    toMillis: () => INSTANT_MS,
    toDate: () => new Date(INSTANT_MS),
  },
  'seam {seconds,nanoseconds,toDate()}': {
    seconds: SECONDS,
    nanoseconds: NANOS,
    toDate: () => new Date(INSTANT_MS),
  },
  'serialized {seconds,nanoseconds}': { seconds: SECONDS, nanoseconds: NANOS },
  'ISO instant string': ISO,
  Date: new Date(INSTANT_MS),
  'epoch millis': INSTANT_MS,
};

const NOW = Date.UTC(2026, 9, 23, 5, 0, 0); // two days before the instant

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('site #10 (workshops event_date) and #11 (feed event_date): oracle ISO conversion', () => {
  it('every S-TS shape produces the identical ISO string', () => {
    for (const [label, value] of Object.entries(FORMS)) {
      expect({ label, iso: workshopsDateToIso(value) }).toEqual({ label, iso: ISO });
      expect({ label, iso: feedDateToIso(value) }).toEqual({ label, iso: ISO });
    }
  });

  it('matches the old .toDate().toISOString() output for a genuine Timestamp shape', () => {
    const genuine = FORMS['Firestore Timestamp-like'] as { toDate: () => Date };
    expect(workshopsDateToIso(genuine)).toBe(genuine.toDate().toISOString());
    expect(feedDateToIso(genuine)).toBe(genuine.toDate().toISOString());
  });

  it('widens safely instead of throwing: missing/invalid values yield undefined (workshops) / null (feed)', () => {
    for (const bad of [undefined, null, 'not-a-date', {}, NaN]) {
      expect(workshopsDateToIso(bad)).toBeUndefined();
      expect(feedDateToIso(bad)).toBeNull();
    }
    // The pre-migration bare .toDate() threw on exactly this shape:
    expect(() => workshopsDateToIso(ISO)).not.toThrow();
  });
});

describe('site #4 (registration-deadline-countdown)', () => {
  it('computeTimeLeft is identical for every S-TS shape of the same instant', () => {
    const expected = computeTimeLeft(FORMS['Firestore Timestamp-like']);
    expect(expected.isPast).toBe(false);
    expect(expected.days).toBe(2);
    for (const value of Object.values(FORMS)) {
      expect(computeTimeLeft(value)).toEqual(expected);
    }
  });

  it('a past instant renders Registration Closed for every shape', () => {
    const pastMs = NOW - 1000;
    const pastForms = [
      { seconds: Math.floor(pastMs / 1000), nanoseconds: 0, toDate: () => new Date(pastMs) },
      { seconds: Math.floor(pastMs / 1000), nanoseconds: 0 },
      new Date(pastMs).toISOString(),
      new Date(pastMs),
      pastMs,
    ];
    for (const value of pastForms) {
      const { container, unmount } = render(
        <RegistrationDeadlineCountdown deadline={value} compact />,
      );
      expect(container.textContent).toContain('Registration Closed');
      unmount();
    }
  });
});

describe('site #3 (event-cta registration deadline enforcement)', () => {
  const baseEvent = {
    id: 'ev1',
    status: 'published',
    registrationOpen: true,
    attendeeIds: [] as string[],
  };
  const user = { uid: 'user-1' };

  it('a past deadline closes registration identically for every S-TS shape', () => {
    // The FORMS instant is 2 days AFTER the mocked now, so shift:
    // use an instant 2 days before NOW for the past case.
    const pastMs = NOW - 2 * 86400000;
    const pastForms = [
      { seconds: Math.floor(pastMs / 1000), nanoseconds: 0, toMillis: () => pastMs, toDate: () => new Date(pastMs) },
      { seconds: Math.floor(pastMs / 1000), nanoseconds: 0, toDate: () => new Date(pastMs) },
      { seconds: Math.floor(pastMs / 1000), nanoseconds: 0 },
      new Date(pastMs).toISOString(),
      new Date(pastMs),
      pastMs,
    ];
    for (const deadline of pastForms) {
      const state = computeCtaState({ ...baseEvent, registrationDeadline: deadline } as any, user);
      expect(state.label).toBe('Registration Closed');
      expect(state.disabled).toBe(true);
    }
  });

  it('a future deadline does not close registration for any S-TS shape', () => {
    for (const deadline of Object.values(FORMS)) {
      const state = computeCtaState(
        { ...baseEvent, registrationDeadline: deadline } as any,
        user,
      );
      expect(state.label).not.toBe('Registration Closed');
    }
  });

  it('an unparseable deadline does not close registration (the old NaN behavior)', () => {
    const state = computeCtaState(
      { ...baseEvent, registrationDeadline: { nope: true } } as any,
      user,
    );
    expect(state.label).not.toBe('Registration Closed');
  });
});

describe('sites #1 and #2: oracle routing is source-pinned', () => {
  const readSrc = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('site #1 _event-client countdown routes through eventInstantToMs, no .seconds read remains', () => {
    const src = readSrc('src/app/events/[slug]/_event-client.tsx');
    expect(src).toContain('eventInstantToMs(event.startAt)');
    expect(src).not.toContain('event.startAt?.seconds');
    expect(src).not.toContain('event.startAt.seconds');
  });

  it('site #2 detail formatDate routes through eventInstantToMs, no .seconds read remains', () => {
    const src = readSrc('src/app/events/detail/page.tsx');
    expect(src).toContain('eventInstantToMs(date)');
    expect(src).not.toContain('date.seconds');
  });

  it('sites #3/#4 keep no direct .seconds/.toDate() Timestamp reads (comments excepted)', () => {
    const cta = readSrc('src/components/events/event-cta.tsx');
    expect(cta).toContain('eventInstantToMs(deadline)');
    expect(cta).not.toContain('deadline?.seconds');
    expect(cta).not.toContain('deadline.toDate');
    const countdown = readSrc('src/components/events/registration-deadline-countdown.tsx');
    expect(countdown).toContain('eventInstantToMs(deadline)');
    expect(countdown).not.toContain('deadline?.seconds');
    expect(countdown).not.toContain('deadline?.toDate');
    // The unrelated local timeLeft.seconds field is untouched.
    expect(countdown).toContain('timeLeft.seconds');
  });
});
