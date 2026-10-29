import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { flushPendingUsersPrimaryOps } from '@/lib/server/supa-identity-primary';

/**
 * POST /api/admin/users/award-badge — WS10 route for the
 * award-badge dialog's write (previously a client updateDoc on
 * users/{userUid} { badges: arrayUnion(slug), updatedAt } through
 * firestore-wrapper). Body { userUid, slug }.
 *
 * REPLICA PARITY — the one dispatch effect this write had: the
 * wrapper dispatch reached the replica's handleUserWritten with the
 * full before/after snapshots, and its leaderboard-cache arm stamps
 * cache/leaderboard { lastUpdated, invalidatedUser } whenever a
 * relevant field CHANGED — `badges` is in its field list. The other
 * arms are inert here (points unchanged → no auto-award; chapterId
 * and email unchanged). Admin writes fire no dispatch, so this route
 * owns the stamp explicitly, with the replica's exact payload and
 * its change-gate: the stamp lands only when the slug was not
 * already in the user's badges (an arrayUnion of an owned slug
 * changes nothing, and the replica would not have stamped).
 *
 * Gamification flip Phase 2 (2026-10-29, U4): after the Firestore
 * update, when the slug is new to the user (isNew, the same
 * change-gate as the cache stamp below), the badge union is
 * mirrored into fs_users through the established users-primary RMW
 * seam — flushPendingUsersPrimaryOps with a FieldValue.arrayUnion
 * payload (the U-33 machinery resolves the sentinel against the
 * fs_users row with a distinct union, preserving all other fields;
 * the webhook's badge arm uses this exact op shape). Best-effort:
 * a mirror failure is logged and never changes this route's
 * response. Gate: canManageBadges (the dialog's useAuthorization).
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
  const userUid = typeof body.userUid === 'string' ? body.userUid : '';
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!userUid || !slug) return fail(400, 'userUid and slug are required');

  const userRef = db.collection('users').doc(userUid);
  const before = await userRef.get();
  if (!before.exists) return fail(404, 'User not found');
  const owned: string[] = Array.isArray(before.data()?.badges)
    ? before.data()!.badges.filter((s: any) => typeof s === 'string')
    : [];
  const isNew = !owned.includes(slug);

  await userRef.update({
    badges: FieldValue.arrayUnion(slug),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // U4: mirror the badge union into fs_users, only when the slug is
  // new (an arrayUnion of an owned slug changes nothing there either).
  if (isNew) {
    try {
      await flushPendingUsersPrimaryOps([
        { uid: userUid, payload: { badges: FieldValue.arrayUnion(slug) } },
      ]);
    } catch (err) {
      console.error('[api/admin/users/award-badge] fs_users badge mirror failed (non-fatal):', err);
    }
  }

  // The replica's leaderboard-cache stamp, owned explicitly (see
  // header): only when the badges field actually changed.
  if (isNew) {
    try {
      await db.collection('cache').doc('leaderboard').set(
        { lastUpdated: new Date(), invalidatedUser: userUid },
        { merge: true },
      );
    } catch (err) {
      console.error('[api/admin/users/award-badge] cache stamp failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, awarded: isNew });
}
