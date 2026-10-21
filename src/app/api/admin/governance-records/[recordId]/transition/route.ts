import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb } from '@/lib/server/firebase-admin';
import { writeGovernanceAudit } from '@/lib/governance/audit';
import { verifyConsentGiven } from '@/lib/governance/consent-adapter';
import {
  RedactionBlockError,
  assertAccessLevelChange,
} from '@/lib/governance/redaction-guard';
import { getRegistrationStatus } from '@/lib/governance/registration-status';
import {
  GOVERNANCE_COLLECTION,
  loadRecord,
  toGovernanceRecord,
} from '@/lib/governance/record-io';
import {
  dbUnavailable,
  requireGovernancePermission,
} from '@/lib/governance/route-auth';
import {
  ACCESS_LEVEL,
  REDACTION_STATUS,
  isValidStatusTransition,
  type AccessLevel,
  type GovernanceSeries,
  type GovernanceStatus,
  type RedactionStatus,
} from '@/lib/governance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// FIN-01 (doc 05 sec 1.4) generalised per spec 4.4: instruments of these
// classes are approved or published only with a decided Founder Consent.
// Narrowing this list is a one-constant change on Zubair's instruction.
const CONSENT_REQUIRED_SERIES: GovernanceSeries[] = [
  'constitution_suite',
  'policy',
  'mou',
];

