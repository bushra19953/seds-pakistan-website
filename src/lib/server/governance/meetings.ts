/**
 * Meetings server service (Phase 3 Meetings CORE, Increment 1).
 * Admin SDK only. LOCAL BUILD ONLY: this code would write when deployed;
 * it is not deployed by this slice.
 *
 * Committed-code choices (override the interfaces file where they differ):
 * - Body shape comes from src/lib/governance/bodies.ts (not types.ts):
 *   fields id/name/type/chairUid/secretaryUid/memberUids/quorumOverride/
 *   quorum/chapterId. quorumRequired is resolved with that module's
 *   resolveQuorumRequired (quorum config lives there by its own header).
 * - Quorum EVALUATION at verify time goes through
 *   src/lib/governance/quorum-adapter.ts evaluateQuorum, the lifecycle
 *   slice's only quorum entry point, using the meeting's STORED
 *   quorumRequired (never recomputed from a live body).
 * - Agenda is embedded on the meeting doc (contract section 3), built
 *   with agenda.ts buildAgendaItem.
 * - meeting_attendance is a TOP-LEVEL collection, doc id
 *   `${meetingId}_${uid}` (contract section 2a).
 * - Notice validation is notice-periods.ts validateNotice; deemed receipt
 *   is that module's deemedReceivedAt.
 */
import {
  resolveQuorumRequired,
  type Body,
} from '@/lib/governance/bodies';
import {
  validateNotice,
  deemedReceivedAt as computeDeemedReceivedAt,
} from '@/lib/governance/notice-periods';
import { evaluateQuorum } from '@/lib/governance/quorum-adapter';
import { buildAgendaItem, type AgendaItem } from '@/lib/governance/agenda';
import type { MeetingStatus, MeetingType } from '@/lib/governance/meeting-lifecycle';
import { isFounder } from '@/lib/roles';

export type { MeetingStatus, MeetingType };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MeetingServiceError extends Error {
  readonly error_code: string;
  readonly status: number;
  readonly earliestAllowed: Date | null;
  constructor(error_code: string, message: string, status = 422, earliestAllowed: Date | null = null) {
    super(message);
    this.name = 'MeetingServiceError';
    this.error_code = error_code;
    this.status = status;
    this.earliestAllowed = earliestAllowed;
  }
}

