/**
 * Pure timer-math and state tests for urgent decisions (ws-a 3.13 / 6.5).
 * No mocks: every function takes its "now" explicitly.
 */
import {
  notificationDueAt,
  ratificationDueAt,
  isEscalationDue,
  isRatificationExpired,
  checkRatifiable,
  statusAfterConfirmation,
  URGENT_NOTIFICATION_WINDOW_MS,
  URGENT_RATIFICATION_WINDOW_MS,
  type UrgentDecisionRecord,
} from '../urgent-decisions';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function rec(overrides: Partial<UrgentDecisionRecord>): UrgentDecisionRecord {
  const created = Date.UTC(2026, 0, 15, 10, 0, 0); // 2026-01-15T10:00Z
  return {
    id: 'u1',
    presidentUid: 'pres1',
    title: 'Emergency hosting payment',
    description: 'Pay the hosting invoice now.',
    decisionClassId: 'class_ops_spend',
    harmStatement: 'The platform goes offline if the invoice lapses.',
    status: 'notified_pending_confirmation',
    createdAtMs: created,
    notificationDueAtMs: created + URGENT_NOTIFICATION_WINDOW_MS,
    notifiedAtMs: created,
    notificationConfirmedAtMs: null,
    notificationConfirmedBy: null,
    escalatedToFounderAtMs: null,
    ratifyingBodyId: 'board',
    ratificationDueAtMs: created + URGENT_RATIFICATION_WINDOW_MS,
    ratificationDecisionId: null,
    ratificationMotionId: null,
    voidedAtMs: null,
    voidReason: null,
    affectedPartyUids: [],
    decisionId: 'reg1',
    ...overrides,
  };
}

describe('timer math', () => {
  it('notification due is exactly createdAt + 24h', () => {
    const created = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    expect(notificationDueAt(created).getTime()).toBe(created.getTime() + DAY);
  });

  it('ratification due is exactly createdAt + 30 days', () => {
    const created = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    expect(ratificationDueAt(created).getTime()).toBe(created.getTime() + 30 * DAY);
  });

  it('30-day window crosses a month boundary (Jan 31 -> Mar 2, non-leap)', () => {
    const created = new Date(Date.UTC(2026, 0, 31, 9, 30, 0));
    const due = ratificationDueAt(created);
    expect(due.getTime()).toBe(created.getTime() + 30 * DAY);
    expect(due.getUTCDate()).toBe(2);
    expect(due.getUTCMonth()).toBe(2); // March
  });

  it('30-day window crosses February in a leap year (Jan 30 2028 -> Feb 29 2028)', () => {
    const created = new Date(Date.UTC(2028, 0, 30, 0, 0, 0));
    const due = ratificationDueAt(created);
    expect(due.getTime()).toBe(created.getTime() + 30 * DAY);
    expect(due.getUTCDate()).toBe(29);
    expect(due.getUTCMonth()).toBe(1); // February
  });

  it('24h window crosses a month boundary (Jan 31 23:00 -> Feb 1 23:00)', () => {
    const created = new Date(Date.UTC(2026, 0, 31, 23, 0, 0));
    const due = notificationDueAt(created);
    expect(due.getUTCDate()).toBe(1);
    expect(due.getUTCMonth()).toBe(1);
    expect(due.getUTCHours()).toBe(23);
  });

  it('accepts epoch millis as well as Date', () => {
    const ms = Date.UTC(2026, 5, 1, 12, 0, 0);
    expect(notificationDueAt(ms).getTime()).toBe(ms + DAY);
    expect(ratificationDueAt(ms).getTime()).toBe(ms + 30 * DAY);
  });
});

describe('escalation predicate (T4)', () => {
  it('not due one millisecond before the 24h deadline', () => {
    const r = rec({});
    expect(isEscalationDue(r, r.notificationDueAtMs - 1)).toBe(false);
  });

  it('due exactly at the 24h deadline when unconfirmed', () => {
    const r = rec({});
    expect(isEscalationDue(r, r.notificationDueAtMs)).toBe(true);
  });

  it('never due after confirmation moved the status on', () => {
    const r = rec({
      status: 'active_pending_ratification',
      notificationConfirmedAtMs: rec({}).createdAtMs + HOUR,
    });
    expect(isEscalationDue(r, r.notificationDueAtMs + DAY)).toBe(false);
  });

  it('never due twice: escalatedToFounderAt set blocks a rerun', () => {
    const r = rec({ escalatedToFounderAtMs: rec({}).notificationDueAtMs });
    expect(isEscalationDue(r, r.notificationDueAtMs + DAY)).toBe(false);
  });

  it('never due for ratified or void decisions', () => {
    expect(isEscalationDue(rec({ status: 'ratified' }), Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(
      isEscalationDue(rec({ status: 'void_retroactive' }), Number.MAX_SAFE_INTEGER)
    ).toBe(false);
  });
});

describe('ratification expiry predicate (T5)', () => {
  it('not expired one millisecond before the 30-day deadline', () => {
    const r = rec({});
    expect(isRatificationExpired(r, r.ratificationDueAtMs - 1)).toBe(false);
  });

  it('expired exactly at the deadline from either pending status', () => {
    expect(isRatificationExpired(rec({}), rec({}).ratificationDueAtMs)).toBe(true);
    expect(
      isRatificationExpired(
        rec({ status: 'active_pending_ratification' }),
        rec({}).ratificationDueAtMs
      )
    ).toBe(true);
  });

  it('ratified and void decisions never (re-)expire', () => {
    const later = rec({}).ratificationDueAtMs + 90 * DAY;
    expect(isRatificationExpired(rec({ status: 'ratified' }), later)).toBe(false);
    expect(isRatificationExpired(rec({ status: 'void_retroactive' }), later)).toBe(false);
  });
});

describe('checkRatifiable', () => {
  it('ok inside the window', () => {
    const r = rec({});
    expect(checkRatifiable(r, r.ratificationDueAtMs - 1)).toEqual({ ok: true });
  });

  it('at the deadline the window has closed (same boundary as the cron void)', () => {
    const r = rec({});
    expect(checkRatifiable(r, r.ratificationDueAtMs)).toEqual({
      ok: false,
      error_code: 'ratification_deadline_expired',
    });
  });

  it('after lapse (void) ratification is refused as decision_void', () => {
    const r = rec({ status: 'void_retroactive' });
    expect(checkRatifiable(r, r.createdAtMs + DAY)).toEqual({
      ok: false,
      error_code: 'decision_void',
    });
  });

  it('double ratification is refused as already_ratified', () => {
    const r = rec({ status: 'ratified' });
    expect(checkRatifiable(r, r.createdAtMs + DAY)).toEqual({
      ok: false,
      error_code: 'already_ratified',
    });
  });
});

describe('statusAfterConfirmation', () => {
  it('pending confirmation advances to active pending ratification', () => {
    expect(statusAfterConfirmation('notified_pending_confirmation')).toBe(
      'active_pending_ratification'
    );
  });

  it('terminal and already-active statuses are unchanged (idempotent confirm)', () => {
    expect(statusAfterConfirmation('active_pending_ratification')).toBe(
      'active_pending_ratification'
    );
    expect(statusAfterConfirmation('ratified')).toBe('ratified');
    expect(statusAfterConfirmation('void_retroactive')).toBe('void_retroactive');
  });
});
