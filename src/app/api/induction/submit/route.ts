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
 *   - WRITE ATOMICITY (dual-write): the same two sets now land in
 *     one Admin runTransaction (the SEC-RACE gate below — a
 *     transaction is strictly stronger than the original WriteBatch);
 *     both land or neither, and a commit failure is a 500 (the
 *     page's error path, unchanged).
 *   - THE GUARDED-KEY STRIP: the page strips uid/email/reviewed_by/
 *     rejection_reason/reviewed_at/pre_score/role/isAdmin from the
 *     form payload before spreading; the route strips the same keys
 *     again and then stamps uid/email from the verified token AFTER
 *     the spread, so no form field can override them. status is
 *     forced to 'pending' (a resubmission always re-enters the queue).
 *   - THE INTAKE-WINDOW STAMP: applicationData.intakeWindowId arrives
 *     in the body (the page resolved the fresh window and stamped it
 *     after its spread) and passes through untouched.
 *   - PRIMACY (A6 pattern, amended by SEC-RACE below): under
 *     isSupaPrimary('applications') the adapter set lands via
 *     setApplicationPrimaryFirst (throws → 500) and
 *     mirrorApplicationSet follows in dual-write (never throws).
 *   - SEC-RACE hasApplied GATE (audit item 11): the old flow replaced
 *     applications/{uid} unconditionally, so a re-POST overwrote the
 *     caller's own application and reset a reviewed state back to
 *     'pending'; the hasApplied guard existed only client-side. The
 *     Firestore write is now a runTransaction that re-reads the
 *     existing application + user flags and writes only when the
 *     stored application is in a re-appliable state (see
 *     isReappliableApplication): no application yet, or a terminal
 *     'rejected'/'withdrawn' application whose re-apply flag clear
 *     (POST /api/induction/reapply) has been consumed. Anything else
 *     is a 409 with zero writes to either store. The transaction runs
 *     BEFORE the Supa leg in both modes — it is the single
 *     serialization gate both legs share (the Supa adapter exposes no
 *     conditional write), and Firestore is written in both modes, so
 *     the gate sees every submit. Named residual: under primacy, if
 *     the adapter set then throws, the route compensates by restoring
 *     the pre-submit Firestore snapshots (best-effort) before
 *     returning 500; a failed compensation is logged, and the gate
 *     still prevents any later overwrite of the landed application.
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

/**
 * Re-appliable-state rule for the SEC-RACE gate. Mirrors the product
 * flow the page + /api/induction/reapply implement:
 * - No stored application: first submission, always allowed.
 * - Stored application in a terminal state ('rejected' / 'withdrawn')
 *   AND the user flag hasApplied is not true: the applicant has been
 *   through the re-apply flag clear (which sets hasApplied:false,
 *   applicationStatus:null for rejected applications), so a fresh
 *   submission is the designed re-application.
 * - Everything else (pending / under_review / shortlisted / approved,
 *   a rejected application whose flag clear has not run, or a stored
 *   application with no recognizable status) is a LIVE application:
 *   a re-POST must not overwrite it or reset it to 'pending'.
 */
function isReappliableApplication(
  priorApp: Record<string, any> | null,
  priorUser: Record<string, any> | null,
): boolean {
  if (!priorApp) return true;
  const status = typeof priorApp.status === 'string' ? priorApp.status.toLowerCase() : '';
  const terminal = status === 'rejected' || status === 'withdrawn';
  return terminal && priorUser?.hasApplied !== true;
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

  const appRef = db.collection('applications').doc(uid);
  const userRef = db.collection('users').doc(uid);

  // SEC-RACE GATE: check-and-set in ONE transaction. The transaction
  // re-reads applications/{uid} and users/{uid}; Firestore serializes
  // transactions touching those docs, so two concurrent submits
  // cannot both pass the gate, and a submit racing a review decision
  // sees the decided state, never a stale snapshot. A denied gate
  // writes nothing to either store.
  type GateOutcome =
    | { allowed: true; priorApp: Record<string, any> | null; priorUser: Record<string, any> | null }
    | { allowed: false; status: string };
  let gate: GateOutcome;
  try {
    gate = await db.runTransaction(async (t) => {
      const [appSnap, userSnap] = await Promise.all([t.get(appRef), t.get(userRef)]);
      const priorApp = appSnap.exists ? ((appSnap.data() as Record<string, any>) || {}) : null;
      const priorUser = userSnap.exists ? ((userSnap.data() as Record<string, any>) || {}) : null;
      if (!isReappliableApplication(priorApp, priorUser)) {
        return { allowed: false, status: typeof priorApp?.status === 'string' ? priorApp.status : '' } as GateOutcome;
      }
      t.set(appRef, applicationData);
      t.set(userRef, flagUpdate, { merge: true });
      return { allowed: true, priorApp, priorUser } as GateOutcome;
    });
  } catch (err) {
    console.error('[api/induction/submit] gate transaction failed:', err);
    return fail(500, 'Submission failed');
  }

  if (!gate.allowed) {
    return NextResponse.json(
      {
        error: 'You have already submitted an application. It cannot be replaced while it is under review or decided.',
        code: 'ALREADY_APPLIED',
        existingStatus: gate.status || null,
      },
      { status: 409 },
    );
  }

  try {
    const primaryWritten = await setApplicationPrimaryFirst(uid, applicationData);
    if (!primaryWritten) {
      await mirrorApplicationSet(uid, applicationData);
    }
  } catch (err) {
    console.error('[api/induction/submit] Supa write failed after gate commit; compensating Firestore:', err);
    // Compensation: restore the pre-submit Firestore snapshots so a
    // failed primary write does not leave a submission the primary
    // store never saw (the pre-SEC-RACE primacy contract: adapter
    // failure = no submission). Best-effort; a failure here is logged
    // and the gate still protects the landed application.
    try {
      if (gate.priorApp) {
        await appRef.set(gate.priorApp);
      } else {
        await appRef.delete();
      }
      if (gate.priorUser) {
        const restoreUser: Record<string, any> = {};
        for (const key of ['hasApplied', 'applicationStatus', 'updatedAt'] as const) {
          restoreUser[key] = key in gate.priorUser ? gate.priorUser[key] : FieldValue.delete();
        }
        await userRef.set(restoreUser, { merge: true });
      } else {
        await userRef.delete();
      }
    } catch (compErr) {
      console.error('[api/induction/submit] Firestore compensation failed:', compErr);
    }
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
