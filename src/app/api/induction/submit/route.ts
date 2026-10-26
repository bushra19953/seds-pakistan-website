import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { mirrorApplicationSet, setApplicationPrimaryFirst } from '@/lib/applications-supa';

/**
 * POST /api/induction/submit — WS10 route for A1, the induction
 * submit batch (apps-primacy census: the third named flip-blocker).
 *
 * The page used to run one atomic client batch:
 *   batch.set(applications/{uid}, applicationData)          (replace)
 *   batch.set(users/{uid}, flagUpdate, { merge: true })
 * with applicationData = { uid, email, ...safeFormData,
 * intakeWindowId, resume_url, portfolioLink, githubLink,
 * status:'pending', created_at/updated_at/last_saved_at:
 * serverTimestamp() } and flagUpdate = { hasApplied:true,
 * applicationStatus:'pending', updatedAt: serverTimestamp() }.
 *
 * This route preserves, server-side:
 *   - BATCH ATOMICITY (dual-write): one Admin WriteBatch with the
 *     same two sets; both land or neither, and a commit failure is a
 *     500 (the page's error path, unchanged).
 *   - THE GUARDED-KEY STRIP: the page strips uid/email/reviewed_by/
 *     rejection_reason/reviewed_at/pre_score/role/isAdmin from the
 *     form payload before spreading; the route strips the same keys
 *     again and then stamps uid/email from the verified token AFTER
 *     the spread, so no form field can override them. status is
 *     forced to 'pending' (a resubmission always re-enters the queue).
 *   - THE INTAKE-WINDOW STAMP: applicationData.intakeWindowId arrives
 *     in the body (the page resolved the fresh window and stamped it
 *     after its spread) and passes through untouched.
 *   - PRIMACY (A6 pattern): under isSupaPrimary('applications') the
 *     adapter set lands FIRST via setApplicationPrimaryFirst (throws
 *     → 500, zero Firestore writes); the Firestore batch then runs as
 *     the best-effort mirror store write. In dual-write the batch is
 *     primary and mirrorApplicationSet follows (never throws).
 *   - The post-submit audit entry ('application_submitted',
 *     logAuditEntry's stored shape), best-effort, as the page's
 *     guarded post-submit block was.
 *
 * The users flag write stays Firestore-only (cross-cluster users
 * write, the A4 rule). REPLICA PARITY: the batch bypassed the
 * wrapper, so the page fired its two explicit fireWebhook dispatches
 * itself — it STILL DOES, unchanged, after this route returns; the
 * dispatch payloads are byte-identical to today's, so the replica's
 * effects (universal_submissions sync for applications; the users
 * dispatch, whose after-image is a partial {uid, ...flagUpdate} the
 * replica's change-gated arms no-op on) are preserved by the page,
 * not re-implemented here.
 *
 * Body: { applicationData } — the page's applicationData WITHOUT its
 * three serverTimestamp fields (not JSON-serializable); the route
 * stamps created_at / updated_at / last_saved_at itself. flagUpdate
 * is a constant of the flow and is constructed here.
 */

export const dynamic = 'force-dynamic';

const GUARDED_KEYS = [
  'uid',
  'email',
  'reviewed_by',
  'rejection_reason',
  'reviewed_at',
  'pre_score',
  'role',
  'isAdmin',
] as const;

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) return fail(500, 'Server misconfiguration');
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return fail(401, 'Unauthorized');
  const db = getDb();
  if (!db) return fail(500, 'Server misconfiguration');
  const uid = auth.user.userId;
  const email = typeof auth.user.email === 'string' ? auth.user.email : '';
  if (!email) return fail(400, 'Sign-in incomplete');

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const incoming =
    body.applicationData && typeof body.applicationData === 'object' && !Array.isArray(body.applicationData)
      ? (body.applicationData as Record<string, any>)
      : null;
  if (!incoming) return fail(400, 'applicationData is required');

  const stripped: Record<string, any> = { ...incoming };
  for (const key of GUARDED_KEYS) delete stripped[key];

  const st = () => FieldValue.serverTimestamp();
  const applicationData: Record<string, any> = {
    ...stripped,
    uid,
    email,
    status: 'pending',
    created_at: st(),
    updated_at: st(),
    last_saved_at: st(),
  };
  const flagUpdate: Record<string, any> = {
    hasApplied: true,
    applicationStatus: 'pending',
    updatedAt: st(),
  };

  const runFirestoreBatch = async () => {
    const batch = db.batch();
    batch.set(db.collection('applications').doc(uid), applicationData);
    batch.set(db.collection('users').doc(uid), flagUpdate, { merge: true });
    await batch.commit();
  };

  try {
    const primaryWritten = await setApplicationPrimaryFirst(uid, applicationData);
    if (primaryWritten) {
      try {
        await runFirestoreBatch();
      } catch (mirrorErr) {
        console.error('[api/induction/submit] Firestore batch failed after primary write:', mirrorErr);
      }
    } else {
      await runFirestoreBatch();
      await mirrorApplicationSet(uid, applicationData);
    }
  } catch (err) {
    console.error('[api/induction/submit] submit failed:', err);
    return fail(500, 'Submission failed');
  }

  // Post-submit audit entry (best-effort, the page's guarded block).
  try {
    await db.collection('audit_logs').add({
      action: 'application_submitted',
      actorUid: uid,
      targetUidOrResource: uid,
      payload: { application_id: uid },
      timestamp: st(),
    });
  } catch (auditErr) {
    console.warn('Post-submit audit log failed (non-critical):', auditErr);
  }

  return NextResponse.json({ ok: true });
}
