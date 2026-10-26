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
//   PATCH /api/resources update a resource (WS10: the admin edit
//                        page's write, incl. its soft-delete, routed
//                        here; same gate as POST), Firestore-primary
//                        + best-effort mirror via mirrorResourceUpdate
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
  mirrorResourceUpdate,
  readResourcesViaSupa,
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
  const docRef = await db.collection('resources').add(resourceData);

  // Best-effort Supabase mirror (step 11 seam); never fails the create.
  await mirrorResourceCreate(docRef.id, { ...body, createdAt: nowIso, updatedAt: nowIso });

  return NextResponse.json({ id: docRef.id, ...body, createdAt: nowIso, updatedAt: nowIso }, { status: 201 });
}

/**
 * PATCH /api/resources — WS10 route for the admin edit page's writes.
 *
 * Body: { id, title?, description?, url?, type?, link?, published?,
 *         stampPublishedAt?, deleted?, stampDeletedAt? }
 * The Firestore update carries exactly the fields the client updateDoc
 * carried (title/description/url/published + updatedAt serverTimestamp;
 * publishedAt serverTimestamp only when the client stamped it on first
 * publish; the soft-delete's deleted/deletedAt pair). The mirror
 * carries the same fields with ISO timestamps. `resources` is not a
 * webhook-dispatch collection, so no replica effect exists to preserve.
 * Fields outside the allowlist are dropped — the client page never
 * sent any others.
 */
export async function PATCH(request: NextRequest) {
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
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  const nowIso = new Date().toISOString();
  const update: Record<string, any> = {};
  const mirror: Record<string, any> = {};
  for (const field of ['title', 'description', 'url', 'type', 'link'] as const) {
    if (typeof body[field] === 'string') {
      update[field] = body[field];
      mirror[field] = body[field];
    }
  }
  if (typeof body.published === 'boolean') {
    update.published = body.published;
    mirror.published = body.published;
  }
  if (typeof body.deleted === 'boolean') {
    update.deleted = body.deleted;
    mirror.deleted = body.deleted;
  }
  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  mirror.updatedAt = nowIso;
  if (body.stampPublishedAt === true) {
    update.publishedAt = admin.firestore.FieldValue.serverTimestamp();
    mirror.publishedAt = nowIso;
  }
  if (body.stampDeletedAt === true) {
    update.deletedAt = admin.firestore.FieldValue.serverTimestamp();
    mirror.deletedAt = nowIso;
  }

  await db.collection('resources').doc(id).update(update);
  await mirrorResourceUpdate(id, mirror);

  return NextResponse.json({ id, ...mirror });
}
