import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isSupaPrimary } from '@/lib/supa/flags';
import { applyPointsAwardViaSupa } from '@/lib/supa/gamification';
import {
  flushPendingUsersPrimaryOps,
  type PendingUsersPrimaryOp,
} from '@/lib/server/supa-identity-primary';


export const dynamic = 'force-dynamic';

/**
 * GET: List all bug reports for management dashboard.
 * Requires `canManageBugReports` permission.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { userId } = auth.user as any;
    if (!(await hasServerPermissionForUser(getDb()!, userId, 'canManageBugReports'))) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const reportsSnap = await db.collection('bug_reports')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const reports = reportsSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.() || doc.data().createdAt,
    }));

    return NextResponse.json(reports);
  } catch (error) {
    console.error('[bug-reports] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch reports' }, { status: 500 });
  }
}

/**
 * PATCH: Update report status, add admin feedback notes, award points for valid bugs.
 * Body: { reportId, status?, adminNote?, awardPoints? }
 * - status: open | in-progress | resolved
 * - adminNote: feedback text appended to the report's note thread
 * - awardPoints: number > 0 — awards points to the reporter (once per report)
 */
export async function PATCH(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { userId: adminUid } = auth.user as any;
    if (!(await hasServerPermissionForUser(getDb()!, adminUid, 'canManageBugReports'))) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');
    const body = await request.json();
    const { reportId, status, adminNote, awardPoints } = body;

    if (!reportId) {
      return NextResponse.json({ error: 'ReportId required' }, { status: 400 });
    }

    const reportRef = db.collection('bug_reports').doc(reportId);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }
    const report = reportSnap.data() || {};
    const updates: Record<string, any> = { updatedAt: new Date() };

    if (status) {
      if (!['open', 'in-progress', 'resolved'].includes(status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      updates.status = status;
    }

    if (typeof adminNote === 'string' && adminNote.trim()) {
      updates.adminNotes = admin.firestore.FieldValue.arrayUnion({
        text: adminNote.trim(),
        byUid: adminUid,
        at: new Date(),
      });
    }

    let pointsAwarded = 0;
    const pointsToAward = Number(awardPoints);
    if (pointsToAward > 0 && !report.pointsAwarded) {
      const reporterUid = report.submittedByUid;
      if (reporterUid) {
        // C-07 guard swap: under gamification Supa-primary, the
        // report's pointsAwarded flag is backed by the deterministic
        // RPC claim pa_<reportId>_<reporterUid>_BUG_BOUNTY. Claim
        // first: applied => stamp the report and return; duplicate =>
        // the bounty was already claimed on the Supa side, so fall
        // through to the plain report update with no award (the same
        // outcome the flag-set path produces); null => the RPC rolled
        // back, so the Firestore batch below runs exactly as today.
        let supaAwardHandled = false;
        if (isSupaPrimary('gamification')) {
          const awardResult = await applyPointsAwardViaSupa({
            taskId: reportId,
            userId: reporterUid,
            action: 'BUG_BOUNTY',
            reason: 'bug_report_valid',
            points: pointsToAward,
          });
          if (awardResult && awardResult.applied) {
            updates.pointsAwarded = pointsToAward;
            updates.pointsAwardedAt = new Date();
            updates.pointsAwardedBy = adminUid;
            await reportRef.update(updates);
            pointsAwarded = pointsToAward;
            return NextResponse.json({ success: true, pointsAwarded });
          }
          if (awardResult && awardResult.duplicate) {
            supaAwardHandled = true;
          }
        }
        if (!supaAwardHandled) {
        // Award points atomically + ledger entry (idempotent per report).
        // SEC-RACE (audit item 11): the old code checked
        // report.pointsAwarded on a snapshot read BEFORE a plain
        // WriteBatch, so two concurrent approvals could both pass the
        // check and both increment. The award now runs inside
        // runTransaction — the same pattern as
        // gamification-transaction.ts: the transaction re-reads the
        // report, and the flag check, the user increment, the ledger
        // entry and the report stamp commit or fail together.
        // Firestore serializes transactions touching the report doc,
        // so exactly one concurrent approval can win the award; the
        // loser re-reads pointsAwarded inside its transaction and
        // returns the already-awarded result as a no-op. The ledger
        // doc id is deterministic per report (bug_bounty_<reportId>),
        // mirroring the Supa RPC claim id
        // pa_<reportId>_<reporterUid>_BUG_BOUNTY, so even a lost flag
        // stamp can never produce a second ledger entry.
        const userRef = db.collection('users').doc(reporterUid);
        const ledgerRef = db.collection('points_ledger').doc(`bug_bounty_${reportId}`);
        const pointsPayload = {
          points: admin.firestore.FieldValue.increment(pointsToAward),
          total_points: admin.firestore.FieldValue.increment(pointsToAward),
        };
        const outcome = await db.runTransaction(async (t) => {
          const freshSnap = await t.get(reportRef);
          if (!freshSnap.exists) return { kind: 'missing' as const };
          const fresh = freshSnap.data() || {};
          if (fresh.pointsAwarded) {
            return { kind: 'already' as const, points: Number(fresh.pointsAwarded) || 0 };
          }
          if (!fresh.submittedByUid) return { kind: 'no-reporter' as const };
          const ledgerSnap = await t.get(ledgerRef);
          if (ledgerSnap.exists) {
            // The claim exists but the flag stamp was lost: re-stamp
            // the report from the ledger, never re-increment.
            const claimedPoints = Number(ledgerSnap.data()?.points_awarded) || 0;
            t.update(reportRef, {
              ...updates,
              pointsAwarded: claimedPoints,
              pointsAwardedAt: new Date(),
              pointsAwardedBy: adminUid,
            });
            return { kind: 'already' as const, points: claimedPoints };
          }
          t.set(userRef, pointsPayload, { merge: true });
          t.set(ledgerRef, {
            user_id: reporterUid,
            reason: 'bug_report_valid',
            action: 'BUG_BOUNTY',
            points_awarded: pointsToAward,
            bug_report_id: reportId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            status: 'PROCESSED',
          });
          t.update(reportRef, {
            ...updates,
            pointsAwarded: pointsToAward,
            pointsAwardedAt: new Date(),
            pointsAwardedBy: adminUid,
          });
          return { kind: 'awarded' as const };
        });
        if (outcome.kind === 'missing') {
          return NextResponse.json({ error: 'Report not found' }, { status: 404 });
        }
        if (outcome.kind === 'already') {
          // No-op: return the already-awarded result.
          return NextResponse.json({ success: true, pointsAwarded: outcome.points });
        }
        if (outcome.kind === 'awarded') {
          // WRITE PRIMACY (G-USER-5, U-34): under users Supa-primary
          // the same increment payload is flushed to the adapter as
          // the primary RMW; the transaction's native increments are
          // the reverse mirror. The flush runs only for the winning
          // claim (flushing before the claim would let a concurrent
          // loser double-apply the primary increment). A flush failure
          // is logged loudly for operator replay: the Firestore award
          // has already committed exactly once, so failing the request
          // would invite a retry that can only no-op.
          // (The gamification-primary branch above is a different
          // surface's award path — X-06/H-01, untouched.)
          try {
            await flushPendingUsersPrimaryOps([{ uid: reporterUid, payload: pointsPayload }]);
          } catch (flushErr) {
            console.error('[bug-reports] users-primary flush failed after committed award; award needs operator replay:', flushErr);
          }
          pointsAwarded = pointsToAward;
          return NextResponse.json({ success: true, pointsAwarded });
        }
        // 'no-reporter': fall through to the plain report update,
        // exactly as the pre-fix flow did when no reporter resolved.
        }
      }
    }

    await reportRef.update(updates);
    return NextResponse.json({ success: true, pointsAwarded });
  } catch (error) {
    console.error('[bug-reports] PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
  }
}

/**
 * DELETE: Permanently remove a bug report.
 * Query: ?reportId=<id>
 * Requires `canManageBugReports` permission.
 * (Ported from the retired /admin/bugs page, which deleted client-direct.)
 */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { userId } = auth.user as any;
    if (!(await hasServerPermissionForUser(getDb()!, userId, 'canManageBugReports'))) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const reportId = request.nextUrl.searchParams.get('reportId');
    if (!reportId) {
      return NextResponse.json({ error: 'ReportId required' }, { status: 400 });
    }

    const reportRef = db.collection('bug_reports').doc(reportId);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }

    await reportRef.delete();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[bug-reports] DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete report' }, { status: 500 });
  }
}
