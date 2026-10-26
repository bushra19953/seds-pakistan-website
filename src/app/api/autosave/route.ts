import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

/**
 * /api/autosave — WS10 route for the form-draft writes
 * (src/hooks/use-autosave.ts + the induction page's post-submit draft
 * cleanup), previously client setDoc/deleteDoc on drafts/{uid}
 * through firestore-wrapper. `drafts` is not a webhook-dispatch
 * collection, so no replica effect exists.
 *
 * POST   { state } — set-merge drafts/{callerUid} with the hook's
 *        exact stored shape: { payload: state, updated_at:
 *        serverTimestamp, expires_at: now + 30 days }.
 * DELETE — delete drafts/{callerUid} (post-submit cleanup).
 *
 * Owner-only by construction: the doc id is the verified token UID;
 * there is no way to name another user's draft. Both operations keep
 * the callers' swallow-errors contract — the hook logs and moves on,
 * the page's cleanup is explicitly non-critical.
 */

export const dynamic = 'force-dynamic';

const DRAFT_TTL_DAYS = 30;

async function callerUid(req: NextRequest): Promise<string | null> {
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return null;
  return auth.user.userId;
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const uid = await callerUid(req);
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  await db.collection('drafts').doc(uid).set(
    {
      payload: body.state ?? null,
      updated_at: FieldValue.serverTimestamp(),
      expires_at: new Date(Date.now() + DRAFT_TTL_DAYS * 24 * 3600 * 1000),
    },
    { merge: true },
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const uid = await callerUid(req);
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });

  await db.collection('drafts').doc(uid).delete();
  return NextResponse.json({ ok: true });
}
