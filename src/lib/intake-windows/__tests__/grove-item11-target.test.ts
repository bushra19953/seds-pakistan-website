/**
 * Grove Item 11: the targetApplications field (comparison doc item 11).
 *
 * Implementation under test:
 * - `targetApplications` is one optional stored field on the intake
 *   window record. IntakeWindowLike carries it as `number | null`;
 *   windowToLike (src/lib/intake-windows/resolve.ts) validates the
 *   stored value: a finite number > 0 passes through, anything else
 *   (absent, null, non-numeric, zero, negative) resolves to null.
 * - The pace route returns `resolved.targetApplications ?? null`, so a
 *   null here is exactly the "no target set" signal /admin/applications
 *   renders from: pool and projection only, no target figure.
 * - The projection itself takes no target input and must compute
 *   identically whether or not a target exists.
 */

import { windowToLike } from '../resolve';
import { computePaceProjection } from '../pace';

const OPENS = Date.UTC(2026, 9, 1);
const CLOSES = Date.UTC(2026, 9, 21);
const HALF = Date.UTC(2026, 9, 11);

function windowData(overrides: Record<string, unknown> = {}) {
  return {
    windowId: 'induction-2026-10-target-test',
    kind: 'induction',
    opensAt: OPENS,
    closesAt: CLOSES,
    createdAt: OPENS - 1000,
    isDefault: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Case 1: the stored field plumbs through windowToLike
// ---------------------------------------------------------------------------

describe('Item 11.4 targetApplications: window plumbing', () => {
  it('windowToLike carries a stored targetApplications through', () => {
    const like = windowToLike(windowData({ targetApplications: 120 }));

    expect(like.targetApplications).toBe(120);
  });

  it('windowToLike resolves an omitted targetApplications to null', () => {
    const like = windowToLike(windowData());

    expect(like.targetApplications).toBeNull();
  });

  it('windowToLike resolves a stored null targetApplications to null', () => {
    const like = windowToLike(windowData({ targetApplications: null }));

    expect(like.targetApplications).toBeNull();
  });

  it('windowToLike resolves a non-numeric stored targetApplications to null', () => {
    const like = windowToLike(windowData({ targetApplications: 'many' }));

    expect(like.targetApplications).toBeNull();
  });

  it('windowToLike resolves a zero or negative stored targetApplications to null', () => {
    expect(
      windowToLike(windowData({ targetApplications: 0 })).targetApplications,
    ).toBeNull();
    expect(
      windowToLike(windowData({ targetApplications: -10 }))
        .targetApplications,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 2: target unset - no crash, projection unaffected
// ---------------------------------------------------------------------------

describe('Item 11.5 target unset: projection still computes', () => {
  it('a window with no target still produces pool, fraction, and projection from its bounds', () => {
    const like = windowToLike(windowData());

    expect(like.targetApplications).toBeNull();

    const result = computePaceProjection({
      opensAtMs: like.opensAtMs,
      closesAtMs: like.closesAtMs,
      nowMs: HALF,
      createdAtMsList: Array.from(
        { length: 30 },
        (_, i) => like.opensAtMs + i * 3_600_000,
      ),
    });

    expect(result.pool).toBe(30);
    expect(result.elapsedFraction).toBeCloseTo(0.5, 10);
    expect(result.projectedFinalPool).toBe(60);
  });

  it('a window with a target produces the identical projection (target never enters the math)', () => {
    const withTarget = windowToLike(windowData({ targetApplications: 100 }));
    const withoutTarget = windowToLike(windowData());
    const list = Array.from(
      { length: 30 },
      (_, i) => OPENS + i * 3_600_000,
    );

    const a = computePaceProjection({
      opensAtMs: withTarget.opensAtMs,
      closesAtMs: withTarget.closesAtMs,
      nowMs: HALF,
      createdAtMsList: list,
    });
    const b = computePaceProjection({
      opensAtMs: withoutTarget.opensAtMs,
      closesAtMs: withoutTarget.closesAtMs,
      nowMs: HALF,
      createdAtMsList: list,
    });

    expect(a).toEqual(b);
  });
});
