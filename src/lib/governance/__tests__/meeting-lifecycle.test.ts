/**
 * Pure tests for the meeting lifecycle state machine + the 30-minute
 * auto-adjourn evaluator (Phase 3 WS-A worker 5). Fake clock throughout:
 * `now` is an explicit value, jest fake timers pin Date.now where used.
 *
 * Named coverage: quorum at minute 29 stays in session; no quorum at
 * minute 30 adjourns; Board adjournment produces the reduced-quorum
 * reconvene (3 + Founder); non-Board adjournment produces +7 days same
 * time. Plus spec test 19's +31 minute case and the state machine.
 */
import {
  AUTO_ADJOURN_AFTER_MS,
  BOARD_ADJOURNED_QUORUM,
  canTransitionMeeting,
  assertMeetingTransition,
  MeetingTransitionError,
  evaluateAutoAdjourn,
  buildReconvenePlan,
  isAutoAdjournCandidate,
  type MeetingLike,
} from '../meeting-lifecycle';
import { evaluateQuorum, type AttendanceLike } from '../quorum-adapter';

const MIN = 60 * 1000;
const START = Date.UTC(2026, 10, 4, 10, 0, 0); // a fixed scheduled start

function boardMeeting(overrides: Partial<MeetingLike> = {}): MeetingLike {
  return {
    id: 'm-board-1',
    bodyId: 'body-board',
    bodyType: 'board',
    type: 'ordinary',
    status: 'noticed',
    scheduledAt: START,
    quorumRequired: 5,
    quorumVerifiedAt: null,
    reconveneMeetingId: null,
    parentMeetingId: null,
    ...overrides,
  };
}

function necMeeting(overrides: Partial<MeetingLike> = {}): MeetingLike {
  return {
    id: 'm-nec-1',
    bodyId: 'body-nec',
    bodyType: 'nec',
    type: 'ordinary',
    status: 'noticed',
    scheduledAt: START,
    quorumRequired: 4,
    quorumVerifiedAt: null,
    reconveneMeetingId: null,
    parentMeetingId: null,
    ...overrides,
  };
}

function present(n: number, opts: { founderAtIndex?: number } = {}): AttendanceLike[] {
  return Array.from({ length: n }, (_, i) => ({
    uid: `u${i + 1}`,
    mode: 'in_person',
    isPresent: true,
    isFounder: opts.founderAtIndex === i,
  }));
}

function quorumFor(meeting: MeetingLike, attendance: AttendanceLike[]) {
  return evaluateQuorum({
    bodyType: meeting.bodyType,
    quorumRequired: meeting.quorumRequired,
    isAdjournedSitting: meeting.type === 'adjourned',
    attendance,
  });
}

describe('meeting status state machine (spec 6.1)', () => {
  it('allows the happy path draft -> noticed -> convened -> closed', () => {
    expect(canTransitionMeeting('draft', 'noticed')).toBe(true);
    expect(canTransitionMeeting('noticed', 'convened')).toBe(true);
    expect(canTransitionMeeting('convened', 'closed')).toBe(true);
  });

  it('allows noticed -> adjourned and any pre-close status -> cancelled', () => {
    expect(canTransitionMeeting('noticed', 'adjourned')).toBe(true);
    expect(canTransitionMeeting('draft', 'cancelled')).toBe(true);
    expect(canTransitionMeeting('noticed', 'cancelled')).toBe(true);
    expect(canTransitionMeeting('convened', 'cancelled')).toBe(true);
  });

  it('treats closed and cancelled as terminal', () => {
    expect(canTransitionMeeting('closed', 'cancelled')).toBe(false);
    expect(canTransitionMeeting('closed', 'convened')).toBe(false);
    expect(canTransitionMeeting('cancelled', 'noticed')).toBe(false);
  });

  it('rejects skipping states and adjourning a convened meeting', () => {
    expect(canTransitionMeeting('draft', 'convened')).toBe(false);
    expect(canTransitionMeeting('convened', 'adjourned')).toBe(false);
    expect(() => assertMeetingTransition('closed', 'noticed')).toThrow(MeetingTransitionError);
    expect(() => assertMeetingTransition('noticed', 'convened')).not.toThrow();
  });
});

