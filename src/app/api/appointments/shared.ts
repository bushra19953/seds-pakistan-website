/**
 * Shared helpers for the appointment instrument routes (Workstream G,
 * spec G.5.1). Co-located module, not a route.
 *
 * Gate (G.6.1, Q-G1 default): canManagePositions via hasServerPermission,
 * OR the General Secretary role, OR Founder. Server-side in every
 * route; never by hiding buttons.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import { admin, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  hasServerPermissionForUser,
  resolveUserRole,
} from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import { notificationService } from '@/lib/server/notification-service';
import {
  LETTER_TEMPLATE_VERSION,
  MisconfiguredError,
  computeInstrumentContentHash,
  generateInstrumentCode,
  hashPayloadFromSnapshot,
  requireInstrumentSalt,
} from '@/lib/appointments/hash';
import {
  lifecycleStateProvider,
  registerRecordProvider,
  taxonomyProvider,
} from '@/lib/appointments/register-adapter';
import { buildLetterSnapshot } from '@/lib/appointment-letter-adapter';
import type {
  AppointmentInstrument,
  RegisterRecord,
  RoleTaxonomyEntry,
} from '@/types/appointment-instrument';

export const INSTRUMENTS_COLLECTION = 'appointment_instruments';
export const AUDIT_LOGS_COLLECTION = 'audit_logs';

/**
 * ADAPTER (D-G4): the canonical General Secretary role key belongs to
 * the Phase 1 taxonomy. Until it lands, these tokens mark the GS gate
 * branch; the primary gate is canManagePositions.
 */
const GENERAL_SECRETARY_ROLE_TOKENS = new Set([
  'general_secretary',
  'national_general_secretary',
]);

export function baseUrlFromRequest(request: NextRequest): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    new URL(request.url).origin
  );
}