/** Typed forbidden result for verifyQuorum by a non-chair (route maps to 403). */
export class QuorumForbiddenError extends MeetingServiceError {
  constructor(actorUid: string) {
    super('forbidden_not_chair', `Only the meeting chair may verify quorum (actor ${actorUid})`, 403);
    this.name = 'QuorumForbiddenError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Firestore-like handle: the real Admin Firestore or a fake store in tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FirestoreLike = any;

export interface Meeting {
  id: string;
  bodyId: string;
  bodyType: Body['type'];
  type: MeetingType;
  title: string;
  scheduledAt: Date;
  durationMinutes: number;
  location: string | null;
  meetingLink: string | null;
  chairUid: string;
  convenorUid: string;
  secretaryUid: string;
  status: MeetingStatus;
  noticeSentAt: Date | null;
  deemedReceivedAt: Date | null;
  noticeEmailLogIds: string[];
  agenda: AgendaItem[];
  agendaAmendedAt?: Date | null;
  consentId: string | null;
  parentMeetingId: string | null;
  quorumRequired: number;
  quorumVerifiedAt: Date | null;
  quorumVerifiedBy: string | null;
  minutesId: string | null;
  filingTaskIds: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  cancelledBy: string | null;
  cancelReason: string | null;
}

export interface AttendanceRecordFull {
  id: string;
  meetingId: string;
  bodyId: string;
  uid: string;
  displayName: string;
  mode: 'in_person' | 'electronic' | 'absent';
  checkedInAt: Date | null;
  leftAt: Date | null;
  isPresent: boolean;
  isFounder: boolean;
  updatedBy: string;
  updatedAt: Date;
}

export interface CreateMeetingInput {
  bodyId: string;
  type: Exclude<MeetingType, 'adjourned'>;
  title: string;
  scheduledAt: Date;
  durationMinutes: number;
  location?: string | null;
  meetingLink?: string | null;
  consentId?: string | null;
  /** Caller-supplied consent state for the ADAPTER lookup (see below). */
  consentState?: ConsentLookupResult | null;
  agenda?: Array<{ title: string; description?: string; decisionClassId?: string | null }>;
  actorUid: string;
  meetingId?: string;
  parentMeetingId?: string | null;
  now?: Date;
}

export interface CreateMeetingResult {
  meetingId: string;
  status: MeetingStatus;
  quorumRequired: number;
  deemedReceivedAt: Date | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// ADAPTER: Consent RECORD lookup
// ---------------------------------------------------------------------------

export interface ConsentLookupResult {
  consentId: string | null;
  /** true = decided (granted|conditional), false = linked but not decided,
   *  undefined = no consent record linked/found. Matches validateNotice. */
  decided?: boolean;
  state: 'decided' | 'not_decided' | 'missing' | 'caller_supplied';
}

/**
 * Consent state lookup (integration step 8: stub replaced with the real
 * Phase 2 schema). This service never creates or decides a Consent. When
 * the caller supplies a state it is returned verbatim (caller-supplied
 * state in, same state out). Otherwise the consent request is read from
 * the real collection `consent_requests` and the real status vocabulary
 * applies (src/types/consent.ts): decided means the Founder has decided
 * the request - status consented | conditional | executed (the same
 * decided set consent-service's getDecidedConsent uses). Known but
 * undecided statuses map to decided=false; a missing doc or unknown
 * status maps to decided=undefined. Note this is a by-id state read for
 * notice validation, not a Reserved Matter gate check - gates go
 * through checkConsentGate (src/lib/server/consent-lookup.ts).
 */
const DECIDED_CONSENT_STATUSES: ReadonlySet<string> = new Set([
  'consented',
  'conditional',
  'executed',
]);
const KNOWN_UNDECIDED_CONSENT_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'pending',
  'further_information_requested',
  'refused',
  'waived',
  'deemed_withheld',
  'cancelled',
]);

export async function lookupConsentState(
  db: FirestoreLike,
  consentId: string | null | undefined,
  callerSuppliedState?: ConsentLookupResult | null,
): Promise<ConsentLookupResult> {
  if (callerSuppliedState) return callerSuppliedState;
  if (!consentId) return { consentId: null, decided: undefined, state: 'missing' };
  try {
    const snap = await db.collection('consent_requests').doc(consentId).get();
    if (!snap.exists) return { consentId, decided: undefined, state: 'missing' };
    const status = String(snap.data()?.status ?? '');
    if (DECIDED_CONSENT_STATUSES.has(status)) {
      return { consentId, decided: true, state: 'decided' };
    }
    if (KNOWN_UNDECIDED_CONSENT_STATUSES.has(status)) {
      return { consentId, decided: false, state: 'not_decided' };
    }
    return { consentId, decided: undefined, state: 'missing' };
  } catch {
    return { consentId, decided: undefined, state: 'missing' };
  }
}

// ---------------------------------------------------------------------------
// ADAPTER: notice email dispatch
// ---------------------------------------------------------------------------

export interface NoticeDispatchResult {
  logId: string;
  sent: boolean;
}

/**
 * ADAPTER stub: dispatchNoticeEmail.
 * Real email dispatch (register emails + mailer) is wired by a later slice.
 * This stub performs NO external send; it returns a deterministic log id so
 * sendNotice can record it in noticeEmailLogIds. Callers may inject a real
 * dispatcher via sendNotice's opts.dispatcher.
 */
export async function dispatchNoticeEmail(input: {
  meetingId: string;
  bodyId: string;
  title: string;
  scheduledAt: Date;
}): Promise<NoticeDispatchResult> {
  return { logId: `stub-notice-${input.meetingId}`, sent: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const v = value as { toDate?: () => Date };
  if (typeof v.toDate === 'function') return v.toDate();
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function loadBody(db: FirestoreLike, bodyId: string): Promise<Body | null> {
  const snap = await db.collection('bodies').doc(bodyId).get();
  if (!snap.exists) return null;
  const d = snap.data() ?? {};
  return {
    id: snap.id ?? bodyId,
    name: d.name ?? '',
    type: d.type,
    chairUid: d.chairUid ?? '',
    secretaryUid: d.secretaryUid ?? '',
    memberUids: Array.isArray(d.memberUids) ? d.memberUids : [],
    quorumOverride: d.quorumOverride ?? null,
    quorum: d.quorum ?? null,
    chapterId: d.chapterId ?? null,
    term: d.term ?? null,
    createdBy: d.createdBy ?? null,
    updatedBy: d.updatedBy ?? null,
  } as Body;
}

function meetingFromDoc(id: string, d: Record<string, unknown>): Meeting {
  return {
    id,
    bodyId: String(d.bodyId ?? ''),
    bodyType: d.bodyType as Body['type'],
    type: d.type as MeetingType,
    title: String(d.title ?? ''),
    scheduledAt: toDate(d.scheduledAt) ?? new Date(0),
    durationMinutes: Number(d.durationMinutes ?? 0),
    location: (d.location as string | null) ?? null,
    meetingLink: (d.meetingLink as string | null) ?? null,
    chairUid: String(d.chairUid ?? ''),
    convenorUid: String(d.convenorUid ?? ''),
    secretaryUid: String(d.secretaryUid ?? ''),
    status: d.status as MeetingStatus,
    noticeSentAt: toDate(d.noticeSentAt),
    deemedReceivedAt: toDate(d.deemedReceivedAt),
    noticeEmailLogIds: Array.isArray(d.noticeEmailLogIds) ? (d.noticeEmailLogIds as string[]) : [],
    agenda: Array.isArray(d.agenda) ? (d.agenda as AgendaItem[]) : [],
    agendaAmendedAt: toDate(d.agendaAmendedAt),
    consentId: (d.consentId as string | null) ?? null,
    parentMeetingId: (d.parentMeetingId as string | null) ?? null,
    quorumRequired: Number(d.quorumRequired ?? 0),
    quorumVerifiedAt: toDate(d.quorumVerifiedAt),
    quorumVerifiedBy: (d.quorumVerifiedBy as string | null) ?? null,
    minutesId: (d.minutesId as string | null) ?? null,
    filingTaskIds: Array.isArray(d.filingTaskIds) ? (d.filingTaskIds as string[]) : [],
    createdBy: String(d.createdBy ?? ''),
    createdAt: toDate(d.createdAt) ?? new Date(0),
    updatedAt: toDate(d.updatedAt) ?? new Date(0),
    cancelledBy: (d.cancelledBy as string | null) ?? null,
    cancelReason: (d.cancelReason as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// createMeeting
// ---------------------------------------------------------------------------

export async function createMeeting(
  db: FirestoreLike,
  input: CreateMeetingInput,
): Promise<CreateMeetingResult> {
  const now = input.now ?? new Date();
  const body = await loadBody(db, input.bodyId);
  if (!body) {
    throw new MeetingServiceError('body_not_found', `Body not found: ${input.bodyId}`, 404);
  }
  if (!input.location && !input.meetingLink) {
    throw new MeetingServiceError(
      'location_or_link_required',
      'A meeting needs a location or a meeting link',
      422,
    );
  }

  // Consent RECORD lookup via the ADAPTER (caller-supplied state wins).
  const consent = await lookupConsentState(db, input.consentId ?? null, input.consentState ?? null);

  const notice = validateNotice({
    bodyType: body.type,
    meetingType: input.type,
    scheduledAt: input.scheduledAt,
    noticeSentAt: now,
    consentDecided: consent.decided,
  });
  if (!notice.ok) {
    throw new MeetingServiceError(notice.error_code, `Notice validation failed: ${notice.error_code}`, 422, notice.earliestAllowed);
  }

  const quorumRequired = resolveQuorumRequired(body);
  const agenda: AgendaItem[] = (input.agenda ?? []).map((item, i) =>
    buildAgendaItem(
      { title: item.title, description: item.description ?? '', decisionClassId: item.decisionClassId ?? null, attachments: [] },
      input.actorUid,
      input.actorUid === body.chairUid ? 'chair' : 'member_submission',
      `agenda-${i + 1}`,
    ),
  );

  const ref = input.meetingId
    ? db.collection('meetings').doc(input.meetingId)
    : db.collection('meetings').doc();
  const meetingId: string = ref.id;

  const doc: Record<string, unknown> = {
    bodyId: body.id,
    bodyType: body.type,
    type: input.type,
    title: input.title,
    scheduledAt: input.scheduledAt,
    durationMinutes: input.durationMinutes,
    location: input.location ?? null,
    meetingLink: input.meetingLink ?? null,
    chairUid: body.chairUid,
    convenorUid: input.actorUid,
    secretaryUid: body.secretaryUid,
    status: 'draft' as MeetingStatus,
    noticeSentAt: null,
    deemedReceivedAt: null,
    noticeEmailLogIds: [] as string[],
    agenda,
    consentId: input.consentId ?? null,
    parentMeetingId: input.parentMeetingId ?? null,
    quorumRequired,
    quorumVerifiedAt: null,
    quorumVerifiedBy: null,
    minutesId: null,
    filingTaskIds: [] as string[],
    createdBy: input.actorUid,
    createdAt: now,
    updatedAt: now,
    cancelledBy: null,
    cancelReason: null,
  };
  await ref.set(doc);

  // Pre-create one absent attendance doc per member (contract 2c).
  for (const uid of body.memberUids) {
    const attId = `${meetingId}_${uid}`;
    await db.collection('meeting_attendance').doc(attId).set({
      id: attId,
      meetingId,
      bodyId: body.id,
      uid,
      displayName: '',
      mode: 'absent',
      checkedInAt: null,
      leftAt: null,
      isPresent: false,
      isFounder: isFounder(uid),
      updatedBy: input.actorUid,
      updatedAt: now,
    });
  }

  return { meetingId, status: 'draft', quorumRequired, deemedReceivedAt: null, warnings: [] };
}

export async function getMeeting(db: FirestoreLike, meetingId: string): Promise<Meeting | null> {
  const snap = await db.collection('meetings').doc(meetingId).get();
  if (!snap.exists) return null;
  return meetingFromDoc(snap.id ?? meetingId, snap.data() ?? {});
}

export async function listMeetings(
  db: FirestoreLike,
  filter: { bodyId?: string; status?: MeetingStatus } = {},
): Promise<Meeting[]> {
  let q = db.collection('meetings');
  if (filter.bodyId) q = q.where('bodyId', '==', filter.bodyId);
  if (filter.status) q = q.where('status', '==', filter.status);
  const snap = await q.get();
  const docs: Array<{ id: string; data: () => Record<string, unknown> }> = snap.docs ?? [];
  return docs.map((d) => meetingFromDoc(d.id, d.data() ?? {}));
}

export async function cancelMeeting(
  db: FirestoreLike,
  input: { meetingId: string; actorUid: string; cancelReason: string },
): Promise<void> {
  const ref = db.collection('meetings').doc(input.meetingId);
  const snap = await ref.get();
  if (!snap.exists) throw new MeetingServiceError('meeting_not_found', `Meeting not found: ${input.meetingId}`, 404);
  await ref.update({
    status: 'cancelled',
    cancelledBy: input.actorUid,
    cancelReason: input.cancelReason,
    updatedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// sendNotice
// ---------------------------------------------------------------------------

export async function sendNotice(
  db: FirestoreLike,
  input: {
    meetingId: string;
    actorUid: string;
    now?: Date;
    dispatcher?: typeof dispatchNoticeEmail;
  },
): Promise<{ meetingId: string; status: MeetingStatus; noticeSentAt: Date; deemedReceivedAt: Date; logId: string }> {
  const now = input.now ?? new Date();
  const meeting = await getMeeting(db, input.meetingId);
  if (!meeting) throw new MeetingServiceError('meeting_not_found', `Meeting not found: ${input.meetingId}`, 404);
  if (meeting.status !== 'draft' && meeting.status !== 'noticed') {
    throw new MeetingServiceError('invalid_status', `Cannot send notice for a meeting in status ${meeting.status}`, 422);
  }
  const dispatch = input.dispatcher ?? dispatchNoticeEmail;
  const result = await dispatch({
    meetingId: meeting.id,
    bodyId: meeting.bodyId,
    title: meeting.title,
    scheduledAt: meeting.scheduledAt,
  });
  const deemed = computeDeemedReceivedAt(now);
  const logIds = [...meeting.noticeEmailLogIds, result.logId];
  await db.collection('meetings').doc(meeting.id).update({
    noticeSentAt: now,
    deemedReceivedAt: deemed,
    noticeEmailLogIds: logIds,
    status: 'noticed' as MeetingStatus,
    updatedAt: now,
  });
  return { meetingId: meeting.id, status: 'noticed', noticeSentAt: now, deemedReceivedAt: deemed, logId: result.logId };
}

// ---------------------------------------------------------------------------
// recordAttendance
// ---------------------------------------------------------------------------

export async function recordAttendance(
  db: FirestoreLike,
  input: {
    meetingId: string;
    uid: string;
    mode: 'in_person' | 'electronic' | 'absent';
    actorUid: string;
    displayName?: string;
    now?: Date;
  },
): Promise<AttendanceRecordFull> {
  const now = input.now ?? new Date();
  const meeting = await getMeeting(db, input.meetingId);
  if (!meeting) throw new MeetingServiceError('meeting_not_found', `Meeting not found: ${input.meetingId}`, 404);
  const id = `${input.meetingId}_${input.uid}`;
  const record: AttendanceRecordFull = {
    id,
    meetingId: input.meetingId,
    bodyId: meeting.bodyId,
    uid: input.uid,
    displayName: input.displayName ?? '',
    mode: input.mode,
    checkedInAt: input.mode === 'absent' ? null : now,
    leftAt: null,
    isPresent: input.mode !== 'absent',
    isFounder: isFounder(input.uid),
    updatedBy: input.actorUid,
    updatedAt: now,
  };
  await db.collection('meeting_attendance').doc(id).set({ ...record });
  return record;
}

export async function listAttendance(db: FirestoreLike, meetingId: string): Promise<AttendanceRecordFull[]> {
  const snap = await db.collection('meeting_attendance').where('meetingId', '==', meetingId).get();
  const docs: Array<{ id: string; data: () => Record<string, unknown> }> = snap.docs ?? [];
  return docs.map((d) => {
    const data = d.data() ?? {};
    return {
      id: d.id,
      meetingId: String(data.meetingId ?? meetingId),
      bodyId: String(data.bodyId ?? ''),
      uid: String(data.uid ?? ''),
      displayName: String(data.displayName ?? ''),
      mode: data.mode as AttendanceRecordFull['mode'],
      checkedInAt: toDate(data.checkedInAt),
      leftAt: toDate(data.leftAt),
      isPresent: Boolean(data.isPresent),
      isFounder: Boolean(data.isFounder),
      updatedBy: String(data.updatedBy ?? ''),
      updatedAt: toDate(data.updatedAt) ?? new Date(0),
    };
  });
}

// ---------------------------------------------------------------------------
// verifyQuorum (chair only)
// ---------------------------------------------------------------------------

export interface VerifyQuorumResult {
  meetingId: string;
  presentCount: number;
  quorumRequired: number;
  quorumMet: boolean;
  quorumVerifiedAt: Date | null;
  quorumVerifiedBy: string | null;
}

export async function verifyQuorum(
  db: FirestoreLike,
  input: { meetingId: string; actorUid: string; now?: Date },
): Promise<VerifyQuorumResult> {
  const now = input.now ?? new Date();
  const meeting = await getMeeting(db, input.meetingId);
  if (!meeting) throw new MeetingServiceError('meeting_not_found', `Meeting not found: ${input.meetingId}`, 404);
  if (meeting.chairUid !== input.actorUid) {
    throw new QuorumForbiddenError(input.actorUid);
  }
  const attendance = await listAttendance(db, input.meetingId);
  const evaluation = evaluateQuorum({
    bodyType: meeting.bodyType,
    quorumRequired: meeting.quorumRequired,
    isAdjournedSitting: meeting.type === 'adjourned',
    attendance: attendance.map((a) => ({ uid: a.uid, mode: a.mode, isPresent: a.isPresent, isFounder: a.isFounder })),
  });
  if (!evaluation.met) {
    return {
      meetingId: meeting.id,
      presentCount: evaluation.presentCount,
      quorumRequired: meeting.quorumRequired,
      quorumMet: false,
      quorumVerifiedAt: null,
      quorumVerifiedBy: null,
    };
  }
  const patch: Record<string, unknown> = {
    quorumVerifiedAt: now,
    quorumVerifiedBy: input.actorUid,
    updatedAt: now,
  };
  if (meeting.status === 'noticed' || meeting.status === 'draft') {
    patch.status = 'convened';
  }
  await db.collection('meetings').doc(meeting.id).update(patch);
  return {
    meetingId: meeting.id,
    presentCount: evaluation.presentCount,
    quorumRequired: meeting.quorumRequired,
    quorumMet: true,
    quorumVerifiedAt: now,
    quorumVerifiedBy: input.actorUid,
  };
}
