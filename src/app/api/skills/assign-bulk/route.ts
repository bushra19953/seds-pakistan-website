import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';
import { mirrorUserSkillGrants } from '@/lib/server/skills-supa';
import {
  flushPendingUsersPrimaryOps,
  identityPrimaryFlagOn,
} from '@/lib/server/supa-identity-primary';


export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function authenticate(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return { decoded };
  } catch {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
}

async function canManage(decoded: admin.auth.DecodedIdToken, db: FirebaseFirestore.Firestore) {
  const claims: any = decoded || {};
  if (claims.manageSkills === true || (claims.permissions && claims.permissions.manageSkills === true)) return true;
  try {
    const roleSnap = await db.collection('roles').doc(decoded.uid).get();
    const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
    if (!role) return false;
    return hasServerPermission(role, 'canManageSkills');
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  const auth = await authenticate(request);
  if ('error' in auth) return auth.error;
  const ok = await canManage(auth.decoded, db);
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await request.json();
  const skillId = String(body?.skillId || '');
  const userIds = Array.isArray(body?.userIds) ? body.userIds.map(String) : [];
  if (!skillId || userIds.length === 0) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const batch = db.batch();
  for (const uid of userIds) {
    const ref = db.collection('users').doc(uid);
    batch.set(ref, { skillIds: admin.firestore.FieldValue.arrayUnion(skillId) }, { merge: true });
  }
  // WRITE PRIMACY (identity full build, G-USER-7, U-48): under
  // isSupaPrimary('users') the RMW bodies that today exist only as the
  // skills-token mirror become the PRIMARY write (flushed before the
  // batch commit, loud on failure); the Firestore batch keeps its
  // native arrayUnion as the reverse mirror, and the skills-token
  // mirror is stood down for these rows (H-01: exactly one writer).
  const usersPrimary = await identityPrimaryFlagOn('users');
  if (usersPrimary) {
    await flushPendingUsersPrimaryOps(
      userIds.map((uid) => ({
        uid,
        payload: { skillIds: admin.firestore.FieldValue.arrayUnion(skillId) },
      })),
    );
  }
  await batch.commit();
  if (!usersPrimary) {
    // Mirror the grants best-effort (never throws): union the skill id onto
    // each holder's fs_users row so flag-ON reads see the same skillIds.
    for (const uid of userIds) {
      await mirrorUserSkillGrants(uid, [skillId]);
    }
  }
  return NextResponse.json({ updated: userIds.length });
}

