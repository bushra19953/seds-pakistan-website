/**
 * Pure intake-window resolution (Workstream E, spec 4.3).
 *
 * No Firebase imports: client, server, and tests share this one
 * implementation. Client surfaces never re-implement the rule; they
 * consume state from the public route and only tick the open-to-closed
 * flip locally against the fetched closesAt.
 */

import type {
  DerivedWindowState,
  IntakeWindowKind,
  IntakeWindowLike,
  PublicIntakeWindow,
  ResolvedIntakeWindow,
} from '@/types/intake-window';

/**
 * Derive the state of a single window at nowMs.
 * - cancelled: storedStatus == 'cancelled'. Terminal; time is irrelevant.
 * - scheduled: now < opensAt.
 * - open: opensAt <= now < closesAt. The closesAt boundary is closed,
 *   preserving the deleted predicate's semantics (now >= deadline).
 * - closed: now >= closesAt.
 */
export function deriveWindowState(
  w: IntakeWindowLike,
  nowMs: number,
): DerivedWindowState {
  if (w.storedStatus === 'cancelled') return 'cancelled';
  if (nowMs < w.opensAtMs) return 'scheduled';
  if (nowMs < w.closesAtMs) return 'open';
  return 'closed';
}

/**
 * Pick the resolved window for a kind at nowMs, in the exact spec 4.3
 * order:
 * 0. Discard cancelled windows. They never resolve.
 * 1. The isDefault window of the kind, if one exists.
 * 2. The currently open window; earliest closesAt, then earliest
 *    createdAt when two overlap as open.
 * 3. The next scheduled window: earliest opensAt.
 * 4. The most recently closed window: latest closesAt.
 * 5. None: returns null.
 */
export function resolveWindow(
  windows: IntakeWindowLike[],
  kind: IntakeWindowKind,
  nowMs: number,
): ResolvedIntakeWindow | null {
  const candidates = windows.filter(
    (w) => w.kind === kind && w.storedStatus !== 'cancelled',
  );
  if (candidates.length === 0) return null;

  const withState = (
    w: IntakeWindowLike,
  ): ResolvedIntakeWindow => ({ ...w, state: deriveWindowState(w, nowMs) });

  // Step 1: explicit default beats the calendar.
  const defaults = candidates
    .filter((w) => w.isDefault)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  if (defaults.length > 0) return withState(defaults[0]);

  // Step 2: currently open.
  const open = candidates
    .filter((w) => deriveWindowState(w, nowMs) === 'open')
    .sort(
      (a, b) => a.closesAtMs - b.closesAtMs || a.createdAtMs - b.createdAtMs,
    );
  if (open.length > 0) return withState(open[0]);

  // Step 3: next scheduled.
  const scheduled = candidates
    .filter((w) => deriveWindowState(w, nowMs) === 'scheduled')
    .sort(
      (a, b) => a.opensAtMs - b.opensAtMs || a.createdAtMs - b.createdAtMs,
    );
  if (scheduled.length > 0) return withState(scheduled[0]);

  // Step 4: most recently closed (keeps the closed-card line alive).
  const closed = candidates
    .filter((w) => deriveWindowState(w, nowMs) === 'closed')
    .sort(
      (a, b) => b.closesAtMs - a.closesAtMs || b.createdAtMs - a.createdAtMs,
    );
  if (closed.length > 0) return withState(closed[0]);

  // Step 5: none.
  return null;
}

function toIsoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/**
 * Project a window to the public shape (spec 5.3): ISO strings only,
 * no admin fields. Accepts a resolved window (its state is reused) or a
 * plain IntakeWindowLike (state is derived at nowMs). A null window
 * yields the no-window payload shape with state 'none'; the public
 * route maps that to its fail-safe 'closed' payload per spec 5.3/6.3.
 */
export function toPublicWindow(
  window:
    | (IntakeWindowLike & { state?: DerivedWindowState })
    | ResolvedIntakeWindow
    | null,
  nowMs: number,
  kind: IntakeWindowKind = 'induction',
): PublicIntakeWindow {
  const serverNow = new Date(nowMs).toISOString();
  if (!window) {
    return {
      windowId: null,
      label: null,
      kind,
      opensAt: null,
      closesAt: null,
      state: 'none',
      isDefault: false,
      serverNow,
    };
  }
  return {
    windowId: window.windowId,
    label: window.label ?? null,
    kind: window.kind,
    opensAt: toIsoOrNull(window.opensAtMs),
    closesAt: toIsoOrNull(window.closesAtMs),
    state: window.state ?? deriveWindowState(window, nowMs),
    isDefault: window.isDefault === true,
    serverNow,
  };
}

/** Convert any Timestamp-like value to epoch ms; 0 when unparseable. */
export function timestampLikeToMs(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof val === 'object') {
    const obj = val as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof obj.toMillis === 'function') {
      try {
        const ms = obj.toMillis();
        return Number.isFinite(ms) ? ms : 0;
      } catch {
        return 0;
      }
    }
    if (typeof obj.toDate === 'function') {
      try {
        const ms = obj.toDate().getTime();
        return Number.isFinite(ms) ? ms : 0;
      } catch {
        return 0;
      }
    }
    if (typeof obj.seconds === 'number') {
      return obj.seconds * 1000 + (obj.nanoseconds || 0) / 1000000;
    }
  }
  return 0;
}

/**
 * Convert raw Firestore doc data (Timestamp fields, e.g. from doc.data())
 * to the plain IntakeWindowLike the resolver consumes. Accepts
 * Timestamp-like objects with toMillis() as well as Dates, ISO strings,
 * epoch numbers, and { seconds, nanoseconds } shapes.
 */
export function windowToLike(
  data: Record<string, unknown> | null | undefined,
): IntakeWindowLike {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    windowId:
      typeof d.windowId === 'string'
        ? d.windowId
        : typeof d.id === 'string'
          ? d.id
          : '',
    kind: (typeof d.kind === 'string' ? d.kind : 'other') as IntakeWindowKind,
    opensAtMs: timestampLikeToMs(d.opensAt),
    closesAtMs: timestampLikeToMs(d.closesAt),
    isDefault: d.isDefault === true,
    storedStatus:
      typeof d.storedStatus === 'string' ? d.storedStatus : undefined,
    createdAtMs: timestampLikeToMs(d.createdAt),
    label: typeof d.label === 'string' ? d.label : undefined,
  };
}
