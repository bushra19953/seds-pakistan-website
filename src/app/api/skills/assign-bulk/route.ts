import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';

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
    const permSnap = await db.collection('permissions').doc(role).get();
    const ok = !!(permSnap.exists && (permSnap.data() as any)?.canManageSkills === true);
    return ok;
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
  await batch.commit();
  return NextResponse.json({ updated: userIds.length });
}

