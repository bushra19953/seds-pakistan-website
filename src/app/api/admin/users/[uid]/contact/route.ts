import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { getUserContact, resolveUserEmail } from '@/lib/server/user-contact';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET: one user's gated contact record for the admin inspector and
 * the event-attendees fallback.
 *
 * Contact data lives ONLY in users/{uid}/private/contact; this route
 * is its admin read doorway. The gate — canManageUsers via
 * hasServerPermissionForUser, the same auth pattern as the sibling
 * [uid] routes (depart/reinstate) — intentionally equals the
 * Firestore rules gate for the private/contact document.
 *
 * Response: { email, whatsapp, whatsappNumber } — email resolved
 * contact-record-first with the Firebase Auth fallback
 * (resolveUserEmail); the whatsapp fields come from the contact
 * record itself. 404 when the user does not exist.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { uid: string } }
) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!(await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canManageUsers'))) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    const { uid } = params;
    if (!uid) {
      return NextResponse.json({ error: 'User id is required' }, { status: 400 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB failed');

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const [email, contact] = await Promise.all([
      resolveUserEmail(db, uid),
      getUserContact(db, uid),
    ]);

    return NextResponse.json({
      email: email ?? null,
      whatsapp: contact?.whatsapp ?? null,
      whatsappNumber: contact?.whatsappNumber ?? null,
    });
  } catch (e) {
    console.error('[users/contact] error:', e);
    return NextResponse.json({ error: 'Failed to load contact' }, { status: 500 });
  }
}
