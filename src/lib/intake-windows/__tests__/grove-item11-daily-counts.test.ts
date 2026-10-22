/**
 * Grove Item 11: daily-count series from application created_at
 * timestamps (comparison doc item 11 step 2: "count by day against
 * elapsed window"; item 21's linearity series consumes the same data).
 *
 * Implementation under test: computePaceProjection in
 * src/lib/intake-windows/pace.ts returns `dailyCounts: number[]` -
 * pool arrivals bucketed per elapsed day, where day 0 is the 24-hour
 * period starting at opensAtMs. The array extends only as far as the
 * latest counted arrival; days between arrivals are zero-filled.
 * Timestamps outside [opensAtMs, min(nowMs, closesAtMs)] never count.
 */

import { computePaceProjection } from '../pace';

const DAY = 86_400_000;
// 20-day window: opens 2026-10-01T00:00Z, closes 2026-10-21T00:00Z.
const OPENS = Date.UTC(2026, 9, 1);
const CLOSES = Date.UTC(2026, 9, 21);
const HALF = Date.UTC(2026, 9, 11);

function dailyCounts(
  createdAtMsList: number[],
  nowMs: number = HALF,
): number[] {
  return computePaceProjection({
    opensAtMs: OPENS,
    closesAtMs: CLOSES,
    nowMs,
    createdAtMsList,
  }).dailyCounts;
}

describe('Item 11.6 dailyCounts series', () => {
  it('buckets arrivals by elapsed day from opensAt and zero-fills gap days', () => {
    const counts = dailyCounts([
      Date.UTC(2026, 9, 1, 9, 0), // day 0
      Date.UTC(2026, 9, 1, 18, 30), // day 0
      // day 1 (Oct 2): nothing, must appear as 0
      Date.UTC(2026, 9, 3, 0, 0), // day 2, first instant of the bucket
      Date.UTC(2026, 9, 3, 12, 0), // day 2
      Date.UTC(2026, 9, 3, 23, 59), // day 2
      Date.UTC(2026, 9, 4, 0, 0), // day 3
    ]);

    expect(counts).toEqual([2, 0, 3, 1]);
  });

  it('a timestamp exactly one day after opensAt lands in day 1, not day 0', () => {
    const counts = dailyCounts([OPENS, OPENS + DAY]);

    expect(counts).toEqual([1, 1]);
  });

  it('the series sums to the pool', () => {
    const list = [
      Date.UTC(2026, 9, 1, 1),
      Date.UTC(2026, 9, 2, 2),
      Date.UTC(2026, 9, 2, 3),
      Date.UTC(2026, 9, 4, 0),
    ];
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: HALF,
      createdAtMsList: list,
    });

    expect(result.dailyCounts.reduce((sum, c) => sum + c, 0)).toBe(
      result.pool,
    );
    expect(result.pool).toBe(list.length);
  });

  it('input order does not matter: the same arrivals give the same series', () => {
    const ordered = [
      Date.UTC(2026, 9, 1, 5, 0),
      Date.UTC(2026, 9, 1, 6, 0),
      Date.UTC(2026, 9, 3, 5, 0),
      Date.UTC(2026, 9, 4, 0, 0),
    ];
    const shuffled = [...ordered].reverse();

    expect(dailyCounts(shuffled)).toEqual(dailyCounts(ordered));
    expect(dailyCounts(ordered)).toEqual([2, 0, 1, 1]);
  });

  it('timestamps before opensAt and after now are excluded from every bucket', () => {
    const counts = dailyCounts([
      Date.UTC(2026, 8, 30, 23, 0), // before the window
      Date.UTC(2026, 9, 2, 10, 0), // day 1, inside
      Date.UTC(2026, 9, 15, 10, 0), // inside the window but after now (HALF)
    ]);

    expect(counts).toEqual([0, 1]);
  });

  it('after the window closes, late timestamps past closesAt are excluded', () => {
    const counts = dailyCounts(
      [Date.UTC(2026, 9, 1, 10, 0), CLOSES + 1000, CLOSES + DAY],
      CLOSES + DAY,
    );

    expect(counts).toEqual([1]);
  });

  it('no arrivals yields an empty series, not zero-filled days', () => {
    expect(dailyCounts([])).toEqual([]);
  });

  it('a single arrival on day 0 yields exactly one bucket', () => {
    expect(dailyCounts([OPENS + 1000])).toEqual([1]);
  });
});