describe('30-minute auto-adjourn evaluator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });
  afterEach(() => jest.useRealTimers());

  it('quorum achieved at minute 29 stays in session', () => {
    const meeting = boardMeeting();
    const now = START + 29 * MIN;
    jest.setSystemTime(now);
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: quorumFor(meeting, present(5)), // Board quorum 5 met
      now: Date.now(),
    });
    expect(decision.action).toBe('none');
    if (decision.action === 'none') expect(decision.reason).toBe('quorum_met');
  });

  it('quorum met still protects the meeting when evaluated after the deadline', () => {
    const meeting = boardMeeting();
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: quorumFor(meeting, present(6)),
      now: START + 45 * MIN,
    });
    expect(decision.action).toBe('none');
    if (decision.action === 'none') expect(decision.reason).toBe('quorum_met');
  });

  it('a chair-verified quorum never auto-adjourns', () => {
    const meeting = boardMeeting({ quorumVerifiedAt: START + 10 * MIN });
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: quorumFor(meeting, present(0)),
      now: START + 60 * MIN,
    });
    expect(decision.action).toBe('none');
    if (decision.action === 'none') expect(decision.reason).toBe('quorum_already_verified');
  });

  it('no quorum before minute 30 does not adjourn early', () => {
    const meeting = boardMeeting();
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: quorumFor(meeting, present(2)),
      now: START + 29 * MIN + 59_000,
    });
    expect(decision.action).toBe('none');
    if (decision.action === 'none') expect(decision.reason).toBe('within_grace_period');
  });

  it('no quorum at minute 30 adjourns', () => {
    const meeting = boardMeeting();
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: quorumFor(meeting, present(4)), // 4 of 5: unmet
      now: START + AUTO_ADJOURN_AFTER_MS,
    });
    expect(decision.action).toBe('adjourn');
    if (decision.action === 'adjourn') {
      expect(decision.reason).toBe('quorum_not_met_at_deadline');
      expect(decision.deadlineAt).toBe(START + 30 * MIN);
    }
  });

  it('spec case 19: at scheduledAt + 31 minutes with no quorum it adjourns', () => {
    const meeting = boardMeeting();
    expect(isAutoAdjournCandidate(meeting, START + 31 * MIN)).toBe(true);
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: quorumFor(meeting, present(0)),
      now: START + 31 * MIN,
    });
    expect(decision.action).toBe('adjourn');
  });

  it('meetings not in noticed status are never candidates', () => {
    for (const status of ['draft', 'convened', 'closed', 'cancelled', 'adjourned']) {
      const meeting = boardMeeting({ status });
      const decision = evaluateAutoAdjourn({
        meeting,
        quorum: quorumFor(meeting, present(0)),
        now: START + 90 * MIN,
      });
      expect(decision.action).toBe('none');
      expect(isAutoAdjournCandidate(meeting, START + 90 * MIN)).toBe(false);
    }
  });

  it('a meeting that already has a reconvene doc does not adjourn twice', () => {
    const meeting = boardMeeting({ reconveneMeetingId: 'm-board-1-r' });
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: quorumFor(meeting, present(0)),
      now: START + 90 * MIN,
    });
    expect(decision.action).toBe('none');
    if (decision.action === 'none') expect(decision.reason).toBe('already_reconvened');
  });
});

describe('reconvene plans', () => {
  it('Board adjournment produces the reduced-quorum reconvene (3 + Founder present)', () => {
    const plan = buildReconvenePlan(boardMeeting());
    expect(plan.type).toBe('adjourned');
    expect(plan.status).toBe('noticed');
    expect(plan.parentMeetingId).toBe('m-board-1');
    expect(plan.quorumRequired).toBe(BOARD_ADJOURNED_QUORUM);
    expect(plan.quorumRequired).toBe(3);
    expect(plan.founderPresenceRequired).toBe(true);
    expect(plan.rule).toBe('board_adjourned_reduced_quorum');
    expect(plan.inheritsNotice).toBe(true);
  });

  it('the Board adjourned quorum rule itself: 3 with Founder passes, 3 or 4 without fails', () => {
    const sitting = boardMeeting({ type: 'adjourned', quorumRequired: 3 });
    expect(quorumFor(sitting, present(3, { founderAtIndex: 0 })).met).toBe(true);
    expect(quorumFor(sitting, present(3)).met).toBe(false);
    expect(quorumFor(sitting, present(4)).met).toBe(false);
  });

  it('non-Board adjournment reconvenes same time next week with quorum copied', () => {
    const meeting = necMeeting();
    const plan = buildReconvenePlan(meeting);
    expect(plan.scheduledAt).toBe(START + 7 * 24 * 60 * MIN);
    // Same weekday and clock time exactly one week later.
    expect(new Date(plan.scheduledAt).getUTCDay()).toBe(new Date(START).getUTCDay());
    expect(new Date(plan.scheduledAt).getUTCHours()).toBe(new Date(START).getUTCHours());
    expect(new Date(plan.scheduledAt).getUTCMinutes()).toBe(new Date(START).getUTCMinutes());
    expect(plan.quorumRequired).toBe(meeting.quorumRequired);
    expect(plan.founderPresenceRequired).toBe(false);
    expect(plan.rule).toBe('same_time_next_week');
  });
});
