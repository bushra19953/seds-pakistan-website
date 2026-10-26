// Forms collection route (migration step 11, Cluster J).
//
// The forms surface previously had NO server route: the admin page
// read/wrote Firestore directly from the browser. This route is the
// server path the forms-supa seam hangs off:
//   GET  /api/forms  list all forms (canManageForms or founder)
//   POST /api/forms  create a form (canManageForms or founder),
//                    Firestore-primary + best-effort Supabase mirror
//
// Read gate: useSupa('forms') via the seam — flag ON serves
// fs_forms, flag OFF / unconfigured / adapter error serves the
// Admin SDK Firestore read. Both paths return the same shape:
// { forms: [{ id, ...fields }] } with timestamp fields serialized to
// ISO strings (the Supabase storage shape) in both modes.
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import {
  mirrorFormCreate,
  readFormsViaSupa,
  setFormPrimaryFirst,
} from '@/lib/server/forms-supa';
import { serializePublicMiscDoc } from '@/lib/server/public-misc-supa-shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireFormsAdmin(request: NextRequest) {
  const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
  if (!token) {
    return { error: NextResponse.json({ error: 'Sign in required' }, { status: 401 }) };
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await verifyIdTokenString(token);
  } catch {
    return { error: NextResponse.json({ error: 'Invalid session' }, { status: 401 }) };
  }
  if (!isFounder(decoded.uid)) {
    const gateDb = getDb();
    if (
      !gateDb ||
      !(await hasServerPermissionForUser(gateDb, decoded.uid, 'canManageForms'))
    ) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }
  return { uid: decoded.uid };
}

export async function GET(request: NextRequest) {
  const gate = await requireFormsAdmin(request);
  if ('error' in gate) return gate.error;

  const supaRead = await readFormsViaSupa();
  if (supaRead.status === 'ok') {
    return NextResponse.json({
      forms: supaRead.docs.map((doc) => {
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
  const snap = await db.collection('forms').get();
  return NextResponse.json({
    forms: snap.docs.map((doc) => ({
      id: doc.id,
      ...serializePublicMiscDoc(doc.data() as Record<string, any>),
    })),
  });
}

export async function POST(request: NextRequest) {
  const gate = await requireFormsAdmin(request);
  if ('error' in gate) return gate.error;

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const title = typeof body.title === 'string' ? body.title : '';
  const description = typeof body.description === 'string' ? body.description : '';
  if (!title || !description) {
    return NextResponse.json(
      { error: 'Title and description are required.' },
      { status: 400 },
    );
  }
  const fields = Array.isArray(body.fields) ? body.fields : [];

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const formData = { title, description, fields, createdAt: now, updatedAt: now };
  const nowIso = new Date().toISOString();
  const mirrorPayload = { title, description, fields, createdAt: nowIso, updatedAt: nowIso };

  // WRITE PRIMACY (cutover W4): adapter first + throw on failure under
  // isSupaPrimary('forms'), carrying the mirror payload (ISO
  // timestamps); the Firestore set then runs as the best-effort
  // post-commit mirror. OFF: Firestore-first + mirror, as before.
  const docRef = db.collection('forms').doc();
  if (await setFormPrimaryFirst(docRef.id, mirrorPayload)) {
    try {
      await docRef.set(formData);
    } catch (e) {
      console.warn('[api/forms] Firestore mirror after primary create failed:', e);
    }
  } else {
    await docRef.set(formData);
    // Best-effort Supabase mirror (step 11 seam); never fails the create.
    await mirrorFormCreate(docRef.id, mirrorPayload);
  }

  return NextResponse.json(
    { id: docRef.id, title, description, fields, createdAt: nowIso, updatedAt: nowIso },
    { status: 201 },
  );
}
