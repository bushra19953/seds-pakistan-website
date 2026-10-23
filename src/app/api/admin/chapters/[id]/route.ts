import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { assertConsentFor, consentGateHttpError } from '@/lib/server/consent-gate';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/admin/chapters/[id] (Phase 2, spec B.3b.4).
 *
 * Cosmetic field edits (name, city, country, logoUrl, universityName) are not
 * lifecycle acts and pass with the ordinary permission + audit. Lifecycle
 * changes are classified from the RESULTING state:
 * - active -> suspended (isActive false or status 'suspended'): gated 'suspend'
 * - active|suspended -> expelled (status 'expelled'): gated 'expel'
 * - suspended -> active: NOT gated (reversal toward good standing carries no
 *   new prejudice); audited as 'chapter_reactivated'.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureAdminInitialized();
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const callerUid = String((auth.user as any).userId || '');
  const callerRole = String((auth.user as any).role || '');
  if (!(await hasServerPermissionForUser(getDb()!, callerUid, 'canManageChapters'))) {
    return NextResponse.json(
      { error: 'Forbidden: chapter management permission required' },
      { status: 403 },
    );
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const consentRequestId =
    typeof body.consentRequestId === 'string' && body.consentRequestId
      ? body.consentRequestId
      : null;

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const chapterRef = db.collection('chapters').doc(id);
  const snap = await chapterRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
  }
  const current = snap.data() as Record<string, unknown>;
  const currentActive = current.isActive !== false && current.status !== 'suspended' && current.status !== 'expelled';
  const currentStatus =
    typeof current.status === 'string'
      ? current.status
      : current.isActive === false
        ? 'suspended'
        : 'active';

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  for (const field of ['name', 'city', 'country', 'logoUrl', 'universityName'] as const) {
    if (typeof body[field] === 'string') updates[field] = body[field];
  }

  let lifecycleAction: 'suspend' | 'expel' | 'reactivate' | null = null;
  if (body.status === 'expelled' || body.status === 'suspended' || body.status === 'active') {
    if (body.status === 'expelled' && currentStatus !== 'expelled') lifecycleAction = 'expel';
    else if (body.status === 'suspended' && currentActive) lifecycleAction = 'suspend';
    else if (body.status === 'active' && !currentActive && currentStatus !== 'expelled') {
      lifecycleAction = 'reactivate';
    }
    updates.status = body.status;
    updates.isActive = body.status === 'active';
  } else if (typeof body.isActive === 'boolean') {
    if (body.isActive === false && currentActive) {
      lifecycleAction = 'suspend';
      updates.isActive = false;
      updates.status = 'suspended';
    } else if (body.isActive === true && !currentActive && currentStatus !== 'expelled') {
      lifecycleAction = 'reactivate';
      updates.isActive = true;
      updates.status = 'active';
    } else {
      updates.isActive = body.isActive;
    }
  }

  if (lifecycleAction === 'suspend' || lifecycleAction === 'expel') {
    try {
      await assertConsentFor({
        db,
        actorUid: callerUid,
        matterKey: 'chapter_lifecycle',
        consentRequestId,
        subjectRef: { type: 'chapter', chapterId: id, action: lifecycleAction },
        actSummary: `${lifecycleAction === 'suspend' ? 'Suspend' : 'Expel'} chapter ${id}`,
      });
    } catch (err) {
      const { status, body: errBody } = consentGateHttpError(err);
      return NextResponse.json(errBody, { status });
    }
  }

  const auditAction =
    lifecycleAction === 'suspend'
      ? 'chapter_suspended'
      : lifecycleAction === 'expel'
        ? 'chapter_expelled'
        : lifecycleAction === 'reactivate'
          ? 'chapter_reactivated'
          : 'chapter_updated';

  await writeGovernanceAuditOrThrow(db, {
    action: auditAction,
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'chapter',
    targetId: id,
    details: { consentRequestId, fields: Object.keys(updates) },
  });

  await chapterRef.update(updates);
  return NextResponse.json({ ok: true, chapterId: id, lifecycleAction });
}
