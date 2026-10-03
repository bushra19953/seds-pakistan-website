import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission, resolveUserRole } from '@/lib/server/permissions';

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
    const role = await resolveUserRole(getDb()!, userId);
    if (!(await hasServerPermission(role, 'canManageBugReports'))) {
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
    const role = await resolveUserRole(getDb()!, adminUid);
    if (!(await hasServerPermission(role, 'canManageBugReports'))) {
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
        // Award points atomically + ledger entry (idempotent per report)
        const userRef = db.collection('users').doc(reporterUid);
        const ledgerRef = db.collection('points_ledger').doc();
        const batch = db.batch();
        batch.set(userRef, {
          points: admin.firestore.FieldValue.increment(pointsToAward),
          total_points: admin.firestore.FieldValue.increment(pointsToAward),
        }, { merge: true });
        batch.set(ledgerRef, {
          user_id: reporterUid,
          reason: 'bug_report_valid',
          action: 'BUG_BOUNTY',
          points_awarded: pointsToAward,
          bug_report_id: reportId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: 'PROCESSED',
        });
        updates.pointsAwarded = pointsToAward;
        updates.pointsAwardedAt = new Date();
        updates.pointsAwardedBy = adminUid;
        batch.update(reportRef, updates);
        await batch.commit();
        pointsAwarded = pointsToAward;
        return NextResponse.json({ success: true, pointsAwarded });
      }
    }

    await reportRef.update(updates);
    return NextResponse.json({ success: true, pointsAwarded });
  } catch (error) {
    console.error('[bug-reports] PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
  }
}
