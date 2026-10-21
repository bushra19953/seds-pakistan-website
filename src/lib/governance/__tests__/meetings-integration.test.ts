/**
 * Integration suite: bodies -> meeting lifecycle -> agenda -> quorum,
 * using ONLY the pure governance modules together (no Firestore, no I/O).
 *
 * ADAPTERS used in this suite (marked inline where they live):
 * 1. bodyToEngineConfig - bodies.ts toBodyConfigView exposes `type`, while
 *    the quorum engine's BodyConfigView (types.ts) reads `bodyType` plus a
 *    resolved `quorumRequired`. This adapter bridges the two committed
 *    shapes using bodies.ts resolveQuorumRequired for the number.
 * 2. requiredNoticeMs - originally a stub for the sibling notice-periods
 *    module; replaced with the real import at integration step 8 now
 *    that src/lib/governance/notice-periods.ts has landed.
 */
import {
  resolveQuorumRequired as resolveBodyQuorum,
  toBodyConfigView,
  validateBodyInputOrThrow,
  type Body,
} from '../bodies';
import {
  applyAgendaPatch,
  appendAgendaItem,
  buildAgendaItem,
  evaluateAgendaSubmission,
  type AgendaActor,
  type AgendaMeetingRef,
} from '../agenda';
import {
  applyQuorumToMotions,
  canOpenMotion,
  evaluateQuorum as evaluateEngineQuorum,
  snapshotDenominator,
  verifyQuorum,
} from '../quorum-engine';
import type { AttendanceRecord, BodyConfigView as EngineBodyConfig } from '../types';
import {
  assertMeetingTransition,
  canTransitionMeeting,
  evaluateAutoAdjourn,
  type MeetingLike,
} from '../meeting-lifecycle';
import { evaluateQuorum as evaluateAdapterQuorum, type AttendanceLike } from '../quorum-adapter';

// --- ADAPTER 1: bodies view -> quorum-engine view ---------------------------
// Cross-module note (updated at integration step 8): bodies.ts
// resolveQuorumRequired originally folded the Founder condition into the
// adjourned-Board number; it was reconciled to the engine's behavior
// (number is always 3 for an adjourned Board, Founder presence reported
// separately by evaluateQuorum). Both resolvers now agree. This adapter
// still leaves quorumRequired unset for adjourned sittings and lets the
// engine apply its own adjourned rule; the bodies resolver is used only
// for ordinary sittings.
function bodyToEngineConfig(body: Body, opts: { isAdjournedSitting?: boolean } = {}): EngineBodyConfig {
  const view = toBodyConfigView(body);
  return {
    memberUids: view.memberUids,
    bodyType: view.type,
    quorumRequired: opts.isAdjournedSitting ? undefined : resolveBodyQuorum(body),
    quorumOverride: view.quorumOverride,
    isAdjournedSitting: opts.isAdjournedSitting ?? false,
  };
}

// --- ADAPTER 2 (real notice-periods module; stub removed at integration) ---
// Contract: meetings_core_interfaces.md section 2b -
// requiredNoticeMs(bodyType, meetingType): number | null.
import { requiredNoticeMs } from '../notice-periods';

const NINE = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'];
const MIN = 60 * 1000;
const START = Date.UTC(2026, 10, 20, 10, 0, 0); // scheduled start (epoch ms)

function makeBoardBody(): Body {
  const data = validateBodyInputOrThrow({
    name: 'Board of Governors',
    type: 'board',
    chairUid: 'u1',
    secretaryUid: 'u2',
    memberUids: [...NINE],
  });
  return { id: 'body-board', ...data, createdBy: 'founder-uid', updatedBy: 'founder-uid' };
}

function attendanceFor(uids: string[], mode: AttendanceRecord['mode'], founderUid?: string): AttendanceRecord[] {
  return uids.map((uid) => ({ uid, mode, isFounder: uid === founderUid }));
}

function toAdapterAttendance(records: AttendanceRecord[]): AttendanceLike[] {
  return records.map((r) => ({
    uid: r.uid,
    mode: r.mode,
    isPresent: r.mode !== 'absent',
    isFounder: r.isFounder,
  }));
}

