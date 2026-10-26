// Form responses route (migration step 11, Cluster J).
//
//   GET  /api/forms/[formId]/responses  list a form's responses
//                                        (canManageForms or founder)
//   POST /api/forms/[formId]/responses  append a member response
//                                        (any signed-in user)
//
// The base tree had NO in-app writer for forms/{id}/responses (the
// admin responses page only reads the subcollection); this POST is
// the append write path. Appends are Firestore-primary (Admin SDK
// add with a pre-generated id) and mirror best-effort through the
// forms-supa seam — append-shaped writes mirror trivially because
// the doc id is known before either write lands.
//
// Read gate: useSupa('forms') via the seam — flag ON serves
// fs_group_responses for this form; flag OFF / unconfigured / adapter
// error serves the Admin SDK Firestore read. Both paths return
// { form, responses } with timestamps serialized to ISO strings.
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import {
  mirrorFormResponseAppend,
  readFormResponsesViaSupa,
  setFormResponsePrimaryFirst,
  readFormViaSupa,
} from '@/lib/server/forms-supa';
import { serializePublicMiscDoc } from '@/lib/server/public-misc-supa-shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireSignedIn(request: NextRequest) {
  const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
  if (!token) {
    return { error: NextResponse.json({ error: 'Sign in required' }, { status: 401 }) };
  }
  try {
    const decoded = await verifyIdTokenString(token);
    return { uid: decoded.uid };
  } catch {
    return { error: NextResponse.json({ error: 'Invalid session' }, { status: 401 }) };
  }
}

async function requireFormsAdmin(request: NextRequest) {
  const gate = await requireSignedIn(request);
  if ('error' in gate) return gate;
  if (!isFounder(gate.uid)) {
    const gateDb = getDb();
    if (
      !gateDb ||
      !(await hasServerPermissionForUser(gateDb, gate.uid, 'canManageForms'))
    ) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }
  return gate;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ formId: string }> },
) {
  const gate = await requireFormsAdmin(request);
  if ('error' in gate) return gate.error;
  const { formId } = await params;

  const supaForm = await readFormViaSupa(formId);
  const supaResponses = await readFormResponsesViaSupa(formId);
  if (supaForm.status === 'ok' && supaResponses.status === 'ok') {
    if (!supaForm.doc) {
      return NextResponse.json({ error: 'Form not found.' }, { status: 404 });
    }
    const { id: formDocId, ...formData } = supaForm.doc as Record<string, any>;
    return NextResponse.json({
      form: { id: formDocId, ...serializePublicMiscDoc(formData) },
      responses: supaResponses.docs.map((doc) => {
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
  const formSnap = await db.collection('forms').doc(formId).get();
  if (!formSnap.exists) {
    return NextResponse.json({ error: 'Form not found.' }, { status: 404 });
  }
  const responsesSnap = await db.collection(`forms/${formId}/responses`).get();
  return NextResponse.json({
    form: {
      id: formSnap.id,
      ...serializePublicMiscDoc((formSnap.data() ?? {}) as Record<string, any>),
    },
    responses: responsesSnap.docs.map((doc) => ({
      id: doc.id,
      ...serializePublicMiscDoc(doc.data() as Record<string, any>),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ formId: string }> },
) {
  const gate = await requireSignedIn(request);
  if ('error' in gate) return gate.error;
  const { formId } = await params;

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? (body.data as Record<string, any>)
    : null;
  if (!data) {
    return NextResponse.json({ error: 'Response data is required.' }, { status: 400 });
  }

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration: Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  const formSnap = await db.collection('forms').doc(formId).get();
  if (!formSnap.exists) {
    return NextResponse.json({ error: 'Form not found.' }, { status: 404 });
  }

  const ref = db.collection(`forms/${formId}/responses`).doc();
  const submittedAtIso = new Date().toISOString();
  const firestoreData = {
    formId,
    data,
    submittedBy: gate.uid,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const mirrorPayload = {
    formId,
    data,
    submittedBy: gate.uid,
    submittedAt: submittedAtIso,
  };

  // WRITE PRIMACY (cutover W4): adapter first + throw on failure under
  // isSupaPrimary('forms'); the Firestore set then runs as the
  // best-effort post-commit mirror. OFF: Firestore-first + mirror.
  if (await setFormResponsePrimaryFirst(formId, ref.id, mirrorPayload)) {
    try {
      await ref.set(firestoreData);
    } catch (e) {
      console.warn('[api/forms/responses] Firestore mirror after primary append failed:', e);
    }
  } else {
    await ref.set(firestoreData);
    // Best-effort Supabase mirror of the append (step 11 seam).
    await mirrorFormResponseAppend(formId, ref.id, mirrorPayload);
  }

  return NextResponse.json(
    { id: ref.id, formId, submittedAt: submittedAtIso },
    { status: 201 },
  );
}
