// Resources collection route (migration step 11, Cluster K).
//
// The resources surface previously had NO server route: the public
// page and the admin pages read/write Firestore directly from the
// browser. This route is the server path the resources-supa seam
// hangs off:
//   GET  /api/resources  public list, createdAt desc (the public
//                        page's order)
//   POST /api/resources  create a resource (canManageResources or
//                        founder), Firestore-primary + best-effort
//                        Supabase mirror
//
// Read gate: useSupa('resources') via the seam — flag ON serves
// fs_resources, flag OFF / unconfigured / adapter error serves the
// Admin SDK Firestore read. Both paths return { items: [...] } with
// timestamp fields serialized to ISO strings in both modes.
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import {
  mirrorResourceCreate,
  readResourcesViaSupa,
  setResourcePrimaryFirst,
} from '@/lib/server/resources-supa';
import { serializePublicMiscDoc } from '@/lib/server/public-misc-supa-shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const supaRead = await readResourcesViaSupa();
  if (supaRead.status === 'ok') {
    return NextResponse.json({
      items: supaRead.docs.map((doc) => {
        const { id, ...data } = doc as Record<string, any>;
        return { id, ...serializePublicMiscDoc(data) };
      }),
    });
  }

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  const snap = await db.collection('resources').orderBy('createdAt', 'desc').get();
  return NextResponse.json({
    items: snap.docs.map((doc) => ({
      id: doc.id,
      ...serializePublicMiscDoc(doc.data() as Record<string, any>),
    })),
  });
}

export async function POST(request: NextRequest) {
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

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const resourceData: Record<string, any> = {
    ...body,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // WRITE PRIMACY (cutover W4): adapter first + throw on failure under
  // isSupaPrimary('resources'), carrying the mirror payload (ISO
  // timestamps); the Firestore set then runs as the best-effort
  // post-commit mirror. OFF: the original .add() flow runs
  // byte-identically.
  const candidateRef = db.collection('resources').doc();
  const mirrorPayload = { ...body, createdAt: nowIso, updatedAt: nowIso };
  let docRef: { id: string };
  if (await setResourcePrimaryFirst(candidateRef.id, mirrorPayload)) {
    docRef = candidateRef;
    try {
      await candidateRef.set(resourceData);
    } catch (e) {
      console.warn('[api/resources] Firestore mirror after primary create failed:', e);
    }
  } else {
    docRef = await db.collection('resources').add(resourceData);
    // Best-effort Supabase mirror (step 11 seam); never fails the create.
    await mirrorResourceCreate(docRef.id, mirrorPayload);
  }

  return NextResponse.json({ id: docRef.id, ...body, createdAt: nowIso, updatedAt: nowIso }, { status: 201 });
}
