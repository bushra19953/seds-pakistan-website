/**
 * Grove Item 11: intake pace projection (comparison doc item 11;
 * linearity method per item 21).
 *
 * Implementation under test: src/lib/intake-windows/pace.ts
 * computePaceProjection({ opensAtMs, closesAtMs, nowMs, createdAtMsList })
 *   -> { pool, elapsedFraction, projectedFinalPool, dailyCounts }
 *
 * Method (from pace.ts): the pool collected so far, counted from
 * applications' created_at timestamps inside the window, is divided by
 * the elapsed fraction of the window. 40 applications in the first half
 * of a window project to a final pool of 80.
 */

import { computePaceProjection } from '../pace';

const DAY = 86_400_000;
// A 20-day window: opens 2026-10-01T00:00Z, closes 2026-10-21T00:00Z.
const OPENS = Date.UTC(2026, 9, 1);
const CLOSES = Date.UTC(2026, 9, 21);
const HALF = Date.UTC(2026, 9, 11); // exactly 10 of 20 days elapsed
const QUARTER = Date.UTC(2026, 9, 6); // exactly 5 of 20 days elapsed

/** N timestamps spread one hour apart starting at fromMs. */
function stamps(n: number, fromMs: number): number[] {
  return Array.from({ length: n }, (_, i) => fromMs + i * 3_600_000);
}

// ---------------------------------------------------------------------------
// Case 1: mid-window projection scales the pool by the elapsed fraction
// ---------------------------------------------------------------------------

describe('Item 11.1 computePaceProjection: mid-window', () => {
  it('at half the window, N applications project to 2N', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: HALF,
      createdAtMsList: stamps(30, OPENS),
    });

    expect(result.pool).toBe(30);
    expect(result.elapsedFraction).toBeCloseTo(0.5, 10);
    expect(result.projectedFinalPool).toBe(60);
  });

  it('at a quarter of the window, N applications project to 4N', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: QUARTER,
      createdAtMsList: stamps(15, OPENS),
    });

    expect(result.elapsedFraction).toBeCloseTo(0.25, 10);
    expect(result.projectedFinalPool).toBe(60);
  });

  it('an empty pool projects to zero at any point inside the window', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: HALF,
      createdAtMsList: [],
    });

    expect(result.pool).toBe(0);
    expect(result.projectedFinalPool).toBe(0);
  });

  it('applications arriving after now are not counted in the pool', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: HALF,
      // 10 before the half-way point, 5 after it.
      createdAtMsList: [...stamps(10, OPENS), ...stamps(5, HALF + DAY)],
    });

    expect(result.pool).toBe(10);
    expect(result.projectedFinalPool).toBe(20);
  });

  it('a non-round pace is rounded to a whole application count', () => {
    // 3 of 20 days elapsed (fraction 0.15), pool 10 -> 66.67 -> 67.
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: Date.UTC(2026, 9, 4),
      createdAtMsList: stamps(10, OPENS),
    });

    expect(result.projectedFinalPool).toBe(67);
  });

  it('unparseable timestamps (NaN, zero, negative) are skipped, not counted', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: HALF,
      createdAtMsList: [Number.NaN, 0, -5, ...stamps(4, OPENS)],
    });

    expect(result.pool).toBe(4);
    expect(result.projectedFinalPool).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Case 2: window start - no division by zero, sane output
// ---------------------------------------------------------------------------

describe('Item 11.2 computePaceProjection: window start', () => {
  it('at exactly opensAt, elapsed fraction is 0 and the projection falls back to the pool', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: OPENS,
      createdAtMsList: [OPENS, OPENS, OPENS],
    });

    expect(result.elapsedFraction).toBe(0);
    expect(Number.isFinite(result.projectedFinalPool)).toBe(true);
    expect(result.projectedFinalPool).toBe(result.pool);
    expect(result.pool).toBe(3);
  });

  it('at exactly opensAt with no applications yet, the projection is 0, never NaN', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: OPENS,
      createdAtMsList: [],
    });

    expect(result.elapsedFraction).toBe(0);
    expect(result.projectedFinalPool).toBe(0);
  });

  it('before opensAt (scheduled window), the fraction clamps to 0 and nothing throws', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: OPENS - DAY,
      createdAtMsList: stamps(3, OPENS),
    });

    expect(result.elapsedFraction).toBe(0);
    expect(result.pool).toBe(0);
    expect(result.projectedFinalPool).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 3: window closed - projection equals the final pool
// ---------------------------------------------------------------------------

describe('Item 11.3 computePaceProjection: window closed', () => {
  it('at exactly closesAt, the projection equals the final pool', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: CLOSES,
      createdAtMsList: stamps(57, OPENS),
    });

    expect(result.elapsedFraction).toBe(1);
    expect(result.pool).toBe(57);
    expect(result.projectedFinalPool).toBe(57);
  });

  it('after closesAt, the fraction stays clamped at 1 and the projection stays the final pool', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: CLOSES + 7 * DAY,
      createdAtMsList: stamps(57, OPENS),
    });

    expect(result.elapsedFraction).toBe(1);
    expect(result.projectedFinalPool).toBe(57);
  });

  it('timestamps after closesAt never enter the final pool', () => {
    const result = computePaceProjection({
      opensAtMs: OPENS,
      closesAtMs: CLOSES,
      nowMs: CLOSES + DAY,
      createdAtMsList: [...stamps(10, OPENS), CLOSES + 1000, CLOSES + DAY],
    });

    expect(result.pool).toBe(10);
    expect(result.projectedFinalPool).toBe(10);
  });
});
