// Founder Consent service (Phase 2 spec, Section A).
// The ONLY writer of consent_requests. Every state change writes the doc
// update, one history entry, and one audit_logs entry together (batch or
// transaction); audit failure fails the action (Section 0.5 contract).
// Client writes to consent_requests are denied in rules; everything here
// runs through the Admin SDK.

import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { FOUNDER_UID } from '@/lib/roles';
import type {
  ConsentAttachment,
  ConsentRequest,
  ConsentStatus,
} from '@/types/consent';
import { getReservedMatter } from '@/lib/consents/reserved-matters';
import {
  canTransition,
  computeDecisionDeadline,
  isDecidedStatus,
  REGISTER_STATUSES,
  validateDecisionShape,
  validateSubmissionFields,
} from '@/lib/consents/consent-state';
import { getConsentConfig } from '@/lib/consents/consent-config';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { consentSubjectsMatch } from '@/lib/server/consent-subject';
import {
  CONSENT_GATE_MATTER_KEYS,
  type ConsentSubjectRef,
} from '@/lib/server/consent-gate-types';
import { resolveUserRoleKey } from '@/lib/server/role-holders';
import { notificationService } from '@/lib/server/notification-service';
import {
  consentsSupaEnabled,
  getConsentViaSeam,
  listConsentsViaSeam,
  mirrorConsentHistorySet,
  mirrorConsentSet,
} from '@/lib/server/consents-supa';

export class ConsentServiceError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;
  constructor(
    code: string,
    status: number,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ConsentServiceError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

const notFound = () =>
  new ConsentServiceError('CONSENT_NOT_FOUND', 404, 'Consent request not found');
const forbidden = () =>
  new ConsentServiceError(
    'CONSENT_FORBIDDEN',
    403,
    'You do not have access to this Consent request',
  );
const notFounder = () =>
  new ConsentServiceError(
    'NOT_FOUNDER',
    403,
    'Only the Founder decides Consent requests',
  );
const alreadyDecided = () =>
  new ConsentServiceError(
    'ALREADY_DECIDED',
    409,
    'This Consent request has already been decided',
  );
const invalidTransition = (from: string, to: string) =>
  new ConsentServiceError(
    'CONSENT_INVALID_TRANSITION',
    409,
    `Cannot move a Consent request from ${from} to ${to}`,
  );

const COLLECTION = 'consent_requests';
const MAX_ATTACHMENTS = 10;

type DocData = Record<string, any>;

function karachiDateStr(now: Date): string {
  // en-CA yields YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function karachiYear(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
  }).format(now);
}

async function loadRequest(
  db: Firestore,
  id: string,
): Promise<{ ref: any; data: DocData }> {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap || !snap.exists) throw notFound();
  return { ref, data: snap.data() as DocData };
}

function historyEntry(
  event: string,
  actorUid: string,
  actorRoleKey: string,
  fromStatus: ConsentStatus | null,
  toStatus: ConsentStatus,
  note?: string | null,
) {
  return {
    event,
    actorUid,
    actorRoleKey,
    fromStatus,
    toStatus,
    note: note ?? null,
    createdAt: FieldValue.serverTimestamp(),
  };
}

// Audit fields written inside a transaction, mirroring the shape produced
// by writeGovernanceAuditOrThrow (which only supports batches/direct
// writes). Used where the state change itself is transactional.
function auditDocData(
  action: string,
  actorUid: string,
  targetId: string,
  details: Record<string, unknown>,
) {
  return {
    action,
    actorUid,
    targetType: 'consent_request',
    targetId,
    details,
    createdAt: FieldValue.serverTimestamp(),
  };
}

async function notifySafely(
  userId: string,
  payload: {
    type: string;
    title: string;
    body: string;
    link?: string;
    metadata?: Record<string, any>;
  },
  priority: 'P0' | 'P1' | 'P2',
): Promise<void> {
  // Notifications fire after the state write commits; a notification
  // failure must never roll back a recorded decision (spec A.9).
  try {
    await notificationService.send(userId, payload, priority);
  } catch (err) {
    console.error('[consent-service] notification failed (state kept)', err);
  }
}

async function actorRoleKey(db: Firestore, uid: string): Promise<string> {
  const fromStore = await resolveUserRoleKey(db, uid);
  if (fromStore) return fromStore;
  return 'member';
}

const FILING_FIELDS = [
  'matterKey',
  'proposedAct',
  'proposedActDate',
  'amountPkr',
  'relatedPartyName',
  'relatedPartyInterest',
  'materialFacts',
  'attachments',
  'isUrgent',
  'urgencyReason',
  // Dialog-link context (matcher fix, 2026-10-26): when the filing
  // form is arrived at from a gated surface's "File a consent request"
  // link, it sends the gate's structured subject + matter so the
  // decided record can be matched exactly. Plain filings omit both.
  'subjectRef',
  'gateMatterKey',
] as const;

/**
 * Shape check for a filing's dialog-link context. A malformed context
 * is a validation error, never a silent drop: a silently dropped
 * subjectRef is exactly how filed consents became unmatchable.
 */
function validateLinkContext(out: DocData): void {
  if (out.gateMatterKey !== undefined && out.gateMatterKey !== null) {
    if (
      typeof out.gateMatterKey !== 'string' ||
      !CONSENT_GATE_MATTER_KEYS.includes(out.gateMatterKey as never)
    ) {
      throw new ConsentServiceError(
        'CONSENT_VALIDATION_FAILED',
        422,
        'Validation failed',
        { gateMatterKey: 'Unknown gate matter.' },
      );
    }
  }
  if (out.subjectRef !== undefined && out.subjectRef !== null) {
    const s = out.subjectRef as Record<string, unknown>;
    const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0;
    let valid = !!s && typeof s === 'object';
    if (valid) {
      switch (s.type) {
        case 'user_role':
        case 'position':
          valid = nonEmpty(s.targetUid) && nonEmpty(s.roleKey) && nonEmpty(s.action);
          break;
        case 'role_definition':
          valid = nonEmpty(s.slug) && nonEmpty(s.action);
          break;
        case 'chapter':
          valid = nonEmpty(s.chapterId) && nonEmpty(s.action);
          break;
        case 'chapter_application':
          valid = nonEmpty(s.applicationId);
          break;
        case 'partner_record':
          valid = nonEmpty(s.collection) && nonEmpty(s.action);
          break;
        default:
          valid = false;
      }
    }
    if (!valid) {
      throw new ConsentServiceError(
        'CONSENT_VALIDATION_FAILED',
        422,
        'Validation failed',
        { subjectRef: 'Malformed consent subject.' },
      );
    }
  }
}

