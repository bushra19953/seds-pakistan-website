import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { stageHistoryKeyForStatus } from '@/lib/applicant-status';
import {
  getApplicationRecord,
  mirrorApplicationUpdate,
  resolveApplicationsSupaAdapter,
  updateApplicationPrimaryFirst,
} from '@/lib/applications-supa';
import { syncApplicationUniversalSubmission } from '@/lib/server/universal-submissions-sync';

/**
 * POST /api/admin/applications/status — WS10 routes for the admin
 * applications page's two client-direct write points, the named
 * applications-primacy flip-blockers A2 and A3 (apps-primacy census):
 *
 *   op 'status' (A2) — the non-approve status write
 *   (updateApplicationStatus: shortlist / reject / under_review /
 *   on_hold). Approve itself already goes through universal-review.
 *   op 'post-approve-sync' (A3) — the post-approve stage stamp plus
 *   the users-doc decision mirror + audit entry the page applied
 *   after universal-review landed the approval.
 *
 * Effects per op, in the page's order:
 *   1. applications/{id} update through the applications seam's flag
 *      law (A4 pattern): under primacy the adapter write lands FIRST
 *      via updateApplicationPrimaryFirst (throws → 500, zero
 *      Firestore writes) and Firestore follows best-effort; in
 *      dual-write Firestore is primary and mirrorApplicationUpdate
 *      follows. The update payload is the page's exact payload
 *      (status, reviewedAt/reviewedBy, reviewNotes, rejection_reason,
 *      stageHistory.<key> dot-path stamp).
 *   2. universal_submissions sync — REPLICA PARITY: the client
 *      updateDoc dispatched through firestore-wrapper to the webhook
 *      replica's handleSubmissionsSyncRoute, which upserts
 *      universal_submissions/applications_{id}. Admin writes fire no
 *      dispatch, so this route owns the sync explicitly via
 *      syncApplicationUniversalSubmission (a faithful port of the
 *      replica's applications branch) over the post-write doc read
 *      back from the primary store.
 *   3. The page's decision mirror + audit (mirrorDecisionToUserAndAudit),
 *      both best-effort in the page and here: users/{id} update
 *      {applicationStatus, hasApplied:false on rejection, updatedAt}
 *      and the audit_logs entry 'application_status_updated' in
 *      logAuditEntry's stored shape (undefined payload keys stripped,
 *      as its sanitize does). The users write stays Firestore-only,
 *      cross-cluster, exactly as the A4 route rules its users mirror —
 *      and its old wrapper dispatch is provably inert for this
 *      payload: handleUserWritten's arms are change-gated on
 *      points/badges/leaderboard fields/chapterId/email, none of
 *      which this write changes (the one doc-state-dependent arm,
 *      the email_lowercase hygiene fix-up, is not caused by these
 *      fields and stays reachable through every other users write).
 *
 * Gate: verified session + canManageApplications (the page's
 * AuthorizationGate and universal-review's permission for this
 * collection). op 'status' failures surface as errors (the page
 * toasts and rethrows, as its updateDoc failure did);
 * op 'post-approve-sync' keeps the page's best-effort contract: it
 * returns 200 with per-step flags and never masks the approval that
 * already landed in universal-review.
 */

export const dynamic = 'force-dynamic';

