/**
 * Suite E1: pure intake-window resolution (Workstream E, spec 4.3 / 8).
 *
 * Covers deriveWindowState boundary parity with the deleted deadline
 * predicate (open at exactly opensAt, closed at exactly closesAt),
 * the resolveWindow priority order (default, open, scheduled, closed,
 * none), the toPublicWindow null payload, and windowToLike timestamp
 * conversion for { seconds, nanoseconds } and toMillis() shapes.
 */

import {
  deriveWindowState,
  resolveWindow,
  toPublicWindow,
  windowToLike,
} from '../resolve';
import type { IntakeWindowLike } from '@/types/intake-window';

function makeWindow(
  overrides: Partial<IntakeWindowLike> = {},
): IntakeWindowLike {
  return {
    windowId: 'induction-2026-10-test',
    kind: 'induction',
    opensAtMs: 1000,
    closesAtMs: 5000,
    isDefault: false,
    createdAtMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Case 1: deriveWindowState
// ---------------------------------------------------------------------------

describe('E1.1 deriveWindowState', () => {
  it('is scheduled when now is before opensAt', () => {
    const w = makeWindow();
    expect(deriveWindowState(w, 0)).toBe('scheduled');
    expect(deriveWindowState(w, 999)).toBe('scheduled');
  });

  it('is open at exactly opensAt', () => {
    const w = makeWindow();
    expect(deriveWindowState(w, 1000)).toBe('open');
  });

  it('is open inside the window, up to but not including closesAt', () => {
    const w = makeWindow();
    expect(deriveWindowState(w, 2000)).toBe('open');
    expect(deriveWindowState(w, 4999)).toBe('open');
  });

  it('is closed at exactly closesAt (boundary parity)', () => {
    const w = makeWindow();
    expect(deriveWindowState(w, 5000)).toBe('closed');
    expect(deriveWindowState(w, 5001)).toBe('closed');
  });

  it('cancelled overrides every time position', () => {
    const w = makeWindow({ storedStatus: 'cancelled' });
    expect(deriveWindowState(w, 0)).toBe('cancelled');
    expect(deriveWindowState(w, 999)).toBe('cancelled');
    expect(deriveWindowState(w, 1000)).toBe('cancelled');
    expect(deriveWindowState(w, 2000)).toBe('cancelled');
    expect(deriveWindowState(w, 5000)).toBe('cancelled');
    expect(deriveWindowState(w, 9000)).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Case 2: open wins; different kind ignored
// ---------------------------------------------------------------------------

describe('E1.2 resolveWindow: open wins over scheduled and closed', () => {
  it('an open window wins over scheduled and closed windows of the same kind', () => {
    const closed = makeWindow({
      windowId: 'closed-window',
      opensAtMs: 0,
      closesAtMs: 1000,
      createdAtMs: 10,
    });
    const open = makeWindow({
      windowId: 'open-window',
      opensAtMs: 1000,
      closesAtMs: 5000,
      createdAtMs: 20,
    });
    const scheduled = makeWindow({
      windowId: 'scheduled-window',
      opensAtMs: 6000,
      closesAtMs: 9000,
      createdAtMs: 30,
    });

    const resolved = resolveWindow([closed, scheduled, open], 'induction', 2000);

    expect(resolved).not.toBeNull();
    expect(resolved?.windowId).toBe('open-window');
    expect(resolved?.state).toBe('open');
  });

  it('ignores a window of a different kind', () => {
    const driveOpen = makeWindow({
      windowId: 'drive-open',
      kind: 'drive',
      opensAtMs: 1000,
      closesAtMs: 5000,
      createdAtMs: 10,
    });
    const inductionScheduled = makeWindow({
      windowId: 'induction-scheduled',
      kind: 'induction',
      opensAtMs: 6000,
      closesAtMs: 9000,
      createdAtMs: 20,
    });

    const forInduction = resolveWindow(
      [driveOpen, inductionScheduled],
      'induction',
      2000,
    );
    expect(forInduction?.windowId).toBe('induction-scheduled');
    expect(forInduction?.state).toBe('scheduled');

    const forDrive = resolveWindow(
      [driveOpen, inductionScheduled],
      'drive',
      2000,
    );
    expect(forDrive?.windowId).toBe('drive-open');
    expect(forDrive?.state).toBe('open');

    // Only a different kind exists: nothing resolves for induction.
    expect(resolveWindow([driveOpen], 'induction', 2000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 3: none open -> earliest-opening scheduled wins
// ---------------------------------------------------------------------------

describe('E1.3 resolveWindow: earliest scheduled wins when none open', () => {
  it('picks the earliest-opening scheduled window', () => {
    const closed = makeWindow({
      windowId: 'closed-window',
      opensAtMs: 0,
      closesAtMs: 500,
      createdAtMs: 10,
    });
    const laterScheduled = makeWindow({
      windowId: 'later-scheduled',
      opensAtMs: 8000,
      closesAtMs: 12000,
      createdAtMs: 20,
    });
    const earlierScheduled = makeWindow({
      windowId: 'earlier-scheduled',
      opensAtMs: 6000,
      closesAtMs: 9000,
      createdAtMs: 30,
    });

    const resolved = resolveWindow(
      [laterScheduled, closed, earlierScheduled],
      'induction',
      2000,
    );

    expect(resolved?.windowId).toBe('earlier-scheduled');
    expect(resolved?.state).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
// Case 4: none open or scheduled -> most recently closed wins
// ---------------------------------------------------------------------------

describe('E1.4 resolveWindow: most recently closed wins when none open or scheduled', () => {
  it('picks the closed window with the latest closesAt', () => {
    const olderClosed = makeWindow({
      windowId: 'older-closed',
      opensAtMs: 0,
      closesAtMs: 1000,
      createdAtMs: 10,
    });
    const recentClosed = makeWindow({
      windowId: 'recent-closed',
      opensAtMs: 500,
      closesAtMs: 1500,
      createdAtMs: 20,
    });

    const resolved = resolveWindow(
      [olderClosed, recentClosed],
      'induction',
      2000,
    );

    expect(resolved?.windowId).toBe('recent-closed');
    expect(resolved?.state).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Case 5: overlapping open windows
// ---------------------------------------------------------------------------

describe('E1.5 resolveWindow: overlapping open windows', () => {
  it('picks the open window with the earliest closesAt', () => {
    const closesLater = makeWindow({
      windowId: 'closes-later',
      opensAtMs: 1000,
      closesAtMs: 9000,
      createdAtMs: 100,
    });
    const closesEarlier = makeWindow({
      windowId: 'closes-earlier',
      opensAtMs: 1000,
      closesAtMs: 5000,
      createdAtMs: 200,
    });

    const resolved = resolveWindow(
      [closesLater, closesEarlier],
      'induction',
      2000,
    );

    expect(resolved?.windowId).toBe('closes-earlier');
    expect(resolved?.state).toBe('open');
  });

  it('breaks an earliest-closesAt tie by earliest createdAt', () => {
    const createdLater = makeWindow({
      windowId: 'created-later',
      opensAtMs: 1000,
      closesAtMs: 5000,
      createdAtMs: 300,
    });
    const createdEarlier = makeWindow({
      windowId: 'created-earlier',
      opensAtMs: 1000,
      closesAtMs: 5000,
      createdAtMs: 100,
    });

    const resolved = resolveWindow(
      [createdLater, createdEarlier],
      'induction',
      2000,
    );

    expect(resolved?.windowId).toBe('created-earlier');
    expect(resolved?.state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Case 6: isDefault
// ---------------------------------------------------------------------------

describe('E1.6 resolveWindow: isDefault', () => {
  it('isDefault wins over an open non-default window', () => {
    const openNonDefault = makeWindow({
      windowId: 'open-non-default',
      opensAtMs: 1000,
      closesAtMs: 5000,
      isDefault: false,
      createdAtMs: 100,
    });
    const defaultWindow = makeWindow({
      windowId: 'default-window',
      opensAtMs: 1000,
      closesAtMs: 9000,
      isDefault: true,
      createdAtMs: 200,
    });

    const resolved = resolveWindow(
      [openNonDefault, defaultWindow],
      'induction',
      2000,
    );

    expect(resolved?.windowId).toBe('default-window');
    expect(resolved?.isDefault).toBe(true);
  });

  it('a cancelled isDefault is ignored and resolution falls through to the open window', () => {
    const cancelledDefault = makeWindow({
      windowId: 'cancelled-default',
      opensAtMs: 1000,
      closesAtMs: 9000,
      isDefault: true,
      storedStatus: 'cancelled',
      createdAtMs: 100,
    });
    const openNonDefault = makeWindow({
      windowId: 'open-non-default',
      opensAtMs: 1000,
      closesAtMs: 5000,
      isDefault: false,
      createdAtMs: 200,
    });

    const resolved = resolveWindow(
      [cancelledDefault, openNonDefault],
      'induction',
      2000,
    );

    expect(resolved?.windowId).toBe('open-non-default');
    expect(resolved?.state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Case 7: no resolution
// ---------------------------------------------------------------------------

describe('E1.7 resolveWindow: no window resolves', () => {
  it('returns null for an empty list', () => {
    expect(resolveWindow([], 'induction', 2000)).toBeNull();
  });

  it('returns null for an all-cancelled list', () => {
    const a = makeWindow({
      windowId: 'cancelled-a',
      storedStatus: 'cancelled',
      createdAtMs: 10,
    });
    const b = makeWindow({
      windowId: 'cancelled-b',
      storedStatus: 'cancelled',
      opensAtMs: 6000,
      closesAtMs: 9000,
      createdAtMs: 20,
    });

    expect(resolveWindow([a, b], 'induction', 2000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extras: toPublicWindow null payload and windowToLike conversions
// ---------------------------------------------------------------------------

describe('E1 extras: toPublicWindow and windowToLike', () => {
  it('toPublicWindow(null) returns the null payload', () => {
    const nowMs = Date.UTC(2026, 9, 21, 12, 0, 0);
    const pub = toPublicWindow(null, nowMs);

    expect(pub.windowId).toBeNull();
    expect(pub.state).toBe('none');
    expect(pub.label).toBeNull();
    expect(pub.kind).toBe('induction');
    expect(pub.opensAt).toBeNull();
    expect(pub.closesAt).toBeNull();
    expect(pub.isDefault).toBe(false);
    expect(pub.serverNow).toBe(new Date(nowMs).toISOString());
  });

  it('windowToLike converts { seconds, nanoseconds } timestamp shapes', () => {
    const like = windowToLike({
      windowId: 'induction-2026-10-test',
      kind: 'induction',
      opensAt: { seconds: 1700000000, nanoseconds: 500000000 },
      closesAt: { seconds: 1700001000, nanoseconds: 0 },
      createdAt: { seconds: 1699999000, nanoseconds: 250000000 },
      isDefault: false,
    });

    expect(like.windowId).toBe('induction-2026-10-test');
    expect(like.kind).toBe('induction');
    expect(like.opensAtMs).toBe(1700000000500);
    expect(like.closesAtMs).toBe(1700001000000);
    expect(like.createdAtMs).toBe(1699999000250);
    expect(like.isDefault).toBe(false);
  });

  it('windowToLike converts toMillis() timestamp objects', () => {
    const like = windowToLike({
      windowId: 'induction-2026-10-test-2',
      kind: 'drive',
      opensAt: { toMillis: () => 123456789 },
      closesAt: { toMillis: () => 223456789 },
      createdAt: { toMillis: () => 111111111 },
      isDefault: true,
      label: 'Test window',
    });

    expect(like.windowId).toBe('induction-2026-10-test-2');
    expect(like.kind).toBe('drive');
    expect(like.opensAtMs).toBe(123456789);
    expect(like.closesAtMs).toBe(223456789);
    expect(like.createdAtMs).toBe(111111111);
    expect(like.isDefault).toBe(true);
    expect(like.label).toBe('Test window');
  });
});