export function verificationUrlFor(code: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/verify-appointment/${code}`;
}

export type GateResult =
  | { ok: true; db: Firestore; uid: string; role: string | null }
  | { ok: false; response: NextResponse };

async function authenticate(request: NextRequest) {
  const db = getDb();
  if (!db) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: 'Database not initialized' },
        { status: 500 },
      ),
    };
  }
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return {
    ok: true as const,
    db: db as unknown as Firestore,
    uid: auth.user.userId,
  };
}

/** Any signed-in caller (appointee routes resolve ownership per route). */
export async function requireAuthenticated(
  request: NextRequest,
): Promise<GateResult> {
  const authn = await authenticate(request);
  if (!authn.ok) return authn;
  const role = await resolveUserRole(authn.db, authn.uid);
  return { ok: true, db: authn.db, uid: authn.uid, role };
}

/** Officer gate for issue / check / reissue / admin list (G.6.1). */
export async function requireAppointmentsAdmin(
  request: NextRequest,
): Promise<GateResult> {
  const authn = await authenticate(request);
  if (!authn.ok) return authn;
  const { db, uid } = authn;
  const role = await resolveUserRole(db, uid);
  const allowed =
    (await hasServerPermissionForUser(db, uid, 'canManagePositions')) ||
    (role !== null && GENERAL_SECRETARY_ROLE_TOKENS.has(role)) ||
    isFounder(uid);
  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }
  return { ok: true, db, uid, role };
}

/** Download gate: appointee, officer, or Founder (G.5.1 letter-pdf). */
export async function canAccessInstrument(
  db: Firestore,
  uid: string,
  instrument: AppointmentInstrument,
): Promise<boolean> {
  if (instrument.appointeeUid === uid) return true;
  if (isFounder(uid)) return true;
  const role = await resolveUserRole(db, uid);
  if (role !== null && GENERAL_SECRETARY_ROLE_TOKENS.has(role)) return true;
  return hasServerPermissionForUser(db, uid, 'canManagePositions');
}

/** Timestamp-like -> epoch ms; 0 when unparseable. */
export function tsToMs(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const ms = new Date(val).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'object') {
    const obj = val as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof obj.toMillis === 'function') {
      try {
        return obj.toMillis();
      } catch {
        return 0;
      }
    }
    if (typeof obj.toDate === 'function') {
      try {
        return obj.toDate().getTime();
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

export function tsToIso(val: unknown): string | null {
  const ms = tsToMs(val);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

export async function getInstrument(
  db: Firestore,
  instrumentId: string,
): Promise<AppointmentInstrument | null> {
  const snap = await db.collection(INSTRUMENTS_COLLECTION).doc(instrumentId).get();
  if (!snap.exists) return null;
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return {
    ...(data as unknown as AppointmentInstrument),
    id: instrumentId,
  };
}

/** All instruments for a register record, newest first. */
export async function findInstrumentsByRoleHistoryId(
  db: Firestore,
  roleHistoryId: string,
): Promise<AppointmentInstrument[]> {
  const snap = await db
    .collection(INSTRUMENTS_COLLECTION)
    .where('roleHistoryId', '==', roleHistoryId)
    .get();
  return snap.docs
    .map((d) => ({
      ...((d.data() ?? {}) as unknown as AppointmentInstrument),
      id: d.id,
    }))
    .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
}

/** Audit write in the repo's server pattern (cf. intake writeIntakeAudit). */
export async function writeAppointmentAudit(
  db: Firestore,
  entry: {
    action: string;
    actorUid: string;
    targetUidOrResource: string;
    payload?: unknown;
  },
  batch?: ReturnType<Firestore['batch']>,
): Promise<void> {
  const ref = db.collection(AUDIT_LOGS_COLLECTION).doc();
  const data = {
    action: entry.action,
    actorUid: entry.actorUid,
    targetUidOrResource: entry.targetUidOrResource,
    payload: entry.payload ?? null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (batch) {
    batch.set(ref, data);
  } else {
    await ref.set(data);
  }
}

/** Fire-and-forget notification; delivery must never fail an action. */
export function notify(
  userId: string,
  payload: { type: string; title: string; body: string; link?: string },
): void {
  try {
    void Promise.resolve(notificationService.send(userId, payload)).catch(
      () => undefined,
    );
  } catch {
    // Notification spine unavailable; the governance action stands.
  }
}

export interface BlockedIssue {
  status: number;
  body: { error_code: string; reason: string };
}

function block(error_code: string, reason: string, status = 422): BlockedIssue {
  return { status, body: { error_code, reason } };
}

const BACKDATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Load + validate everything letter issue needs (G.4.1 step 2). Blocks
 * name the missing field; provenance is never invented. Shared by the
 * issue route (create + preview) and reissue.
 */
export async function loadIssueContext(
  db: Firestore,
  roleHistoryId: string,
): Promise<
  | {
      ok: true;
      record: RegisterRecord;
      taxonomy: RoleTaxonomyEntry;
      appointeeDisplayName: string;
    }
  | { ok: false; blocked: BlockedIssue }
> {
  const record = await registerRecordProvider.getRegisterRecord(db, roleHistoryId);
  if (!record) {
    return {
      ok: false,
      blocked: block('register_record_not_found', `No register record for ${roleHistoryId}.`, 404),
    };
  }
  if (!record.appointeeUid) {
    return { ok: false, blocked: block('missing_provenance', 'Register record is missing appointedByUid provenance: the appointee uid (appointeeUid) is not recorded.') };
  }
  if (!record.appointedByUid) {
    return { ok: false, blocked: block('missing_provenance', 'Register record is missing provenance field: appointedByUid.') };
  }
  if (!record.appointedByDisplayName) {
    return { ok: false, blocked: block('missing_provenance', 'Register record is missing provenance field: appointedByDisplayName.') };
  }
  if (!record.appointedAtMs) {
    return { ok: false, blocked: block('missing_provenance', 'Register record is missing provenance field: appointedAt.') };
  }
  const appointedByOffice =
    record.appointedByOffice ?? null;

  const taxonomy = await taxonomyProvider.getRoleTaxonomy(db, record.roleKey);
  if (!taxonomy) {
    return {
      ok: false,
      blocked: block('role_not_in_taxonomy', `Role key ${record.roleKey || '(empty)'} is not in the role taxonomy (field: roleKey).`),
    };
  }
  if (!appointedByOffice && !taxonomy.appointedByOffice) {
    return { ok: false, blocked: block('missing_provenance', 'Missing provenance field: appointedByOffice (neither the register record nor the taxonomy names the appointing office).') };
  }
  const authorityReference = record.authorityReference ?? taxonomy.authorityReference;
  if (!authorityReference) {
    return { ok: false, blocked: block('missing_provenance', 'Missing provenance field: authorityReference (neither the register record nor the taxonomy carries the governance citation).') };
  }

  // Appointee must exist; display name falls back to the user doc.
  const userSnap = await db.collection('users').doc(record.appointeeUid).get();
  if (!userSnap.exists) {
    return { ok: false, blocked: block('appointee_not_found', `Appointee user doc missing for uid ${record.appointeeUid} (field: appointeeUid).`) };
  }
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const appointeeDisplayName =
    record.appointeeDisplayName ??
    (typeof userData.displayName === 'string' ? userData.displayName : null) ??
    (typeof userData.name === 'string' ? userData.name : null);
  if (!appointeeDisplayName) {
    return { ok: false, blocked: block('missing_provenance', 'Missing provenance field: appointeeDisplayName (register record and user doc both lack a display name).') };
  }

  // Backdate discipline (G.3.1/G.4.1): effectiveFrom more than 24h
  // before appointedAt requires the reason recorded in the register.
  if (
    record.appointedAtMs - record.effectiveFromMs > BACKDATE_TOLERANCE_MS &&
    !record.backdateReason
  ) {
    return { ok: false, blocked: block('backdate_reason_required', 'effectiveFrom precedes appointedAt by more than 24 hours and the register record carries no backdateReason. Record the reason in the register first (field: backdateReason).') };
  }

  return {
    ok: true,
    record: {
      ...record,
      appointedByOffice: appointedByOffice ?? taxonomy.appointedByOffice,
      authorityReference,
    },
    taxonomy,
    appointeeDisplayName,
  };
}

/**
 * Build the instrument document for issue (G.4.1 step 4), without
 * writing it. Throws MisconfiguredError when the salt env is unset.
 */
export async function buildInstrumentDoc(
  db: Firestore,
  actorUid: string,
  ctx: {
    record: RegisterRecord;
    taxonomy: RoleTaxonomyEntry;
    appointeeDisplayName: string;
  },
  opts: { supersedesInstrumentId?: string | null } = {},
): Promise<{
  instrumentId: string;
  data: Record<string, unknown>;
  verificationCode: string;
  contentHash: string;
}> {
  requireInstrumentSalt();
  const { record, taxonomy } = ctx;

  // Verification code, unique across instruments (checked here; the
  // instruments queue is small and issue is a human-paced admin act).
  let verificationCode = generateInstrumentCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await db
      .collection(INSTRUMENTS_COLLECTION)
      .where('letter.verificationCode', '==', verificationCode)
      .limit(1)
      .get();
    if (clash.empty) break;
    verificationCode = generateInstrumentCode();
  }

  const instrumentRef = db.collection(INSTRUMENTS_COLLECTION).doc();
  const instrumentId = instrumentRef.id;
  const nowMs = Date.now();
  const ts = (ms: number) => admin.firestore.Timestamp.fromMillis(ms);

  const snapshot = buildLetterSnapshot({
    instrumentId,
    verificationCode,
    record,
    taxonomy,
    appointeeDisplayName: ctx.appointeeDisplayName,
    issuedAtMs: nowMs,
  });
  const contentHash = computeInstrumentContentHash(
    hashPayloadFromSnapshot(snapshot, record.appointedByUid ?? ''),
  );

  const lifecycle = await lifecycleStateProvider.getLifecycleState(db, {
    roleHistoryId: record.roleHistoryId,
    ratificationRequired: taxonomy.ratificationRequired,
    appointedAtMs: record.appointedAtMs,
  });

  const data: Record<string, unknown> = {
    roleHistoryId: record.roleHistoryId,
    positionId: record.positionId,
    appointeeUid: record.appointeeUid,
    appointeeDisplayName: ctx.appointeeDisplayName,
    roleKey: record.roleKey,
    roleDisplayName: taxonomy.displayName,
    chapterId: record.chapterId,
    category: taxonomy.category,
    appointedByUid: record.appointedByUid,
    appointedByDisplayName: record.appointedByDisplayName,
    appointedByOffice: record.appointedByOffice ?? taxonomy.appointedByOffice,
    authorityReference: record.authorityReference ?? taxonomy.authorityReference,
    appointedAt: ts(record.appointedAtMs),
    effectiveFrom: ts(record.effectiveFromMs),
    backdateReason: record.backdateReason,
    termEndsAt: taxonomy.termEndsAtMs ? ts(taxonomy.termEndsAtMs) : null,
    ratificationRequired: taxonomy.ratificationRequired,
    ratificationState: lifecycle.state,
    ratificationDeadline: lifecycle.deadlineMs ? ts(lifecycle.deadlineMs) : null,
    ratificationDecisionId: lifecycle.decisionId,
    letter: {
      status: 'issued',
      generatedAt: ts(nowMs),
      generatedByUid: actorUid,
      templateVersion: LETTER_TEMPLATE_VERSION,
      verificationCode,
      contentHash,
      snapshot,
      driveFileId: null,
      driveWebViewLink: null,
      fileName: null,
      sizeBytes: null,
    },
    acceptance: { status: 'awaiting_upload' },
    supersededByInstrumentId: null,
    supersedesInstrumentId: opts.supersedesInstrumentId ?? null,
    createdAt: ts(nowMs),
    updatedAt: ts(nowMs),
    createdByUid: actorUid,
  };

  return { instrumentId, data, verificationCode, contentHash };
}

/** JSON shape returned by admin-facing instrument endpoints. */
export function serializeInstrument(
  instrument: AppointmentInstrument,
): Record<string, unknown> {
  const letter = instrument.letter
    ? {
        status: instrument.letter.status,
        generatedAt: tsToIso(instrument.letter.generatedAt),
        generatedByUid: instrument.letter.generatedByUid,
        templateVersion: instrument.letter.templateVersion,
        verificationCode: instrument.letter.verificationCode,
        contentHash: instrument.letter.contentHash,
        driveFileId: instrument.letter.driveFileId,
        driveWebViewLink: instrument.letter.driveWebViewLink,
        fileName: instrument.letter.fileName,
        sizeBytes: instrument.letter.sizeBytes,
      }
    : null;
  return {
    id: instrument.id,
    roleHistoryId: instrument.roleHistoryId,
    positionId: instrument.positionId,
    appointeeUid: instrument.appointeeUid,
    appointeeDisplayName: instrument.appointeeDisplayName,
    roleKey: instrument.roleKey,
    roleDisplayName: instrument.roleDisplayName,
    chapterId: instrument.chapterId,
    category: instrument.category,
    appointedByUid: instrument.appointedByUid,
    appointedByDisplayName: instrument.appointedByDisplayName,
    appointedByOffice: instrument.appointedByOffice,
    authorityReference: instrument.authorityReference,
    appointedAt: tsToIso(instrument.appointedAt),
    effectiveFrom: tsToIso(instrument.effectiveFrom),
    backdateReason: instrument.backdateReason,
    termEndsAt: tsToIso(instrument.termEndsAt),
    ratificationRequired: instrument.ratificationRequired,
    ratificationState: instrument.ratificationState,
    ratificationDeadline: tsToIso(instrument.ratificationDeadline),
    ratificationDecisionId: instrument.ratificationDecisionId,
    letter,
    acceptance: instrument.acceptance
      ? {
          status: instrument.acceptance.status,
          fileName: instrument.acceptance.fileName ?? null,
          sizeBytes: instrument.acceptance.sizeBytes ?? null,
          contentType: instrument.acceptance.contentType ?? null,
          fileHash: instrument.acceptance.fileHash ?? null,
          driveWebViewLink: instrument.acceptance.driveWebViewLink ?? null,
          uploadedAt: tsToIso(instrument.acceptance.uploadedAt),
          uploadedByUid: instrument.acceptance.uploadedByUid ?? null,
          checkedByUid: instrument.acceptance.checkedByUid ?? null,
          checkedAt: tsToIso(instrument.acceptance.checkedAt),
          checkNote: instrument.acceptance.checkNote ?? null,
        }
      : { status: 'awaiting_upload' },
    supersededByInstrumentId: instrument.supersededByInstrumentId,
    supersedesInstrumentId: instrument.supersedesInstrumentId,
    createdAt: tsToIso(instrument.createdAt),
    updatedAt: tsToIso(instrument.updatedAt),
    createdByUid: instrument.createdByUid,
  };
}

/** Plain-words ratification line for public + appointee surfaces (G.4.3). */
export function ratificationPlainLine(
  instrument: AppointmentInstrument,
  refusedDateLine: string | null,
): string {
  switch (instrument.ratificationState) {
    case 'ratified':
      return 'Ratified';
    case 'deemed_ratified':
      return 'Ratified by lapse of 30 days';
    case 'pending_ratification': {
      const deadline = tsToIso(instrument.ratificationDeadline);
      const date = deadline
        ? new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Karachi',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }).format(new Date(deadline))
        : 'the deadline';
      return `Pending ratification until ${date}`;
    }
    case 'refused':
      return refusedDateLine
        ? `Appointment refused ratification on ${refusedDateLine}; acts before that date remain valid`
        : 'Appointment refused ratification; acts before the refusal remain valid';
    case 'not_required':
    default:
      return 'Ratification not required';
  }
}

/**
 * Best-effort refusal date: the linked decisions record (D-G6) carries
 * the act date; fall back to the instrument's updatedAt. ADAPTER: when
 * Phase 2 exposes the refusal timestamp on its read model, read it
 * there instead.
 */
export async function refusalDateLine(
  db: Firestore,
  instrument: AppointmentInstrument,
): Promise<string | null> {
  if (instrument.ratificationState !== 'refused') return null;
  let ms = 0;
  if (instrument.ratificationDecisionId) {
    try {
      const snap = await db
        .collection('decisions')
        .doc(instrument.ratificationDecisionId)
        .get();
      if (snap.exists) {
        const data = (snap.data() ?? {}) as Record<string, unknown>;
        ms = tsToMs(data.decidedAt ?? data.createdAt ?? data.timestamp);
      }
    } catch {
      ms = 0;
    }
  }
  if (!ms) ms = tsToMs(instrument.updatedAt);
  if (!ms) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(ms));
}

export { MisconfiguredError };
