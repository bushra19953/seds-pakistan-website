// Competitions list route (migration step 11, Cluster K).
//
//   GET /api/resources/competitions  list all competitions
//                                    (canManageResources or founder —
//                                    the admin resources page shows
//                                    non-public entries too, so this
//                                    list is not a public surface)
//
// Read gate: useSupa('resources') via the resources-supa seam — flag
// ON serves fs_competitions, flag OFF / unconfigured / adapter error
// serves the Admin SDK Firestore read. Both paths return
// { items: [...] } with timestamps serialized to ISO strings.
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import { readCompetitionsViaSupa } from '@/lib/server/resources-supa';
import { serializePublicMiscDoc } from '@/lib/server/public-misc-supa-shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await verifyIdTokenString(token);
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  if (!isFounder(decoded.uid)) {
    const allowed = await hasServerPermissionForUser(db, decoded.uid, 'canManageResources');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const supaRead = await readCompetitionsViaSupa();
  if (supaRead.status === 'ok') {
    return NextResponse.json({
      items: supaRead.docs.map((doc) => {
        const { id, ...data } = doc as Record<string, any>;
        return { id, ...serializePublicMiscDoc(data) };
      }),
    });
  }

  const snap = await db.collection('competitions').get();
  return NextResponse.json({
    items: snap.docs.map((doc) => ({
      id: doc.id,
      ...serializePublicMiscDoc(doc.data() as Record<string, any>),
    })),
  });
}
