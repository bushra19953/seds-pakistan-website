/**
 * Governor term math (spec C.7 cases 15-17, 21).
 * Pure functions from src/lib/governors.ts - no Firestore involved.
 */

import {
  addCalendarYears,
  karachiMidnight,
  seedTermYears,
} from '@/lib/governors';

it('a normal termed seat runs exactly 3 calendar years, not 1095 days (case 15)', () => {
  const start = karachiMidnight(new Date('2026-10-21T10:00:00Z'));
  const end = addCalendarYears(start, 3);
  expect(end.toISOString()).toBe('2029-10-21T00:00:00.000Z');
  // 2028 is a leap year: the span is 1096 days, proving calendar arithmetic.
  expect((end.getTime() - start.getTime()) / 86400000).toBe(1096);
});

it('a term starting 2028-02-29 ends 2031-02-28 (case 16)', () => {
  const start = new Date('2028-02-29T00:00:00Z');
  const end = addCalendarYears(start, 3);
  expect(end.toISOString()).toBe('2031-02-28T00:00:00.000Z');
});

it('first-board stagger seeds: co_1 = 1y, me_1 = 2y, co_2 = 3y, me_2 = 3y (case 17)', () => {
  expect(seedTermYears('seat_co_1', false)).toEqual({ years: 1, isStagger: true });
  expect(seedTermYears('seat_me_1', false)).toEqual({ years: 2, isStagger: true });
  expect(seedTermYears('seat_co_2', false)).toEqual({ years: 3, isStagger: true });
  expect(seedTermYears('seat_me_2', false)).toEqual({ years: 3, isStagger: true });
  const start = karachiMidnight(new Date('2026-10-21T10:00:00Z'));
  expect(addCalendarYears(start, seedTermYears('seat_co_1', false).years as number).toISOString()).toBe('2027-10-21T00:00:00.000Z');
  expect(addCalendarYears(start, seedTermYears('seat_me_1', false).years as number).toISOString()).toBe('2028-10-21T00:00:00.000Z');
  expect(addCalendarYears(start, seedTermYears('seat_co_2', false).years as number).toISOString()).toBe('2029-10-21T00:00:00.000Z');
});

it('later seatings never get a stagger seed; FA and Founder seats are termless', () => {
  expect(seedTermYears('seat_co_1', true)).toEqual({ years: 3, isStagger: false });
  expect(seedTermYears('seat_me_1', true)).toEqual({ years: 3, isStagger: false });
  expect(seedTermYears('seat_fa_1', false)).toEqual({ years: null, isStagger: false });
  expect(seedTermYears('seat_founder', false)).toEqual({ years: null, isStagger: false });
});

it('karachiMidnight floors to the Asia/Karachi calendar date', () => {
  // 2026-10-21T20:30Z is already 2026-10-22 01:30 in Karachi.
  expect(karachiMidnight(new Date('2026-10-21T20:30:00Z')).toISOString()).toBe('2026-10-22T00:00:00.000Z');
  expect(karachiMidnight(new Date('2026-10-21T10:00:00Z')).toISOString()).toBe('2026-10-21T00:00:00.000Z');
});
