import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import {
  runInductionSubmitGate,
  mirrorApplicationSet,
  mirrorDeleteDoc,
  mirrorMergeSetDoc,
  APPLICATIONS_COLLECTION,
  USERS_COLLECTION,
  SUPA_DELETE_FIELD,
  type InductionSubmitGateResult,
} from '@/lib/applications-supa';

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
 *   - THE GUARDED-KEY STRIP: the page strips uid/email/reviewed_by/
 *     rejection_reason/reviewed_at/pre_score/role/isAdmin from the
 *     form payload before spreading; the route strips the same keys
 *     again and then stamps uid/email from the verified token AFTER
 *     the spread, so no form field can override them. status is
 *     forced to 'pending' (a resubmission always re-enters the queue).
 *   - THE INTAKE-WINDOW STAMP: applicationData.intakeWindowId arrives
 *     in the body (the page resolved the fresh window and stamped it
 *     after its spread) and passes through untouched.
 *   - THE SUBMIT GATE (SEC-RACE hasApplied gate, audit item 11): the
 *     old flow replaced applications/{uid} unconditionally, so a
 *     re-POST overwrote the caller's own application and reset a
 *     reviewed state back to 'pending'; the hasApplied guard existed
 *     only client-side. The gate is now ONE Postgres transaction
 *     (tx_applications_submit_gate: per-uid advisory lock, priors
 *     re-read from fs_applications + fs_users under the lock, the
 *     isReappliableApplication rule ported verbatim into the Postgres
 *     function, fs_applications upsert as the primary write). The
 *     rule now lives in tx_applications_submit_gate — there is no
 *     dead TS copy of it in this route. This route performs ZERO
 *     Firestore reads: the previous Firestore gate re-read both docs
 *     on every submission and died whenever the Firestore read quota
 *     was exhausted, while Firestore writes stayed healthy; getDb()
 *     here only builds refs for writes. A denied gate (outcome
 *     'already_applied') returns the 409 below with zero writes to
 *     either store.
 *   - FIRESTORE AS MIRROR ONLY: after the gate commits, Firestore is
 *     written after, as mirror only (application set + users flag
 *     set-merge). A mirror failure compensates both stores from the
 *     tx-returned priors, best-effort, so a 500 still means "no new
 *     submission" as closely as the old design could promise.
 *   - Named residuals: (i) the fs_users flag the gate reads reaches
 *     that table via the users mirror of the Firestore flag write,
 *     and the re-apply clear is mirrored synchronously by the
 *     reapply route (mirrorInductionFlagClear) — the gate never
 *     writes fs_users; (ii) applications that exist only in
 *     Firestore (pre-backfill migration stragglers) are invisible to
 *     the gate until the dump-refresh backfill lands.
 *   - The post-submit audit entry ('application_submitted',
 *     logAuditEntry's stored shape), best-effort, as the page's
 *     guarded post-submit block was.
 *
 * REPLICA PARITY: the batch bypassed the wrapper, so the page fired
 * its two explicit fireWebhook dispatches itself — it STILL DOES,
 * unchanged, after this route returns; the dispatch payloads are
 * byte-identical to today's, so the replica's effects
 * (universal_submissions sync for applications; the users dispatch,
 * whose after-image is a partial {uid, ...flagUpdate} the replica's
 * change-gated arms no-op on) are preserved by the page, not
 * re-implemented here.
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
 * Restore a tx-returned prior application into the shape the
 * Firestore mirror wants: a shallow copy whose timestamp fields are
 * Dates again. The tx priors come back from jsonb / adapter
 * rehydration, so timestamp fields are ISO strings or Timestamp-like
 * objects; Firestore wants Dates.
 */
function restoreShape(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...data };
  for (const key of ['created_at', 'updated_at', 'last_saved_at'] as const) {
    const value = out[key];
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) out[key] = new Date(ms);
    } else if (value && typeof value === 'object' && typeof value.toDate === 'function') {
      out[key] = value.toDate();
    }
  }
  return out;
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

  // SUBMIT GATE: one Postgres transaction (see the header). The gate
  // is the single serialization point for submits, and it performs
  // the only reads in this flow — from Postgres, never Firestore.
  let gate: InductionSubmitGateResult;
  try {
    gate = await runInductionSubmitGate(uid, applicationData);
  } catch (err) {
    console.error('[api/induction/submit] Supa submit gate failed:', err);
    return fail(500, 'Submission failed');
  }

  if (gate.outcome === 'already_applied') {
    return NextResponse.json(
      {
        error: 'You have already submitted an application. It cannot be replaced while it is under review or decided.',
        code: 'ALREADY_APPLIED',
        existingStatus: gate.existingStatus || null,
      },
      { status: 409 },
    );
  }

  // Firestore MIRROR writes (writes only): the application set plus
  // the users flag set-merge, mirroring the gate's committed primary
  // write.
  try {
    await appRef.set(applicationData);
    await userRef.set(flagUpdate, { merge: true });
  } catch (err) {
    console.error('[api/induction/submit] Firestore mirror write failed; compensating:', err);
    // Compensation, best-effort: restore both stores from the
    // tx-returned priors so a failed mirror does not leave a
    // submission standing. Each step is independently try/caught and
    // logged; mirror helpers never throw, but the wrapping keeps a
    // compensation failure from masking the 500.
    if (gate.applied) {
      try {
        if (gate.priorApp) {
          await mirrorApplicationSet(uid, gate.priorApp);
        } else {
          await mirrorDeleteDoc(APPLICATIONS_COLLECTION, uid);
        }
      } catch (compErr) {
        console.error('[api/induction/submit] Supa application rollback failed:', compErr);
      }
      try {
        const flagRestore: Record<string, any> = {};
        for (const key of ['hasApplied', 'applicationStatus', 'updatedAt'] as const) {
          flagRestore[key] =
            gate.priorUser && key in gate.priorUser ? gate.priorUser[key] : SUPA_DELETE_FIELD;
        }
        await mirrorMergeSetDoc(USERS_COLLECTION, uid, flagRestore);
      } catch (compErr) {
        console.error('[api/induction/submit] Supa users flag rollback failed:', compErr);
      }
    }
    try {
      if (gate.priorApp) {
        await appRef.set(restoreShape(gate.priorApp));
      } else {
        await appRef.delete();
      }
    } catch (compErr) {
      console.error('[api/induction/submit] Firestore application rollback failed:', compErr);
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