function fail(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

function serverTimestamp(): unknown {
  return FieldValue.serverTimestamp();
}

/** logAuditEntry's sanitize: drop undefined values at any depth. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)).filter((v) => v !== undefined) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      const sv = stripUndefined(v);
      if (sv !== undefined) out[k] = sv;
    }
    return out as T;
  }
  return value;
}

/**
 * Apply an applications update under the surface's flag law (the A4
 * pattern). Returns true when primacy wrote the adapter first.
 * Throws on a primary failure (primacy adapter failure / missing row,
 * or the dual-write Firestore update) — callers decide fatality.
 * MIRROR LOUDNESS (P1): mirror failures are FATAL to this helper in
 * both arms — in the primacy arm the Firestore mirror update's error
 * is logged and rethrown, and in the dual-write arm a resolved
 * adapter whose mirror update reports failure throws. (When no
 * adapter resolves — surface flag OFF / Supabase unconfigured — the
 * mirror is a no-op by the seam contract and nothing throws: the
 * Firestore-only path stays byte-identical.) Callers decide what the
 * throw means for their response: the 'status' op surfaces it as its
 * 500; 'post-approve-sync' catches it and reports stamped=false.
 */
async function applyApplicationUpdate(
  db: NonNullable<ReturnType<typeof getDb>>,
  applicationId: string,
  update: Record<string, any>,
): Promise<boolean> {
  const primaryWritten = await updateApplicationPrimaryFirst(applicationId, update);
  if (primaryWritten) {
    try {
      await db.collection('applications').doc(applicationId).update(update);
    } catch (mirrorErr) {
      console.error('[api/admin/applications/status] Firestore mirror update failed after primary write:', mirrorErr);
      throw mirrorErr;
    }
  } else {
    await db.collection('applications').doc(applicationId).update(update);
    const adapter = await resolveApplicationsSupaAdapter();
    if (adapter) {
      const mirrored = await mirrorApplicationUpdate(applicationId, update);
      if (!mirrored) {
        throw new Error(`[api/admin/applications/status] Supabase mirror update failed for applications/${applicationId}`);
      }
    }
  }
  return primaryWritten;
}

/** Post-write doc from the primary store (A4's read-back rule). */
async function readAfter(
  db: NonNullable<ReturnType<typeof getDb>>,
  applicationId: string,
  primaryWritten: boolean,
): Promise<Record<string, any> | null> {
  try {
    if (primaryWritten) {
      const adapter = await resolveApplicationsSupaAdapter();
      if (adapter) {
        const record = await getApplicationRecord(adapter, applicationId);
        if (record) return record as Record<string, any>;
      }
    }
    const snap = await db.collection('applications').doc(applicationId).get();
    return snap.exists ? ((snap.data() ?? {}) as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** The page's mirrorDecisionToUserAndAudit, server-side. Never throws. */
async function mirrorDecisionToUserAndAudit(
  db: NonNullable<ReturnType<typeof getDb>>,
  actorUid: string,
  applicationId: string,
  status: string,
  reason?: string,
): Promise<void> {
  try {
    await db.collection('users').doc(applicationId).update({
      applicationStatus: status,
      ...(status === 'rejected' ? { hasApplied: false } : {}),
      updatedAt: serverTimestamp(),
    });
  } catch (mirrorErr) {
    console.warn('Could not mirror application status to user doc:', mirrorErr);
  }
  try {
    await db.collection('audit_logs').add(
      stripUndefined({
        action: 'application_status_updated',
        actorUid,
        targetUidOrResource: applicationId,
        payload: { new_status: status, rejection_reason: reason },
        timestamp: serverTimestamp(),
      }),
    );
  } catch (auditErr) {
    console.warn('Audit logging failed (non-fatal):', auditErr);
  }
}

export async function POST(req: NextRequest) {
  if (!ensureAdminInitialized()) return fail(500, 'Server misconfiguration');
  const auth = await verifyAuthentication(req);
  if (!auth.authenticated || !auth.user) return fail(401, 'Unauthorized');
  const db = getDb();
  if (!db) return fail(500, 'Server misconfiguration');
  let allowed = false;
  try {
    allowed = await hasServerPermissionForUser(db as never, auth.user.userId, 'canManageApplications');
  } catch {
    allowed = false;
  }
  if (!allowed) return fail(403, 'Forbidden');

  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  const applicationId = typeof body.applicationId === 'string' ? body.applicationId : '';
  if (!applicationId) return fail(400, 'applicationId is required');
  const actorUid = auth.user.userId;

  if (body.op === 'status') {
    const status = typeof body.status === 'string' ? body.status : '';
    if (!status) return fail(400, 'status is required');
    const reason = typeof body.reason === 'string' && body.reason ? body.reason : undefined;
    try {
      const stageHistoryKey = stageHistoryKeyForStatus(status);
      const update: Record<string, any> = {
        status,
        reviewedAt: serverTimestamp(),
        reviewedBy: actorUid,
        reviewNotes: reason || null,
        rejection_reason: reason || null,
        ...(stageHistoryKey ? { [`stageHistory.${stageHistoryKey}`]: serverTimestamp() } : {}),
      };
      const primaryWritten = await applyApplicationUpdate(db, applicationId, update);
      const after = await readAfter(db, applicationId, primaryWritten);
      await syncApplicationUniversalSubmission(db, applicationId, after);
      await mirrorDecisionToUserAndAudit(db, actorUid, applicationId, status, reason);
      return NextResponse.json({ ok: true });
    } catch (err) {
      console.error('[api/admin/applications/status] status update failed:', err);
      return fail(500, 'Failed to update application status');
    }
  }

  if (body.op === 'post-approve-sync') {
    // A3: every step best-effort (the page wrapped the whole block in
    // a warn-only catch). Report per-step outcomes; always 200.
    let stamped = false;
    try {
      const stageHistoryKey = stageHistoryKeyForStatus('approved');
      if (stageHistoryKey) {
        const update = { [`stageHistory.${stageHistoryKey}`]: serverTimestamp() };
        const primaryWritten = await applyApplicationUpdate(db, applicationId, update);
        stamped = true;
        const after = await readAfter(db, applicationId, primaryWritten);
        await syncApplicationUniversalSubmission(db, applicationId, after);
      }
    } catch (stampErr) {
      console.warn('Could not stamp approval stage history:', stampErr);
    }
    await mirrorDecisionToUserAndAudit(db, actorUid, applicationId, 'approved');
    return NextResponse.json({ ok: true, stamped });
  }

  return fail(400, 'Invalid op');
}
