import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { assertConsentFor, consentGateHttpError } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { isFlaggedRecord, needsPartnerGate } from '@/lib/server/partners-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLLECTION = 'sponsors_partners';

const WRITABLE_FIELDS = [
  'organizationName',
  'logoUrl',
  'website',
  'relationshipType',
  'status',
  'sponsorshipTier',
  'primaryContact',
  'financials',
  'agreementContractUrl',
  'agreementIntelligence',
  'interactionHistory',
  'timeline',
  'relationshipScore',
  'lastContactAt',
  'lastActivityAt',
  'lastActivityType',
  'nextActions',
  'nextActionDate',
  'integrationPoints',
  'strategicContext',
  'associatedEventIds',
  'isRelatedParty',
  'relatedPartyNature',
  'carriesConditions',
] as const;

function pickWritable(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of WRITABLE_FIELDS) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

async function authorize(request: NextRequest) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const callerUid = String((auth.user as any).userId || '');
  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermission(callerRole, 'canManageSponsorsPartners'))) {
    return {
      error: NextResponse.json(
        { error: 'Forbidden: sponsor/partner management permission required' },
        { status: 403 },
      ),
    };
  }
  return { callerUid, callerRole };
}

/**
 * POST /api/admin/partners (Phase 2, spec B.3c.2): create a partner record.
 * A flagged create is gated (subject names the organisation, recordId null).
 * The matter ships in record mode, so go-live impact is audit-only until the
 * settings flip - but the gate call is unconditional.
 */
export async function POST(request: NextRequest) {
  const authz = await authorize(request);
  if ('error' in authz) return authz.error;
  const { callerUid, callerRole } = authz;

  const body = await request.json().catch(() => ({}));
  const data = pickWritable(body as Record<string, unknown>);
  const consentRequestId =
    typeof body.consentRequestId === 'string' && body.consentRequestId
      ? body.consentRequestId
      : null;
  if (typeof data.organizationName !== 'string' || !data.organizationName) {
    return NextResponse.json({ error: 'organizationName is required' }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  if (needsPartnerGate({ existing: null, patch: data, isCreate: true })) {
    try {
      await assertConsentFor({
        db,
        actorUid: callerUid,
        matterKey: 'sponsor_partner_flagged',
        consentRequestId,
        subjectRef: {
          type: 'partner_record',
          recordId: null,
          organizationName: data.organizationName as string,
          collection: COLLECTION,
          action: 'create',
        },
        actSummary: `Create flagged partner record ${String(data.organizationName)}`,
      });
    } catch (err) {
      const { status, body: errBody } = consentGateHttpError(err);
      return NextResponse.json(errBody, { status });
    }
  }

  const ref = await db.collection(COLLECTION).add({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeGovernanceAuditOrThrow(db, {
    action: 'partner_created',
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'partner_record',
    targetId: ref.id,
    details: { flagged: isFlaggedRecord(data), consentRequestId },
  });

  return NextResponse.json({ ok: true, id: ref.id });
}

/**
 * PATCH /api/admin/partners (Phase 2, spec B.3c.2): update a partner record.
 * Body: { id, ...fields, consentRequestId? }. The gate decision uses the
 * RESULTING record (existing merged with the patch), so unflagging a record
 * is ungated, flagging one is gated, and interaction-only updates on flagged
 * records are exempt.
 */
export async function PATCH(request: NextRequest) {
  const authz = await authorize(request);
  if ('error' in authz) return authz.error;
  const { callerUid, callerRole } = authz;

  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === 'string' ? body.id : '';
  const consentRequestId =
    typeof body.consentRequestId === 'string' && body.consentRequestId
      ? body.consentRequestId
      : null;
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const patch = pickWritable(body as Record<string, unknown>);

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Partner record not found' }, { status: 404 });
  }
  const existing = snap.data() as Record<string, unknown>;

  if (needsPartnerGate({ existing, patch, isCreate: false })) {
    try {
      await assertConsentFor({
        db,
        actorUid: callerUid,
        matterKey: 'sponsor_partner_flagged',
        consentRequestId,
        subjectRef: {
          type: 'partner_record',
          recordId: id,
          collection: COLLECTION,
          action: 'update',
        },
        actSummary: `Update flagged partner record ${id} (${String(existing.organizationName ?? '')})`,
      });
    } catch (err) {
      const { status, body: errBody } = consentGateHttpError(err);
      return NextResponse.json(errBody, { status });
    }
  }

  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });

  await writeGovernanceAuditOrThrow(db, {
    action: 'partner_updated',
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'partner_record',
    targetId: id,
    details: {
      flagged: isFlaggedRecord({ ...existing, ...patch }),
      consentRequestId,
    },
  });

  return NextResponse.json({ ok: true, id });
}

/**
 * DELETE /api/admin/partners (Phase 2, spec B.3c.2): deletion is NOT a gated
 * matter at any flag state, but it moves server-side because the B.4 rules
 * rider ends client deletes. Audited as 'partner_deleted'.
 * Body: { id }.
 */
export async function DELETE(request: NextRequest) {
  const authz = await authorize(request);
  if ('error' in authz) return authz.error;
  const { callerUid, callerRole } = authz;

  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Partner record not found' }, { status: 404 });
  }

  await writeGovernanceAuditOrThrow(db, {
    action: 'partner_deleted',
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'partner_record',
    targetId: id,
    details: { organizationName: (snap.data() as Record<string, unknown>)?.organizationName ?? null },
  });

  await ref.delete();
  return NextResponse.json({ ok: true, id });
}