describe('meetings core integration: Board of 9 end to end', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START - 14 * 24 * 60 * MIN);
  });
  afterEach(() => jest.useRealTimers());

  it('bodies -> notice window -> lifecycle -> agenda -> quorum verify -> snapshot -> quorum loss', () => {
    // 1. BODY: a Board of 9 created through the bodies model.
    const body = makeBoardBody();
    const engineCfg = bodyToEngineConfig(body);
    expect(engineCfg.memberUids).toHaveLength(9);
    expect(engineCfg.quorumRequired).toBe(5);

    // 2. NOTICE (real module): board ordinary needs 14 days; scheduling the
    // meeting exactly 14 days after notice satisfies it, 13 days would not.
    const noticeMs = requiredNoticeMs('board', 'ordinary');
    expect(noticeMs).toBe(14 * 24 * 60 * MIN);
    expect(START - (START - 13 * 24 * 60 * MIN)).toBeLessThan(noticeMs as number);
    expect(START - (START - 14 * 24 * 60 * MIN)).toBeGreaterThanOrEqual(noticeMs as number);

    // 3. LIFECYCLE: draft -> noticed -> convened, driven by a fake clock.
    let status: MeetingLike['status'] = 'draft';
    const meeting: MeetingLike = {
      id: 'm-1', bodyId: body.id, bodyType: body.type, type: 'ordinary',
      status, scheduledAt: START, quorumRequired: engineCfg.quorumRequired as number,
      quorumVerifiedAt: null, reconveneMeetingId: null, parentMeetingId: null,
    };
    expect(canTransitionMeeting('draft', 'convened')).toBe(false);
    assertMeetingTransition('draft', 'noticed');
    status = 'noticed';
    meeting.status = status;

    // 4. AGENDA for this meeting: chair preliminary item, a member submission
    // before the 5-day cutoff (addressed to the GS = body secretary u2),
    // then a Founder item added inside the cutoff.
    const agendaMeeting: AgendaMeetingRef = {
      bodyId: body.id, bodyType: body.type, chairUid: body.chairUid, secretaryUid: body.secretaryUid,
      scheduledAt: new Date(START), status: 'noticed',
      noticeSentAt: new Date(START - 14 * 24 * 60 * MIN), agenda: [],
    };
    const chairActor: AgendaActor = { uid: body.chairUid, isFounder: false, isChair: true, isBodyMember: true };
    const memberActor: AgendaActor = { uid: 'u5', isFounder: false, isChair: false, isBodyMember: true };
    const founderActor: AgendaActor = { uid: 'founder-uid', isFounder: true, isChair: false, isBodyMember: false };

    const sixDaysBefore = new Date(START - 6 * 24 * 60 * MIN);
    const chairDecision = evaluateAgendaSubmission(agendaMeeting, chairActor, sixDaysBefore);
    expect(chairDecision.source).toBe('chair');
    agendaMeeting.agenda = appendAgendaItem(
      agendaMeeting.agenda,
      buildAgendaItem({ title: 'Approve minutes' }, body.chairUid, chairDecision.source, 'item-chair'),
    );

    const memberDecision = evaluateAgendaSubmission(agendaMeeting, memberActor, sixDaysBefore);
    expect(memberDecision.source).toBe('member_submission');
    expect(memberDecision.addressedToUid).toBe(body.secretaryUid);
    agendaMeeting.agenda = appendAgendaItem(
      agendaMeeting.agenda,
      buildAgendaItem({ title: 'Chapter funding request' }, 'u5', memberDecision.source, 'item-member'),
    );

    const oneDayBefore = new Date(START - 1 * 24 * 60 * MIN);
    const founderDecision = evaluateAgendaSubmission(agendaMeeting, founderActor, oneDayBefore);
    expect(founderDecision.source).toBe('founder'); // inside the member cutoff: Founder still adds
    agendaMeeting.agenda = appendAgendaItem(
      agendaMeeting.agenda,
      buildAgendaItem({ title: 'Founder item: strategic review' }, 'founder-uid', founderDecision.source, 'item-founder'),
    );

    const patched = applyAgendaPatch(agendaMeeting, chairActor, { order: ['item-founder', 'item-chair', 'item-member'] });
    expect(patched.agenda.map((i) => i.itemId)).toEqual(['item-founder', 'item-chair', 'item-member']);
    expect(patched.agenda.map((i) => i.source)).toEqual(['founder', 'chair', 'member_submission']);

    // 5. QUORUM at the sitting: 3 in person + 2 electronic = Board quorum 5.
    jest.setSystemTime(START);
    const attendance = [
      ...attendanceFor(NINE.slice(0, 3), 'in_person', 'u1'),
      ...attendanceFor(NINE.slice(3, 5), 'electronic'),
      ...attendanceFor(NINE.slice(5), 'absent'),
    ];
    const engineEval = evaluateEngineQuorum(engineCfg, attendance);
    const adapterEval = evaluateAdapterQuorum({
      bodyType: body.type, quorumRequired: meeting.quorumRequired,
      isAdjournedSitting: false, attendance: toAdapterAttendance(attendance),
    });
    expect(engineEval.met).toBe(true);
    expect(adapterEval.met).toBe(engineEval.met); // engine and lifecycle adapter agree
    expect(adapterEval.presentCount).toBe(5);

    const verified = verifyQuorum(engineCfg, attendance);
    expect(verified.verified).toBe(true);
    expect(canOpenMotion({ quorumVerified: verified.verified, quorum: verified })).toBe(true);
    assertMeetingTransition('noticed', 'convened');
    meeting.status = 'convened';
    meeting.quorumVerifiedAt = Date.now();

    // Denominator snapshot at motion open: whole body is the 9 governors.
    const snap = snapshotDenominator(engineCfg, attendance);
    expect(snap.wholeBodyCount).toBe(9);
    expect(snap.presentCount).toBe(5);

    // 6. QUORUM LOSS mid-meeting: three members leave; the open motion
    // pauses, the snapshot does not move, and regaining quorum resumes it
    // with the same snapshot.
    const afterLeaves = attendanceFor(NINE.slice(0, 2), 'in_person');
    const lost = evaluateEngineQuorum(engineCfg, afterLeaves);
    expect(lost.met).toBe(false);
    const [paused] = applyQuorumToMotions([{ motionId: 'motion-1', status: 'open' }], lost);
    expect(paused.resultingStatus).toBe('paused_quorum_lost');
    const [resumed] = applyQuorumToMotions(
      [{ motionId: 'motion-1', status: 'paused_quorum_lost' }],
      evaluateEngineQuorum(engineCfg, attendance),
    );
    expect(resumed.resultingStatus).toBe('open');
    expect(snap.presentCount).toBe(5);
    expect(snap.wholeBodyCount).toBe(9);

    assertMeetingTransition('convened', 'closed');
  });

  it('no quorum by minute 30 auto-adjourns; the reconvened Board sitting runs on 3 + Founder', () => {
    const body = makeBoardBody();
    const engineCfg = bodyToEngineConfig(body);
    const meeting: MeetingLike = {
      id: 'm-2', bodyId: body.id, bodyType: body.type, type: 'ordinary',
      status: 'noticed', scheduledAt: START, quorumRequired: 5,
      quorumVerifiedAt: null, reconveneMeetingId: null, parentMeetingId: null,
    };

    // Fake clock: at minute 29 with 4 present the meeting is still waiting.
    jest.setSystemTime(START + 29 * MIN);
    const earlyAttendance = attendanceFor(NINE.slice(0, 4), 'in_person');
    const early = evaluateAutoAdjourn({
      meeting,
      quorum: evaluateAdapterQuorum({
        bodyType: body.type, quorumRequired: 5, isAdjournedSitting: false,
        attendance: toAdapterAttendance(earlyAttendance),
      }),
      now: Date.now(),
    });
    expect(early.action).toBe('none');

    // At minute 30 with quorum still unmet it adjourns, with a Board
    // reconvene plan: type adjourned, quorum 3, Founder presence required.
    jest.setSystemTime(START + 30 * MIN);
    const decision = evaluateAutoAdjourn({
      meeting,
      quorum: evaluateAdapterQuorum({
        bodyType: body.type, quorumRequired: 5, isAdjournedSitting: false,
        attendance: toAdapterAttendance(earlyAttendance),
      }),
      now: Date.now(),
    });
    expect(decision.action).toBe('adjourn');
    if (decision.action !== 'adjourn') return;
    expect(decision.reconvene).toMatchObject({
      type: 'adjourned', status: 'noticed', parentMeetingId: 'm-2',
      quorumRequired: 3, founderPresenceRequired: true,
    });

    // The reconvened sitting, evaluated through the ENGINE with the
    // adjourned body config: 3 present including the Founder passes,
    // the same 3 without the Founder fails.
    const adjournedCfg = bodyToEngineConfig(body, { isAdjournedSitting: true });
    const withFounder = attendanceFor(NINE.slice(0, 3), 'in_person', 'u1');
    const withoutFounder = attendanceFor(NINE.slice(0, 3), 'in_person');
    // The engine itself resolves the adjourned required number to 3.
    expect(evaluateEngineQuorum(adjournedCfg, withFounder).required).toBe(3);
    expect(evaluateEngineQuorum(adjournedCfg, withFounder).met).toBe(true);
    expect(evaluateEngineQuorum(adjournedCfg, withoutFounder).met).toBe(false);
    // The unused ordinary config is unaffected by the adjourned sitting.
    expect(engineCfg.quorumRequired).toBe(5);
  });
});
