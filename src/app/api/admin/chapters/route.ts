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
 * POST /api/admin/chapters (Phase 2, spec B.3b.4).
 *
 * Server-side manual chapter creation. Manual creation IS an admission (the
 * chapter exists and is active the moment this returns), so it is gated as
 * one: matter chapter_lifecycle, subject { chapter, action: 'admit' }.
 * Exists because the B.4 rules rider ends direct client chapter creation for
 * everyone but the Founder; this route is the path that keeps the chapters
 * page working for non-Founder managers.
 */
export async function POST(request: NextRequest) {
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

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  const consentRequestId =
    typeof body.consentRequestId === 'string' && body.consentRequestId
      ? body.consentRequestId
      : null;
  if (!name || !slug) {
    return NextResponse.json({ error: 'name and slug are required' }, { status: 400 });
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return NextResponse.json({ error: 'slug must be kebab-case' }, { status: 400 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const chapterRef = db.collection('chapters').doc(slug);
  const existing = await chapterRef.get();
  if (existing.exists) {
    return NextResponse.json({ error: 'A chapter with this slug already exists' }, { status: 409 });
  }

  try {
    await assertConsentFor({
      db,
      actorUid: callerUid,
      matterKey: 'chapter_lifecycle',
      consentRequestId,
      subjectRef: { type: 'chapter', chapterId: slug, action: 'admit' },
      actSummary: `Manually admit chapter ${slug} (${name})`,
    });
  } catch (err) {
    const { status, body: errBody } = consentGateHttpError(err);
    return NextResponse.json(errBody, { status });
  }

  await writeGovernanceAuditOrThrow(db, {
    action: 'chapter_created',
    actorUid: callerUid,
    actorRole: callerRole,
    targetType: 'chapter',
    targetId: slug,
    details: { name, consentRequestId, via: 'manual_create' },
  });

  await chapterRef.set({
    name,
    slug,
    city: typeof body.city === 'string' ? body.city : '',
    country: typeof body.country === 'string' ? body.country : '',
    logoUrl: typeof body.logoUrl === 'string' ? body.logoUrl : '',
    universityName: typeof body.universityName === 'string' ? body.universityName : '',
    isActive: true,
    status: 'active',
    applicationId: null,
    createdBy: callerUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, chapterId: slug });
}
