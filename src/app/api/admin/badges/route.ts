import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';

/**
 * POST /api/admin/badges — WS10 route for the admin badges page
 * (previously client setDoc/updateDoc/deleteDoc through
 * firestore-wrapper). Body { op: 'create' | 'update' | 'delete',
 * slug, payload? }.
 *
 * The page's payload is identical for create and update (it rewrites
 * createdAt/createdBy on update too — preserved here): the route
 * stamps createdAt + updatedAt server-side on both ops. Create
 * enforces the slug-uniqueness the page checked with a read: an
 * existing slug returns 409 with the page's exact message.
 * `badges` is not a webhook-dispatch collection, and these page
 * writes have no Supabase mirror (the fs_badges mirrors ride the
 * gamification paths): Firestore-only parity.
 * Gate: canManageBadges (the page's AuthorizationGate).
 */

export const dynamic = 'force-dynamic';

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) return fail(500, 'Server misconfiguration');
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return fail(401, 'Unauthorized');
  const db = getDb();
  if (!db) return fail(500, 'Server misconfiguration');
  let allowed = false;
  try {
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageBadges');
  } catch {
    allowed = false;
  }
  if (!allowed) return fail(403, 'Forbidden');

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!slug) return fail(400, 'slug is required');
  const ref = db.collection('badges').doc(slug);

  if (body.op === 'delete') {
    await ref.delete();
    return NextResponse.json({ ok: true });
  }
  if (body.op !== 'create' && body.op !== 'update') return fail(400, 'Invalid op');
  const payload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, any>)
      : null;
  if (!payload) return fail(400, 'Invalid payload');

  const data = {
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  try {
    if (body.op === 'create') {
      const existing = await ref.get();
      if (existing.exists) return fail(409, 'A badge with this slug already exists');
      await ref.set(data);
    } else {
      await ref.update(data);
    }
  } catch (err) {
    console.error('[api/admin/badges] write failed:', err);
    return fail(500, 'Failed to save badge');
  }
  return NextResponse.json({ ok: true });
}
