import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { assertConsentFor, consentGateHttpError } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { isFlaggedRecord, needsPartnerGate } from '@/lib/server/partners-gate';
import {
  deletePartnerPrimaryFirst,
  mirrorPartnerCreate,
  mirrorPartnerDelete,
  mirrorPartnerUpdate,
  setPartnerPrimaryFirst,
  supaPartnerDoc,
  updatePartnerPrimaryFirst,
} from '@/lib/server/crm-supa';

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

type AuthorizeResult =
  | { error: NextResponse }
  | { callerUid: string; callerRole: string };

async function authorize(request: NextRequest): Promise<AuthorizeResult> {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const callerUid = String((auth.user as any).userId || '');
  const callerRole = String((auth.user as any).role || '');
  const db = getDb();
  if (
    !(await hasServerPermissionForUser(
      db as never,
      callerUid,
      'canManageSponsorsPartners',
    ))
  ) {
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
export async function POST(request: NextRequest): Promise<NextResponse> {
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

  // WRITE PRIMACY (cutover W4, surface 'crm'): under isSupaPrimary the
  // adapter create lands FIRST (id pre-generated; the mirror payload —
  // `data` without the serverTimestamp fields — is exactly what the
  // mirror writes today) and throws on failure; the Firestore set then
  // runs as the best-effort post-commit mirror. OFF: the original
  // .add() flow runs byte-identically (the pre-minted ref is unused).
  const candidateRef = db.collection(COLLECTION).doc();
  let ref: { id: string };
  if (await setPartnerPrimaryFirst(candidateRef.id, data)) {
    ref = candidateRef;
    try {
      await candidateRef.set({
        ...data,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[api/admin/partners] Firestore mirror after primary create failed:', e);
    }
  } else {
    ref = await db.collection(COLLECTION).add({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // MIGRATION SEAM (Cluster F, surface 'crm'): best-effort mirror of
    // the committed create; mirror never throws.
    await mirrorPartnerCreate(ref.id, data);
  }

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
export async function PATCH(request: NextRequest): Promise<NextResponse> {
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
  // MIGRATION SEAM (Cluster F): the existing-record read is seam-served
  // when 'crm' is ON; null (OFF / unconfigured / adapter error) falls
  // back to the Firestore get byte-identically.
  const seamSnap = await supaPartnerDoc(id);
  const snap = seamSnap ?? (await ref.get());
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

  // WRITE PRIMACY (cutover W4): adapter first + throw on failure under
  // isSupaPrimary('crm'); Firestore update becomes the best-effort
  // mirror. OFF: Firestore-first + mirror, as before.
  if (await updatePartnerPrimaryFirst(id, patch)) {
    try {
      await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
    } catch (e) {
      console.warn('[api/admin/partners] Firestore mirror after primary update failed:', e);
    }
  } else {
    await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
    // MIGRATION SEAM (Cluster F): best-effort mirror of the committed update.
    await mirrorPartnerUpdate(id, patch);
  }

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
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const authz = await authorize(request);
  if ('error' in authz) return authz.error;
  const { callerUid, callerRole } = authz;

  const body = await request.json().catch(() => ({}));
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const ref = db.collection(COLLECTION).doc(id);
  // MIGRATION SEAM (Cluster F): seam-served existence/organization read,
  // Firestore fallback on null — same contract as PATCH above.
  const seamSnap = await supaPartnerDoc(id);
  const snap = seamSnap ?? (await ref.get());
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

  // WRITE PRIMACY (cutover W4): the audit above stays Firestore-first
  // in every mode (its or-throw semantics are unchanged); under
  // isSupaPrimary('crm') the adapter delete then lands FIRST and throws
  // on failure, and the Firestore delete runs as the best-effort
  // mirror. OFF: Firestore delete + mirror, as before.
  if (await deletePartnerPrimaryFirst(id)) {
    try {
      await ref.delete();
    } catch (e) {
      console.warn('[api/admin/partners] Firestore mirror after primary delete failed:', e);
    }
  } else {
    await ref.delete();
    // MIGRATION SEAM (Cluster F): best-effort mirror of the committed delete.
    await mirrorPartnerDelete(id);
  }

  return NextResponse.json({ ok: true, id });
}