// POST: status / access-level / redaction / consent transitions
// (spec 4.4). Per-field gates: status and accessLevel need
// canApproveGovernanceRecords; redactionStatus and consentId need
// canManageGovernanceRecords. The audit write is FAIL-CLOSED and is
// written before the change is applied: no silent unaudited transition.
export async function POST(
  request: NextRequest,
  { params }: { params: { recordId: string } },
) {
  const db = getDb();
  if (!db) return dbUnavailable();

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const wantsStatus = typeof body.status === 'string';
  const wantsAccess = typeof body.accessLevel === 'string';
  const wantsRedaction = typeof body.redactionStatus === 'string';
  const wantsConsent = typeof body.consentId === 'string';
  if (!wantsStatus && !wantsAccess && !wantsRedaction && !wantsConsent) {
    return NextResponse.json(
      { error: 'Supply at least one of: status, accessLevel, redactionStatus, consentId' },
      { status: 400 },
    );
  }

  const gate = await requireGovernancePermission(
    request,
    db as never,
    wantsStatus || wantsAccess
      ? ['canApproveGovernanceRecords']
      : ['canManageGovernanceRecords'],
  );
  if (!gate.ok) return gate.response;
  // A mixed request (approver fields + manager fields) needs both keys;
  // the first gate above proves the dominant one, so check the other too.
  if ((wantsStatus || wantsAccess) && (wantsRedaction || wantsConsent)) {
    const second = await requireGovernancePermission(request, db as never, [
      'canManageGovernanceRecords',
    ]);
    if (!second.ok) return second.response;
  }

  const raw = await loadRecord(db as never, params.recordId);
  if (!raw) {
    return NextResponse.json({ error: 'Record not found' }, { status: 404 });
  }

  const currentStatus = raw.status as GovernanceStatus;
  const nextStatus = wantsStatus
    ? (body.status as GovernanceStatus)
    : currentStatus;
  const nextAccess = wantsAccess
    ? (body.accessLevel as AccessLevel)
    : (raw.accessLevel as AccessLevel);
  const nextRedaction = wantsRedaction
    ? (body.redactionStatus as RedactionStatus)
    : (raw.redactionStatus as RedactionStatus);
  const nextConsentId = wantsConsent
    ? (body.consentId as string)
    : ((raw.consentId as string | null) ?? null);
  const reason = typeof body.reason === 'string' ? body.reason : null;

  // (2) Validate each requested change.
  if (wantsStatus) {
    if (nextStatus === 'superseded') {
      return NextResponse.json(
        { error: 'superseded is set by the system when a successor is approved, never directly' },
        { status: 400 },
      );
    }
    if (!isValidStatusTransition(currentStatus, nextStatus)) {
      return NextResponse.json(
        { error: `Illegal status transition: ${currentStatus} -> ${nextStatus}` },
        { status: 400 },
      );
    }
    if (currentStatus === 'draft' && nextStatus !== 'draft' && !raw.driveFileId) {
      return NextResponse.json(
        { error: 'A record cannot leave draft without an attached file', code: 'no-file' },
        { status: 422 },
      );
    }
    if (
      nextStatus === 'effective' &&
      raw.adoptionStatus !== 'adopted_executed'
    ) {
      return NextResponse.json(
        {
          error:
            'A record can become effective only when its adoption status is adopted_executed',
          code: 'not-executed',
        },
        { status: 422 },
      );
    }
  }
  if (wantsAccess && !(ACCESS_LEVEL as readonly string[]).includes(nextAccess)) {
    return NextResponse.json({ error: 'Invalid accessLevel' }, { status: 400 });
  }
  if (
    wantsRedaction &&
    !(REDACTION_STATUS as readonly string[]).includes(nextRedaction)
  ) {
    return NextResponse.json({ error: 'Invalid redactionStatus' }, { status: 400 });
  }

  // (3) Founder Consent gate (FIN-01): approving, or making public, a
  // consent-class instrument requires a decided Consent on the record.
  const needsConsent =
    (wantsStatus && nextStatus === 'approved') ||
    (wantsAccess && nextAccess === 'public');
  if (needsConsent) {
    const series = raw.series as GovernanceSeries;
    const links = (raw.links as Record<string, unknown> | undefined) ?? {};
    const reservedMatter = links.reservedMatter === true;
    if (CONSENT_REQUIRED_SERIES.includes(series) || reservedMatter) {
      if (!nextConsentId) {
        return NextResponse.json(
          {
            error:
              'This document class requires a decided Founder Consent before it can be approved or published (FIN-01)',
            code: 'consent-required',
          },
          { status: 422 },
        );
      }
      const state = await verifyConsentGiven(db as never, nextConsentId);
      if (state !== 'given') {
        return NextResponse.json(
          {
            error: `Founder Consent is not decided/given (state: ${state})`,
            code: 'consent-not-given',
          },
          { status: 422 },
        );
      }
    }
  }

  // (4) Redaction guard over the post-transition shape.
  if (wantsAccess || wantsRedaction) {
    try {
      assertAccessLevelChange(
        {
          series: raw.series as GovernanceSeries,
          accessLevel: raw.accessLevel as AccessLevel,
          redactionStatus: nextRedaction,
        },
        nextAccess,
      );
    } catch (e) {
      if (e instanceof RedactionBlockError) {
        await writeGovernanceAudit(
          'GOVERNANCE_PUBLISH_BLOCKED',
          gate.auth.uid,
          params.recordId,
          { rule: e.rule, attemptedAccessLevel: nextAccess },
        );
        return NextResponse.json(
          { error: e.message, code: e.code, rule: e.rule },
          { status: 422 },
        );
      }
      throw e;
    }
  }

  // (5) Audit first (fail-closed), then apply.
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  if (wantsStatus) {
    from.status = currentStatus;
    to.status = nextStatus;
  }
  if (wantsAccess) {
    from.accessLevel = raw.accessLevel;
    to.accessLevel = nextAccess;
  }
  if (wantsRedaction) {
    from.redactionStatus = raw.redactionStatus;
    to.redactionStatus = nextRedaction;
  }
  if (wantsConsent) {
    from.consentId = raw.consentId ?? null;
    to.consentId = nextConsentId;
  }
  const auditOk = await writeGovernanceAudit(
    'GOVERNANCE_RECORD_TRANSITION',
    gate.auth.uid,
    params.recordId,
    { from, to, consentId: nextConsentId, reason },
    { failClosed: true },
  );
  if (!auditOk) {
    return NextResponse.json(
      { error: 'Audit write failed; transition not applied' },
      { status: 500 },
    );
  }

  const updates: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (wantsStatus) {
    updates.status = nextStatus;
    if (nextStatus === 'approved') updates.approvedBy = gate.auth.uid;
  }
  if (wantsAccess) updates.accessLevel = nextAccess;
  if (wantsRedaction) updates.redactionStatus = nextRedaction;
  if (wantsConsent) updates.consentId = nextConsentId;
  if (reason && body.appendReasonToNotes === true) {
    const existing = typeof raw.notes === 'string' ? raw.notes : '';
    updates.notes = existing ? `${existing}\n${reason}` : reason;
  }

  const batch = db.batch();
  batch.update(
    db.collection(GOVERNANCE_COLLECTION).doc(params.recordId),
    updates,
  );
  // Automatic supersede (spec 3.4): when this version is approved, the
  // version it supersedes leaves approved/effective for superseded, in
  // the same write, without touching its file fields.
  if (wantsStatus && nextStatus === 'approved' && raw.supersedesRecordId) {
    const prevId = raw.supersedesRecordId as string;
    const prev = await loadRecord(db as never, prevId);
    if (prev && (prev.status === 'approved' || prev.status === 'effective')) {
      batch.update(db.collection(GOVERNANCE_COLLECTION).doc(prevId), {
        status: 'superseded',
        supersededByRecordId: params.recordId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
  await batch.commit();

  const registrationStatus = await getRegistrationStatus(db as never);
  const record = toGovernanceRecord(
    { ...raw, ...updates, updatedAt: new Date().toISOString() },
    registrationStatus,
  );
  return NextResponse.json({ record: { ...record, hasFile: !!record.driveFileId } });
}
