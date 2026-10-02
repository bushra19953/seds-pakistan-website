import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasPermissionForRole } from '@/config/permissions.config';

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

    const { role } = auth.user as any;
    if (!hasPermissionForRole(role, 'canManageBugReports')) {
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
 * PATCH: Update report status (e.g., resolved, in-progress).
 */
export async function PATCH(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { role } = auth.user as any;
    if (!hasPermissionForRole(role, 'canManageBugReports')) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');
    const body = await request.json();
    const { reportId, status } = body;

    if (!reportId || !status) {
      return NextResponse.json({ error: 'ReportId and status required' }, { status: 400 });
    }

    await db.collection('bug_reports').doc(reportId).update({
      status,
      updatedAt: new Date(),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[bug-reports] PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
  }
}