function pickFilingFields(input: DocData): DocData {
  const out: DocData = {};
  for (const key of FILING_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  validateLinkContext(out);
  if (Array.isArray(out.attachments) && out.attachments.length > MAX_ATTACHMENTS) {
    throw new ConsentServiceError(
      'CONSENT_VALIDATION_FAILED',
      422,
      'Validation failed',
      { attachments: `At most ${MAX_ATTACHMENTS} attachments are allowed.` },
    );
  }
  if (typeof out.matterKey === 'string') {
    const matter = getReservedMatter(out.matterKey);
    if (matter) {
      out.scheduleSection = matter.scheduleSection;
      out.matterLabel = matter.label;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function createDraft(
  db: Firestore,
  actorUid: string,
  input: DocData,
): Promise<ConsentRequest> {
  const config = await getConsentConfig(db);
  if (!config.filingsEnabled) {
    throw new ConsentServiceError(
      'CONSENT_FILINGS_DISABLED',
      403,
      'Consent filings are currently disabled',
    );
  }

  // Server-side identity snapshots; body-supplied identity is never read.
  const userSnap = await db.collection('users').doc(actorUid).get();
  const user = (userSnap?.data() ?? {}) as DocData;
  const requesterName =
    (typeof user.displayName === 'string' && user.displayName) ||
    (typeof user.name === 'string' && user.name) ||
    'Unknown';
  const roleFromStore = await resolveUserRoleKey(db, actorUid);
  const requesterRoleKey =
    roleFromStore ||
    (typeof user.role === 'string' && user.role) ||
    'member';
  const requesterChapterId =
    typeof user.chapterId === 'string' ? user.chapterId : null;

  const filing = pickFilingFields(input ?? {});
  const matter =
    typeof filing.matterKey === 'string'
      ? getReservedMatter(filing.matterKey)
      : undefined;

  const ref = db.collection(COLLECTION).doc();
  const data: DocData = {
    requestNumber: null,
    status: 'draft',
    requestedByUid: actorUid,
    requesterName,
    requesterRoleKey,
    requesterChapterId,
    matterKey: '',
    scheduleSection: '',
    matterLabel: '',
    gateModeAtFiling: 'record_only',
    proposedAct: '',
    proposedActDate: '',
    amountPkr: null,
    relatedPartyName: null,
    relatedPartyInterest: null,
    materialFacts: '',
    attachments: [] as ConsentAttachment[],
    isUrgent: false,
    urgencyReason: null,
    decision: null,
    conditions: null,
    consentedScope: null,
    refusedScope: null,
    decisionDate: null,
    decidedByUid: null,
    founderSignatureMarker: null,
    furtherInformationRequest: null,
    furtherInformationResponse: null,
    informationReceivedAt: null,
    submittedAt: null,
    decisionDeadlineAt: null,
    deadlineWarningSentAt: null,
    deemedWithheldAt: null,
    waiverNote: null,
    executedAt: null,
    executionNote: null,
    cancelledAt: null,
    cancellationReason: null,
    decidedAtSort: null,
    subjectRef: null,
    gateMatterKey: null,
    ...filing,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (matter) {
    data.gateModeAtFiling = matter.defaultGateMode;
  }
  await ref.set(data);
  // Dual-write (consents mirror program): the in-memory doc just
  // written is the mirror payload — no Firestore re-read. Never throws.
  await mirrorConsentSet(ref.id, data);
  return { id: ref.id, ...data } as unknown as ConsentRequest;
}

export async function updateDraft(
  db: Firestore,
  id: string,
  actorUid: string,
  patch: DocData,
): Promise<ConsentRequest> {
  const { ref, data } = await loadRequest(db, id);
  if (data.requestedByUid !== actorUid) throw forbidden();
  if (data.status !== 'draft') {
    throw invalidTransition(data.status, 'draft (edit)');
  }
  const filing = pickFilingFields(patch ?? {});
  const update = { ...filing, updatedAt: FieldValue.serverTimestamp() };
  await ref.update(update);
  // Dual-write: the in-memory post-update doc is the mirror payload.
  await mirrorConsentSet(id, { ...data, ...update });
  return { id, ...data, ...update } as unknown as ConsentRequest;
}

export async function getRequest(
  db: Firestore,
  id: string,
): Promise<ConsentRequest> {
  // Seam (consents mirror program): mirror-first when the consents
  // surface is enabled; Firestore only on a seam miss or adapter
  // error. A trusted Firestore hit heals the mirror row. loadRequest
  // itself stays Firestore: the write paths' internal reads must see
  // the primary store.
  try {
    const via = await getConsentViaSeam(id);
    if (via) return via as unknown as ConsentRequest;
  } catch (err) {
    console.warn('[consent-service] seam getRequest failed; falling back to Firestore:', err);
  }
  const { data } = await loadRequest(db, id);
  if (consentsSupaEnabled()) {
    await mirrorConsentSet(id, data);
  }
  return { id, ...data } as unknown as ConsentRequest;
}

export async function listMyRequests(
  db: Firestore,
  uid: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ConsentRequest[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Seam (consents mirror program): mirror-first when enabled. The
  // cursor is a doc id; its createdAt (from the mirror) becomes the
  // adapter's startAfter on the createdAt-desc ordering. A cursor the
  // mirror does not hold falls the whole read back to Firestore.
  try {
    let startAfter: unknown;
    let cursorResolved = !opts.cursor;
    if (opts.cursor) {
      const cursorDoc = await getConsentViaSeam(opts.cursor);
      if (cursorDoc && cursorDoc.createdAt !== undefined) {
        startAfter = cursorDoc.createdAt;
        cursorResolved = true;
      }
    }
    if (cursorResolved) {
      const via = await listConsentsViaSeam({
        where: [['requestedByUid', '==', uid]],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit,
        ...(startAfter !== undefined ? { startAfter } : {}),
      });
      if (via) return via as unknown as ConsentRequest[];
    }
  } catch (err) {
    console.warn('[consent-service] seam listMyRequests failed; falling back to Firestore:', err);
  }
  let query: any = db
    .collection(COLLECTION)
    .where('requestedByUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit);
  if (opts.cursor) {
    const cursorSnap = await db.collection(COLLECTION).doc(opts.cursor).get();
    if (cursorSnap?.exists) query = query.startAfter(cursorSnap);
  }
  const snap = await query.get();
  return snap.docs.map(
    (doc: any) => ({ id: doc.id, ...doc.data() }) as unknown as ConsentRequest,
  );
}

// ---------------------------------------------------------------------------
// Submission (request-number transaction)
// ---------------------------------------------------------------------------

export async function submitRequest(
  db: Firestore,
  id: string,
  actorUid: string,
  now: Date = new Date(),
): Promise<{
  id: string;
  requestNumber: string;
  status: ConsentStatus;
  decisionDeadlineAt: Date;
}> {
  const ref = db.collection(COLLECTION).doc(id);
  const counterRef = db.collection('settings').doc('consent_counter');
  const roleKey = await actorRoleKey(db, actorUid);

  // Dual-write captures (consents mirror program): the transaction
  // callback records the in-memory post-write doc + history entry it
  // committed; after the transaction resolves they are mirrored
  // without any Firestore re-read. On a transaction retry the
  // callback re-runs and overwrites the captures, so the mirrored
  // state is always the committed run's. The idempotent early return
  // writes nothing and leaves the captures null.
  let mirrorPost: DocData | null = null;
  // The asserted initializer keeps the declared union as the flow
  // type: the capture is assigned inside the transaction closure,
  // which TS control-flow cannot see (a plain null initializer would
  // narrow every post-transaction read to never).
  let mirrorHistory: { id: string; entry: DocData } | null = null as { id: string; entry: DocData } | null;

  const result = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap || !snap.exists) throw notFound();
    const data = snap.data() as DocData;
    if (data.requestedByUid !== actorUid) throw forbidden();

    // Idempotent submit: a number already assigned is returned unchanged.
    if (data.requestNumber) {
      return {
        requestNumber: data.requestNumber as string,
        decisionDeadlineAt: data.decisionDeadlineAt,
        alreadySubmitted: true as const,
        isUrgent: data.isUrgent === true,
      };
    }
    if (data.status !== 'draft') {
      throw invalidTransition(data.status, 'pending');
    }

    const errors = validateSubmissionFields(data, karachiDateStr(now));
    if (Object.keys(errors).length > 0) {
      throw new ConsentServiceError(
        'CONSENT_VALIDATION_FAILED',
        422,
        'Submission validation failed',
        errors,
      );
    }

    const counterSnap = await tx.get(counterRef);
    const counters: Record<string, number> =
      (counterSnap?.exists ? (counterSnap.data()?.counters ?? {}) : {}) ?? {};
    const year = karachiYear(now);
    const next = (typeof counters[year] === 'number' ? counters[year] : 0) + 1;
    const requestNumber = `FC-${year}-${String(next).padStart(4, '0')}`;
    tx.set(
      counterRef,
      { counters: { ...counters, [year]: next } },
      { merge: true },
    );

    const matter = getReservedMatter(data.matterKey);
    const decisionDeadlineAt = computeDecisionDeadline(now);
    const submitUpdate: DocData = {
      status: 'pending',
      requestNumber,
      submittedAt: now,
      decisionDeadlineAt,
      gateModeAtFiling: matter?.defaultGateMode ?? data.gateModeAtFiling,
      scheduleSection: matter?.scheduleSection ?? data.scheduleSection,
      matterLabel: matter?.label ?? data.matterLabel,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.update(ref, submitUpdate);

    const historyRef = ref.collection('history').doc();
    const submittedEntry = historyEntry(
      'submitted',
      actorUid,
      roleKey,
      'draft',
      'pending',
      requestNumber,
    );
    tx.set(historyRef, submittedEntry);
    // The post doc keeps submitUpdate's serverTimestamp sentinel for
    // updatedAt: the mirror serializer resolves it to the write
    // instant, the same value Firestore stores.
    mirrorPost = { ...data, ...submitUpdate };
    mirrorHistory = { id: historyRef.id as string, entry: submittedEntry };
    const auditRef = db.collection('audit_logs').doc();
    tx.set(
      auditRef,
      auditDocData('consent_submitted', actorUid, id, { requestNumber }),
    );

    return {
      requestNumber,
      decisionDeadlineAt,
      alreadySubmitted: false as const,
      isUrgent: data.isUrgent === true,
    };
  });

  if (!result.alreadySubmitted) {
    // Dual-write: mirror the committed post-submit doc + history entry.
    if (mirrorPost) await mirrorConsentSet(id, mirrorPost);
    if (mirrorHistory) {
      await mirrorConsentHistorySet(id, mirrorHistory.id, mirrorHistory.entry);
    }
    await notifySafely(
      FOUNDER_UID,
      {
        type: 'consent_submitted',
        title: result.isUrgent
          ? `Urgent Consent request ${result.requestNumber}`
          : `Consent request ${result.requestNumber}`,
        body: `A new Founder Consent request (${result.requestNumber}) awaits your decision. The 30-day clock is running.`,
        link: `/admin/consents/${id}`,
        metadata: { consentRequestId: id, requestNumber: result.requestNumber },
      },
      result.isUrgent ? 'P0' : 'P1',
    );
  }

  return {
    id,
    requestNumber: result.requestNumber,
    status: 'pending',
    decisionDeadlineAt:
      result.decisionDeadlineAt instanceof Date
        ? result.decisionDeadlineAt
        : computeDecisionDeadline(now),
  };
}

// ---------------------------------------------------------------------------
// Founder decision (all five actions)
// ---------------------------------------------------------------------------

export interface DecideBody {
  action:
    | 'consent_given'
    | 'consent_refused'
    | 'conditional_consent'
    | 'request_further_information'
    | 'waive';
  conditions?: string | null;
  consentedScope?: string | null;
  refusedScope?: string | null;
  decisionNote?: string | null;
  furtherInformationRequest?: string | null;
  waiverNote?: string | null;
}

export async function decideRequest(
  db: Firestore,
  id: string,
  actorUid: string,
  body: DecideBody,
  now: Date = new Date(),
): Promise<ConsentRequest> {
  if (actorUid !== FOUNDER_UID) throw notFounder();
  const { ref, data } = await loadRequest(db, id);
  const status = data.status as ConsentStatus;

  if (isDecidedStatus(status) || status === 'cancelled' || status === 'executed') {
    throw alreadyDecided();
  }

  const roleKey = await actorRoleKey(db, actorUid);
  const batch = db.batch();
  const historyRef = ref.collection('history').doc();
  let update: DocData;
  let toStatus: ConsentStatus;
  let notifyBody: string | null = null;
  // Dual-write capture (consents mirror program): whichever branch
  // runs records its history entry here; after the batch commits, the
  // post-decision doc + this entry are mirrored from memory.
  let historyData: DocData | null = null;

  switch (body.action) {
    case 'consent_given': {
      toStatus = 'consented';
      if (!canTransition(status, toStatus, 'founder')) {
        throw invalidTransition(status, toStatus);
      }
      update = decisionBlock(data, 'consent_given', actorUid, now);
      notifyBody = `Your Consent request ${data.requestNumber} was GIVEN.`;
      historyData = historyEntry('consent_given', actorUid, roleKey, status, toStatus);
      batch.set(historyRef, historyData);
      break;
    }
    case 'consent_refused': {
      toStatus = 'refused';
      if (!canTransition(status, toStatus, 'founder')) {
        throw invalidTransition(status, toStatus);
      }
      const note = body.decisionNote?.trim();
      if (!note) {
        throw new ConsentServiceError(
          'CONSENT_VALIDATION_FAILED',
          422,
          'A refusal must state its reason',
          { decisionNote: 'A decision note is required when refusing consent.' },
        );
      }
      const shapeError = validateDecisionShape({
        decision: 'consent_refused',
        consentedScope: body.consentedScope,
        refusedScope: body.refusedScope,
      });
      if (shapeError) {
        throw new ConsentServiceError(
          shapeError,
          422,
          'A refusal cannot carry a consented scope',
        );
      }
      update = {
        ...decisionBlock(data, 'consent_refused', actorUid, now),
        refusedScope: body.refusedScope?.trim() || null,
      };
      notifyBody = `Your Consent request ${data.requestNumber} was REFUSED. Reason: ${note}`;
      historyData = historyEntry('consent_refused', actorUid, roleKey, status, toStatus, note);
      batch.set(historyRef, historyData);
      break;
    }
    case 'conditional_consent': {
      toStatus = 'conditional';
      if (!canTransition(status, toStatus, 'founder')) {
        throw invalidTransition(status, toStatus);
      }
      const shapeError = validateDecisionShape({
        decision: 'conditional_consent',
        conditions: body.conditions,
        consentedScope: body.consentedScope,
        refusedScope: body.refusedScope,
      });
      if (shapeError) {
        throw new ConsentServiceError(
          shapeError,
          422,
          'Conditional consent requires conditions and/or a consented scope',
        );
      }
      update = {
        ...decisionBlock(data, 'conditional_consent', actorUid, now),
        conditions: body.conditions?.trim() || null,
        consentedScope: body.consentedScope?.trim() || null,
        refusedScope: body.refusedScope?.trim() || null,
      };
      notifyBody = `Your Consent request ${data.requestNumber} received CONDITIONAL consent. Conditions: ${body.conditions?.trim() || '(see consented scope on the record)'}`;
      historyData = historyEntry(
        'conditional_consent',
        actorUid,
        roleKey,
        status,
        toStatus,
        body.conditions?.trim() || null,
      );
      batch.set(historyRef, historyData);
      break;
    }
    case 'request_further_information': {
      toStatus = 'further_information_requested';
      if (!canTransition(status, toStatus, 'founder')) {
        throw invalidTransition(status, toStatus);
      }
      const requestText = body.furtherInformationRequest?.trim();
      if (!requestText) {
        throw new ConsentServiceError(
          'CONSENT_VALIDATION_FAILED',
          422,
          'State what further information is required',
          {
            furtherInformationRequest:
              'The information request text is required.',
          },
        );
      }
      update = {
        status: toStatus,
        furtherInformationRequest: requestText,
        updatedAt: FieldValue.serverTimestamp(),
      };
      notifyBody = `The Founder requested further information on your Consent request ${data.requestNumber}. The 30-day clock is suspended until you reply.`;
      historyData = historyEntry(
        'further_information_requested',
        actorUid,
        roleKey,
        status,
        toStatus,
        requestText,
      );
      batch.set(historyRef, historyData);
      break;
    }
    case 'waive': {
      toStatus = 'waived';
      if (!canTransition(status, toStatus, 'founder')) {
        throw invalidTransition(status, toStatus);
      }
      const waiverNote = body.waiverNote?.trim();
      if (!waiverNote) {
        throw new ConsentServiceError(
          'CONSENT_VALIDATION_FAILED',
          422,
          'A waiver must state its note',
          { waiverNote: 'A waiver note is required.' },
        );
      }
      // Waive is not a decision: the decision field stays null (spec A.4).
      update = {
        status: 'waived',
        waiverNote,
        decidedByUid: actorUid,
        decidedAtSort: now,
        founderSignatureMarker: `FOUNDER:${FOUNDER_UID}:${now.toISOString()}`,
        updatedAt: FieldValue.serverTimestamp(),
      };
      notifyBody = `Your Consent request ${data.requestNumber} was WAIVED (no Consent required). Note: ${waiverNote}`;
      historyData = historyEntry('waived', actorUid, roleKey, status, toStatus, waiverNote);
      batch.set(historyRef, historyData);
      break;
    }
    default:
      throw new ConsentServiceError(
        'CONSENT_VALIDATION_FAILED',
        422,
        'Unknown decision action',
        { action: 'Unknown decision action.' },
      );
  }

  batch.update(ref, update);
  await writeGovernanceAuditOrThrow(
    db,
    {
      action: 'consent_decided',
      actorUid,
      targetType: 'consent_request',
      targetId: id,
      details: { action: body.action, toStatus, requestNumber: data.requestNumber },
    },
    { batch },
  );
  await batch.commit();

  // Dual-write: mirror the in-memory post-decision doc + history entry.
  await mirrorConsentSet(id, { ...data, ...update });
  if (historyData) {
    await mirrorConsentHistorySet(id, historyRef.id as string, historyData);
  }

  if (notifyBody) {
    await notifySafely(
      data.requestedByUid,
      {
        type: 'consent_decision',
        title: `Consent request ${data.requestNumber}: ${toStatus.replace(/_/g, ' ')}`,
        body: notifyBody,
        link: `/admin/consents/${id}`,
        metadata: { consentRequestId: id, requestNumber: data.requestNumber },
      },
      'P1',
    );
  }

  return {
    id,
    ...data,
    ...update,
    status: toStatus,
  } as unknown as ConsentRequest;
}

function decisionBlock(
  _data: DocData,
  decision: 'consent_given' | 'consent_refused' | 'conditional_consent',
  actorUid: string,
  now: Date,
): DocData {
  const statusByDecision: Record<string, ConsentStatus> = {
    consent_given: 'consented',
    consent_refused: 'refused',
    conditional_consent: 'conditional',
  };
  return {
    status: statusByDecision[decision],
    decision,
    decisionDate: now,
    decidedByUid: actorUid,
    decidedAtSort: now,
    founderSignatureMarker: `FOUNDER:${FOUNDER_UID}:${now.toISOString()}`,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

// ---------------------------------------------------------------------------
// Founder-act auto-consent (Fix 1): when the Founder performs a gated act,
// the gate (consent-gate.ts founderActPass) records the consent the act
// was performed under, as if filed and decided in the same moment. This
// is the only writer of that record shape; it lives here so the
// "ONLY writer of consent_requests" property above holds.
// ---------------------------------------------------------------------------

/**
 * Subject comparison for the dedupe re-check: the SHARED
 * consentSubjectsMatch predicate (consent-subject.ts), the identical
 * function the gate's subjectMatches delegates to. consent-service
 * still must not import consent-gate (the gate imports this module;
 * that would cycle), so both layers import the predicate from the
 * leaf module instead. The previous local deep-equality check
 * (subjectRefEquals) diverged from the gate on the role_definition
 * permissions/scope pair and minted duplicate decided consents in
 * the concurrency window (Reviewer 2 defect F1, 2026-10-24); it is
 * deleted, not kept alongside — two predicates is what caused F1.
 */

/**
 * PARITY OBLIGATION (B1): the helpers below reproduce, locally, the
 * usability semantics consent-gate.ts applies in evaluateConsent and
 * in founderActPass Step B (its toDate / consentExpiryDate helpers and
 * its conditional predicate). consent-service must not import
 * consent-gate (the gate imports this module; that would cycle), and
 * no module this file already imports carries those helpers, so they
 * are copied here. Any change to the gate's expiry or conditional
 * semantics MUST be mirrored here, or the writer's dedupe re-check
 * will again diverge from the check it backs up.
 */
// Mirrors DEFAULT_VALIDITY_DAYS in governance-settings.ts: the value
// getConsentMatterSettings falls back to when no positive per-matter
// validity is configured.
const FOUNDER_ACT_DEFAULT_VALIDITY_DAYS = 90;

function founderActToDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof v.toDate === 'function') {
      const d = v.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
    const seconds = typeof v.seconds === 'number' ? v.seconds : v._seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000);
  }
  return null;
}

function founderActConsentExpiryDate(data: DocData, validityDays: number): Date | null {
  const bounds: number[] = [];
  const proposed = founderActToDate(data.proposedActDate);
  if (proposed) bounds.push(proposed.getTime() + 30 * 24 * 60 * 60 * 1000);
  const decided = founderActToDate(data.decidedAt);
  if (decided) bounds.push(decided.getTime() + validityDays * 24 * 60 * 60 * 1000);
  const explicit = founderActToDate(data.expiresAt);
  if (explicit) bounds.push(explicit.getTime());
  if (bounds.length === 0) return null;
  return new Date(Math.min(...bounds));
}

/**
 * The full usability predicate Step B / evaluateConsent apply, minus
 * the matter and subject checks (the dedupe query filters by matter
 * and the caller checks consentSubjectsMatch): status 'consented', or
 * 'conditional' satisfied by the Founder or its named verifier (never
 * by the requester unless they are one of those), not expired, and
 * not consumed. The conditional formulas are copied verbatim from
 * evaluateConsent in consent-gate.ts.
 */
function isReusableDecidedConsent(
  data: DocData,
  actorUid: string,
  validityDays: number,
  now: Date,
): boolean {
  if (data.status === 'conditional') {
    const satisfiedBy = data.conditionsSatisfiedBy ?? null;
    const byFounder = satisfiedBy === FOUNDER_UID;
    const byVerifier =
      satisfiedBy != null &&
      data.conditionsVerifierUid != null &&
      satisfiedBy === data.conditionsVerifierUid;
    // The requester can never satisfy their own conditions.
    const byRequester = satisfiedBy != null && satisfiedBy === actorUid && !byFounder && !byVerifier;
    if (data.conditionsSatisfied !== true || (!byFounder && !byVerifier) || byRequester) {
      return false;
    }
  } else if (data.status !== 'consented') {
    return false;
  }
  const expiry = founderActConsentExpiryDate(data, validityDays);
  if (expiry && now.getTime() > expiry.getTime()) return false;
  if (data.consumedAt != null) return false;
  return true;
}

export interface FounderActConsentInput {
  actorUid: string;
  matterKey: string;                                  // a GATE matter key (consent-gate-types.ts:5-9)
  subjectRef: Record<string, unknown>;                // the gate's ConsentSubjectRef, stored verbatim
  proposedAct: string;                                // computed by the gate (actSummary ?? canonical string)
  gateMode: 'hard' | 'record';                        // from getConsentMatterSettings
  now?: Date;
  /**
   * Consent validity window in days, for the dedupe re-check's expiry
   * test. The gate always passes settings.validityDays. Optional only
   * because existing direct callers/tests invoke this writer without
   * it; when absent (or not a positive number, mirroring how
   * getConsentMatterSettings sanitises its value) the settings
   * default of 90 days applies.
   */
  validityDays?: number;
}

export async function createFounderActConsent(
  db: Firestore, input: FounderActConsentInput,
): Promise<{ id: string; requestNumber: string; reused: boolean }> {
  // Defence-in-depth (Independent Security Reviewer 1, 2026-10-24):
  // this writer mints a decided consent carrying the founder signature
  // marker, so — exactly like decideRequest above — it refuses any
  // actor who is not the Founder UID itself, regardless of what the
  // caller (the gate) believed about the actor's stored role. UID
  // equality only; a planted roles/{uid}.role='founder_patron' write
  // (permitted by the live firestore.rules for canManageRoles holders)
  // buys nothing here either.
  if (input.actorUid !== FOUNDER_UID) throw notFounder();
  const now = input.now ?? new Date();
  const validityDays =
    typeof input.validityDays === 'number' && input.validityDays > 0
      ? input.validityDays
      : FOUNDER_ACT_DEFAULT_VALIDITY_DAYS;

  // Identity snapshots, exactly as createDraft takes them.
  const userSnap = await db.collection('users').doc(input.actorUid).get();
  const user = (userSnap?.data() ?? {}) as DocData;
  const requesterName =
    (typeof user.displayName === 'string' && user.displayName) ||
    (typeof user.name === 'string' && user.name) ||
    'Unknown';
  const requesterRoleKey = await actorRoleKey(db, input.actorUid);
  const requesterChapterId =
    typeof user.chapterId === 'string' ? user.chapterId : null;

  const matter = getReservedMatter(input.matterKey);
  const ref = db.collection(COLLECTION).doc();
  const counterRef = db.collection('settings').doc('consent_counter');

  // Dual-write captures (consents mirror program): set only on the
  // mint path inside the transaction; the dedupe-reuse return writes
  // nothing and leaves them null. See submitRequest for the retry
  // semantics of captures taken inside a transaction callback.
  let mirrorPost: DocData | null = null;
  // The asserted initializer keeps the declared union as the flow
  // type: the capture is assigned inside the transaction closure,
  // which TS control-flow cannot see (a plain null initializer would
  // narrow every post-transaction read to never).
  let mirrorHistory: { id: string; entry: DocData } | null = null as { id: string; entry: DocData } | null;

  const result = await db.runTransaction(async (tx: any) => {
    // Dedupe re-check (authoritative): an existing decided consent for
    // the same subject means no new record is written - but ONLY if it
    // is actually usable. The scan takes the first (newest-first)
    // subject-matching candidate (shared consentSubjectsMatch — the
    // gate's own predicate, F1) that passes the full usability predicate
    // (isReusableDecidedConsent, mirroring Step B / evaluateConsent);
    // an unusable match does not stop the scan and is never returned
    // as reused - the writer falls through and mints a fresh record.
    const candidates = await tx.get(
      db.collection(COLLECTION)
        .where('matterKey', '==', input.matterKey)
        .where('status', 'in', ['consented', 'conditional'])
        .orderBy('decidedAtSort', 'desc')
        .limit(25),
    );
    const candidateDocs = (candidates?.docs ?? []) as Array<any>;
    for (const doc of candidateDocs) {
      const data = doc.data() as DocData;
      if (
        !consentSubjectsMatch(
          data.subjectRef,
          input.subjectRef as unknown as ConsentSubjectRef,
        )
      )
        continue;
      if (!isReusableDecidedConsent(data, input.actorUid, validityDays, now)) continue;
      return {
        id: doc.id as string,
        requestNumber: data.requestNumber as string,
        reused: true,
      };
    }

    // Allocate the request number exactly as submitRequest does.
    const counterSnap = await tx.get(counterRef);
    const counters: Record<string, number> =
      (counterSnap?.exists ? (counterSnap.data()?.counters ?? {}) : {}) ?? {};
    const year = karachiYear(now);
    const next = (typeof counters[year] === 'number' ? counters[year] : 0) + 1;
    const requestNumber = `FC-${year}-${String(next).padStart(4, '0')}`;
    tx.set(
      counterRef,
      { counters: { ...counters, [year]: next } },
      { merge: true },
    );

    const data: DocData = {
      requestNumber,
      status: 'consented',
      requestedByUid: input.actorUid,
      requesterName,
      requesterRoleKey,
      requesterChapterId,
      matterKey: input.matterKey,
      scheduleSection: matter?.scheduleSection ?? '',
      matterLabel: matter?.label ?? '',
      gateModeAtFiling: input.gateMode === 'hard' ? 'hard_block' : 'record_only',
      proposedAct: input.proposedAct,
      proposedActDate: karachiDateStr(now),
      amountPkr: null,
      relatedPartyName: null,
      relatedPartyInterest: null,
      materialFacts: input.proposedAct,
      attachments: [] as ConsentAttachment[],
      isUrgent: false,
      urgencyReason: null,
      decision: 'consent_given',
      conditions: null,
      consentedScope: null,
      refusedScope: null,
      decisionDate: now,
      decidedAt: now,
      decidedByUid: input.actorUid,
      decidedAtSort: now,
      founderSignatureMarker: `FOUNDER:${input.actorUid}:${now.toISOString()}`,
      furtherInformationRequest: null,
      furtherInformationResponse: null,
      informationReceivedAt: null,
      submittedAt: now,
      decisionDeadlineAt: computeDecisionDeadline(now),
      deadlineWarningSentAt: null,
      deemedWithheldAt: null,
      waiverNote: null,
      executedAt: null,
      executionNote: null,
      cancelledAt: null,
      cancellationReason: null,
      subjectRef: input.subjectRef,
      decidedVia: 'founder-act',
      consumedAt: null,
      consumedBy: null,
      consumedActRef: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(ref, data);

    const historyRef = ref.collection('history').doc();
    const founderActEntry = historyEntry(
      'consent_given',
      input.actorUid,
      requesterRoleKey,
      null,
      'consented',
      'decidedVia:founder-act',
    );
    tx.set(historyRef, founderActEntry);
    mirrorPost = data;
    mirrorHistory = { id: historyRef.id as string, entry: founderActEntry };
    const auditRef = db.collection('audit_logs').doc();
    tx.set(
      auditRef,
      auditDocData('consent_decided', input.actorUid, ref.id, {
        action: 'consent_given',
        toStatus: 'consented',
        requestNumber,
        decidedVia: 'founder-act',
        matterKey: input.matterKey,
        subjectRef: input.subjectRef,
      }),
    );

    return { id: ref.id as string, requestNumber, reused: false };
  });

  // Dual-write: mirror the minted record + its history entry (the
  // dedupe-reuse outcome wrote nothing and mirrors nothing).
  if (!result.reused && mirrorPost) {
    await mirrorConsentSet(result.id, mirrorPost);
    if (mirrorHistory) {
      await mirrorConsentHistorySet(result.id, mirrorHistory.id, mirrorHistory.entry);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Further information reply (restarts the clock, Schedule s.4.4)
// ---------------------------------------------------------------------------

export async function supplyInformation(
  db: Firestore,
  id: string,
  actorUid: string,
  response: string,
  now: Date = new Date(),
  extraAttachments?: ConsentAttachment[],
): Promise<ConsentRequest> {
  const { ref, data } = await loadRequest(db, id);
  if (data.requestedByUid !== actorUid) throw forbidden();
  if (data.status !== 'further_information_requested') {
    throw invalidTransition(data.status, 'pending');
  }
  const text = typeof response === 'string' ? response.trim() : '';
  if (!text) {
    throw new ConsentServiceError(
      'CONSENT_VALIDATION_FAILED',
      422,
      'The information response is required',
      { response: 'The information response is required.' },
    );
  }
  const roleKey = await actorRoleKey(db, actorUid);
  const decisionDeadlineAt = computeDecisionDeadline(now);
  const attachments = Array.isArray(data.attachments) ? [...data.attachments] : [];
  if (extraAttachments?.length) {
    // The requester may ADD attachments while supplying information (A.8).
    attachments.push(...extraAttachments);
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new ConsentServiceError(
        'CONSENT_VALIDATION_FAILED',
        422,
        'Validation failed',
        { attachments: `At most ${MAX_ATTACHMENTS} attachments are allowed.` },
      );
    }
  }
  const update: DocData = {
    status: 'pending',
    furtherInformationResponse: text,
    informationReceivedAt: now,
    decisionDeadlineAt,
    deadlineWarningSentAt: null,
    attachments,
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.update(ref, update);
  const infoHistoryRef = ref.collection('history').doc();
  const infoHistoryEntry = historyEntry(
    'information_supplied',
    actorUid,
    roleKey,
    'further_information_requested',
    'pending',
  );
  batch.set(infoHistoryRef, infoHistoryEntry);
  await writeGovernanceAuditOrThrow(
    db,
    {
      action: 'consent_information_supplied',
      actorUid,
      targetType: 'consent_request',
      targetId: id,
      details: { requestNumber: data.requestNumber },
    },
    { batch },
  );
  await batch.commit();

  // Dual-write: mirror the in-memory post-update doc + history entry.
  await mirrorConsentSet(id, { ...data, ...update });
  await mirrorConsentHistorySet(id, infoHistoryRef.id as string, infoHistoryEntry);

  await notifySafely(
    FOUNDER_UID,
    {
      type: 'consent_information_supplied',
      title: `Information supplied: ${data.requestNumber}`,
      body: `Further information was supplied for Consent request ${data.requestNumber}. A fresh 30-day clock is running.`,
      link: `/admin/consents/${id}`,
      metadata: { consentRequestId: id, requestNumber: data.requestNumber },
    },
    data.isUrgent === true ? 'P0' : 'P1',
  );

  return { id, ...data, ...update } as unknown as ConsentRequest;
}

// ---------------------------------------------------------------------------
// Execute / cancel
// ---------------------------------------------------------------------------

export async function executeRequest(
  db: Firestore,
  id: string,
  actorUid: string,
  executionNote?: string | null,
  now: Date = new Date(),
): Promise<ConsentRequest> {
  const { ref, data } = await loadRequest(db, id);
  if (data.requestedByUid !== actorUid) throw forbidden();
  if (!canTransition(data.status, 'executed', 'requester')) {
    if (isDecidedStatus(data.status)) throw alreadyDecided();
    throw invalidTransition(data.status, 'executed');
  }
  const roleKey = await actorRoleKey(db, actorUid);
  const update: DocData = {
    status: 'executed',
    executedAt: now,
    executionNote: executionNote?.trim() || null,
    decidedAtSort: now,
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.update(ref, update);
  const execHistoryRef = ref.collection('history').doc();
  const execHistoryEntry = historyEntry(
    'executed',
    actorUid,
    roleKey,
    data.status,
    'executed',
  );
  batch.set(execHistoryRef, execHistoryEntry);
  await writeGovernanceAuditOrThrow(
    db,
    {
      action: 'consent_executed',
      actorUid,
      targetType: 'consent_request',
      targetId: id,
      details: { requestNumber: data.requestNumber },
    },
    { batch },
  );
  await batch.commit();

  // Dual-write: mirror the in-memory post-update doc + history entry.
  await mirrorConsentSet(id, { ...data, ...update });
  await mirrorConsentHistorySet(id, execHistoryRef.id as string, execHistoryEntry);

  await notifySafely(
    FOUNDER_UID,
    {
      type: 'consent_executed',
      title: `Consent executed: ${data.requestNumber}`,
      body: `Consent request ${data.requestNumber} was marked executed by the requester.`,
      link: `/admin/consents/${id}`,
      metadata: { consentRequestId: id, requestNumber: data.requestNumber },
    },
    'P2',
  );
  return { id, ...data, ...update } as unknown as ConsentRequest;
}

export async function cancelRequest(
  db: Firestore,
  id: string,
  actorUid: string,
  reason?: string | null,
  now: Date = new Date(),
): Promise<ConsentRequest> {
  const { ref, data } = await loadRequest(db, id);
  if (data.requestedByUid !== actorUid) throw forbidden();
  if (!canTransition(data.status, 'cancelled', 'requester')) {
    if (isDecidedStatus(data.status) || data.status === 'executed') {
      throw alreadyDecided();
    }
    throw invalidTransition(data.status, 'cancelled');
  }
  const wasSubmitted = data.status !== 'draft';
  const roleKey = await actorRoleKey(db, actorUid);
  const update: DocData = {
    status: 'cancelled',
    cancelledAt: now,
    cancellationReason: reason?.trim() || null,
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.update(ref, update);
  const cancelHistoryRef = ref.collection('history').doc();
  const cancelHistoryEntry = historyEntry(
    'cancelled',
    actorUid,
    roleKey,
    data.status,
    'cancelled',
  );
  batch.set(cancelHistoryRef, cancelHistoryEntry);
  // Audit only when cancelling a submitted request (spec A.6).
  if (wasSubmitted) {
    await writeGovernanceAuditOrThrow(
      db,
      {
        action: 'consent_cancelled',
        actorUid,
        targetType: 'consent_request',
        targetId: id,
        details: { requestNumber: data.requestNumber },
      },
      { batch },
    );
  }
  await batch.commit();

  // Dual-write: mirror the in-memory post-update doc + history entry.
  await mirrorConsentSet(id, { ...data, ...update });
  await mirrorConsentHistorySet(id, cancelHistoryRef.id as string, cancelHistoryEntry);

  return { id, ...data, ...update } as unknown as ConsentRequest;
}

// ---------------------------------------------------------------------------
// Deemed withheld (cron entry point, Schedule s.4.4)
// ---------------------------------------------------------------------------

export async function stampDeemedWithheld(
  db: Firestore,
  id: string,
  now: Date = new Date(),
): Promise<{ stamped: boolean; reason?: string }> {
  const ref = db.collection(COLLECTION).doc(id);
  // Dual-write captures (consents mirror program): set only on the
  // stamped path inside the transaction; see submitRequest for the
  // retry semantics of transaction-callback captures.
  let mirrorPost: DocData | null = null;
  // The asserted initializer keeps the declared union as the flow
  // type: the capture is assigned inside the transaction closure,
  // which TS control-flow cannot see (a plain null initializer would
  // narrow every post-transaction read to never).
  let mirrorHistory: { id: string; entry: DocData } | null = null as { id: string; entry: DocData } | null;
  const outcome = await db.runTransaction(async (tx: any) => {
    const snap = await tx.get(ref);
    if (!snap || !snap.exists) return { stamped: false, reason: 'not_found' };
    const data = snap.data() as DocData;
    // A decision in flight wins: anything no longer pending is skipped.
    if (data.status !== 'pending') {
      return { stamped: false, reason: 'not_pending' };
    }
    const deadline = data.decisionDeadlineAt;
    // Supabase migration (PLAN_G2 section 3): adapter-written docs
    // store decisionDeadlineAt as an ISO string; without the string
    // branch such a request reads as 'not_due' forever and is never
    // stamped — a silent failure of the Reserved Powers clock.
    // Firestore-stored deadlines are Timestamps and never reach it.
    const deadlineMs =
      deadline instanceof Date
        ? deadline.getTime()
        : typeof deadline?.toDate === 'function'
          ? deadline.toDate().getTime()
          : typeof deadline === 'string'
            ? (() => {
                const ms = Date.parse(deadline);
                return Number.isNaN(ms) ? null : ms;
              })()
            : null;
    if (deadlineMs === null || deadlineMs >= now.getTime()) {
      return { stamped: false, reason: 'not_due' };
    }
    const stampUpdate: DocData = {
      status: 'deemed_withheld',
      deemedWithheldAt: now,
      decidedByUid: 'system_cron',
      decidedAtSort: now,
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.update(ref, stampUpdate);
    const stampHistoryRef = ref.collection('history').doc();
    const stampEntry = historyEntry(
      'deemed_withheld',
      'system_cron',
      'system',
      'pending',
      'deemed_withheld',
    );
    tx.set(stampHistoryRef, stampEntry);
    mirrorPost = { ...data, ...stampUpdate };
    mirrorHistory = { id: stampHistoryRef.id as string, entry: stampEntry };
    tx.set(
      db.collection('audit_logs').doc(),
      auditDocData('consent_deemed_withheld', 'system_cron', id, {
        requestNumber: data.requestNumber,
      }),
    );
    return { stamped: true };
  });

  // Dual-write: mirror the stamped doc + history entry.
  if (outcome.stamped && mirrorPost) {
    await mirrorConsentSet(id, mirrorPost);
    if (mirrorHistory) {
      await mirrorConsentHistorySet(id, mirrorHistory.id, mirrorHistory.entry);
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Inbox / register / decided-consent lookup
// ---------------------------------------------------------------------------

/**
 * Inbox arm bound (census G4 fix): the two inbox queries were the
 * consent surface's only UNBOUNDED reads. 200 per arm is generous
 * against today's ~10 pending + ~0–5 information-requested, and the
 * bound applies identically to the seam arm and the Firestore
 * fallback, so flag state never changes how much an inbox load can
 * cost.
 */
export const CONSENT_INBOX_LIMIT = 200;

export async function listInbox(db: Firestore): Promise<{
  awaitingDecision: ConsentRequest[];
  awaitingInformation: ConsentRequest[];
}> {
  // Seam (consents mirror program): mirror-first when enabled, same
  // bounds and same urgent-first in-memory ordering; Firestore only
  // on seam-unavailable or adapter error.
  try {
    const pendingVia = await listConsentsViaSeam({
      where: [['status', '==', 'pending']],
      orderBy: { field: 'decisionDeadlineAt', direction: 'asc' },
      limit: CONSENT_INBOX_LIMIT,
    });
    const infoVia = await listConsentsViaSeam({
      where: [['status', '==', 'further_information_requested']],
      orderBy: { field: 'updatedAt', direction: 'desc' },
      limit: CONSENT_INBOX_LIMIT,
    });
    if (pendingVia && infoVia) {
      const awaitingDecision = pendingVia as unknown as ConsentRequest[];
      // Urgent first, applied in memory over the deadline order (spec A.7 Q1).
      awaitingDecision.sort((a: any, b: any) =>
        a.isUrgent === b.isUrgent ? 0 : a.isUrgent ? -1 : 1,
      );
      return {
        awaitingDecision,
        awaitingInformation: infoVia as unknown as ConsentRequest[],
      };
    }
  } catch (err) {
    console.warn('[consent-service] seam listInbox failed; falling back to Firestore:', err);
  }
  const pendingSnap = await db
    .collection(COLLECTION)
    .where('status', '==', 'pending')
    .orderBy('decisionDeadlineAt', 'asc')
    .limit(CONSENT_INBOX_LIMIT)
    .get();
  const awaitingDecision = pendingSnap.docs.map(
    (doc: any) => ({ id: doc.id, ...doc.data() }) as unknown as ConsentRequest,
  );
  // Urgent first, applied in memory over the deadline order (spec A.7 Q1).
  awaitingDecision.sort((a: any, b: any) =>
    a.isUrgent === b.isUrgent ? 0 : a.isUrgent ? -1 : 1,
  );

  const infoSnap = await db
    .collection(COLLECTION)
    .where('status', '==', 'further_information_requested')
    .orderBy('updatedAt', 'desc')
    .limit(CONSENT_INBOX_LIMIT)
    .get();
  const awaitingInformation = infoSnap.docs.map(
    (doc: any) => ({ id: doc.id, ...doc.data() }) as unknown as ConsentRequest,
  );
  return { awaitingDecision, awaitingInformation };
}

export interface RegisterFilters {
  status?: string;
  matterKey?: string;
  from?: Date;
  to?: Date;
  q?: string;
  limit?: number;
}

export async function listRegister(
  db: Firestore,
  filters: RegisterFilters = {},
): Promise<ConsentRequest[]> {
  // Hard filter: the register NEVER returns non-decided rows, whatever
  // the caller passes (spec A.7).
  if (filters.status && !REGISTER_STATUSES.includes(filters.status as ConsentStatus)) {
    return [];
  }
  const registerLimit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  // Seam (consents mirror program): the same filter set through the
  // adapter when enabled (decidedAtSort range clauses are finished
  // client-side by the adapter in true chronological order);
  // Firestore only on seam-unavailable or adapter error. The q filter
  // stays in memory on both arms, as before.
  try {
    const where: Array<[string, string, any]> = [];
    if (filters.status) {
      where.push(['status', '==', filters.status]);
    } else {
      where.push(['status', 'in', [...REGISTER_STATUSES]]);
    }
    if (filters.matterKey) where.push(['matterKey', '==', filters.matterKey]);
    if (filters.from) where.push(['decidedAtSort', '>=', filters.from]);
    if (filters.to) where.push(['decidedAtSort', '<=', filters.to]);
    const via = await listConsentsViaSeam({
      where,
      orderBy: { field: 'decidedAtSort', direction: 'desc' },
      limit: registerLimit,
    });
    if (via) {
      let rows = via as unknown as ConsentRequest[];
      if (filters.q) {
        const needle = filters.q.toLowerCase();
        rows = rows.filter((row: any) =>
          [row.requestNumber, row.requesterName, row.proposedAct]
            .filter((v) => typeof v === 'string')
            .some((v: string) => v.toLowerCase().includes(needle)),
        );
      }
      return rows;
    }
  } catch (err) {
    console.warn('[consent-service] seam listRegister failed; falling back to Firestore:', err);
  }
  let query: any = db.collection(COLLECTION);
  if (filters.status) {
    query = query.where('status', '==', filters.status);
  } else {
    query = query.where('status', 'in', [...REGISTER_STATUSES]);
  }
  if (filters.matterKey) {
    query = query.where('matterKey', '==', filters.matterKey);
  }
  if (filters.from) query = query.where('decidedAtSort', '>=', filters.from);
  if (filters.to) query = query.where('decidedAtSort', '<=', filters.to);
  query = query.orderBy('decidedAtSort', 'desc').limit(registerLimit);
  const snap = await query.get();
  let rows = snap.docs.map(
    (doc: any) => ({ id: doc.id, ...doc.data() }) as unknown as ConsentRequest,
  );
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    rows = rows.filter((row: any) =>
      [row.requestNumber, row.requesterName, row.proposedAct]
        .filter((v) => typeof v === 'string')
        .some((v: string) => v.toLowerCase().includes(needle)),
    );
  }
  return rows;
}

// The lookup Workstreams B and C consume (spec A.7): the latest decided
// consent (consented / conditional / executed) for a matter, or null.
export async function getDecidedConsent(
  db: Firestore,
  input: { matterKey: string; requestId?: string },
): Promise<ConsentRequest | null> {
  const decidedStatuses = ['consented', 'conditional', 'executed'];
  if (input.requestId) {
    // Seam (consents mirror program): mirror-first; a trusted
    // Firestore hit heals the mirror row.
    try {
      const via = await getConsentViaSeam(input.requestId);
      if (via) {
        if (via.matterKey !== input.matterKey) return null;
        if (!decidedStatuses.includes(via.status)) return null;
        return via as unknown as ConsentRequest;
      }
    } catch (err) {
      console.warn('[consent-service] seam getDecidedConsent failed; falling back to Firestore:', err);
    }
    const snap = await db.collection(COLLECTION).doc(input.requestId).get();
    if (!snap?.exists) return null;
    const data = snap.data() as DocData;
    if (data.matterKey !== input.matterKey) return null;
    if (!decidedStatuses.includes(data.status)) return null;
    if (consentsSupaEnabled()) {
      await mirrorConsentSet(input.requestId, data);
    }
    return { id: snap.id, ...data } as unknown as ConsentRequest;
  }
  // Seam: latest decided consent for the matter, mirror-first.
  try {
    const via = await listConsentsViaSeam({
      where: [
        ['matterKey', '==', input.matterKey],
        ['status', 'in', decidedStatuses],
      ],
      orderBy: { field: 'decidedAtSort', direction: 'desc' },
      limit: 1,
    });
    if (via) {
      return via.length
        ? (via[0] as unknown as ConsentRequest)
        : null;
    }
  } catch (err) {
    console.warn('[consent-service] seam getDecidedConsent list failed; falling back to Firestore:', err);
  }
  const snap = await db
    .collection(COLLECTION)
    .where('matterKey', '==', input.matterKey)
    .where('status', 'in', decidedStatuses)
    .orderBy('decidedAtSort', 'desc')
    .limit(1)
    .get();
  if (!snap || snap.empty || !snap.docs?.length) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() } as unknown as ConsentRequest;
}

// ---------------------------------------------------------------------------
// Register CSV export (spec A.7 columns)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function fmtDate(value: any): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'string') return value;
  return '';
}

export const REGISTER_CSV_COLUMNS = [
  'Request number',
  'Date of request',
  'Requesting person',
  'Role key',
  'Reserved Matter (section)',
  'Matter',
  'Proposed Act',
  'Proposed date',
  'Amount PKR',
  'Related Party',
  'Interest',
  'Decision',
  'Conditions',
  'Consented scope',
  'Refused scope',
  'Date of decision',
  'Decided by',
  'Status',
  'Executed at',
];

export function toRegisterCsv(rows: ConsentRequest[]): string {
  const lines: string[] = [REGISTER_CSV_COLUMNS.join(',')];
  for (const row of rows as any[]) {
    const cells = [
      row.requestNumber ?? '',
      fmtDate(row.submittedAt),
      row.requesterName ?? '',
      row.requesterRoleKey ?? '',
      row.scheduleSection ?? '',
      row.matterLabel ?? '',
      row.proposedAct ?? '',
      row.proposedActDate ?? '',
      row.amountPkr === null || row.amountPkr === undefined
        ? ''
        : String(row.amountPkr),
      row.relatedPartyName ?? '',
      row.relatedPartyInterest ?? '',
      row.decision ?? '',
      row.conditions ?? '',
      row.consentedScope ?? '',
      row.refusedScope ?? '',
      fmtDate(row.decisionDate),
      row.decidedByUid ?? '',
      row.status ?? '',
      fmtDate(row.executedAt),
    ];
    lines.push(cells.map((c) => csvEscape(String(c))).join(','));
  }
  return lines.join('\n');
}
