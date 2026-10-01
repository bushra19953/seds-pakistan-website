import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getEmailQuotaStatus } from '@/lib/mailer';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';

/**
 * GET: Fetch recent email logs for admin review.
 * Only superadmin/president can view by default, but now dynamic.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userRole = (auth.user as any).role || '';
    const canView = await hasServerPermission(userRole, 'canViewEmailLogs');
    if (!canView) {
      return NextResponse.json({ error: 'Forbidden: Insufficient permissions to view email logs' }, { status: 403 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const url = new URL(request.url);
    const limitParam = parseInt(url.searchParams.get('limit') || '50');
    const safeLimit = Math.min(Math.max(limitParam, 1), 200);

    const snapshot = await db.collection('email_logs')
      .orderBy('sentAt', 'desc')
      .limit(safeLimit)
      .get();

    const logs = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      sentAt: doc.data().sentAt?.toDate?.() || doc.data().sentAt,
    }));

    const quota = getEmailQuotaStatus();

    return NextResponse.json({ logs, quota });
  } catch (error) {
    console.error('[email-logs] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch email logs' }, { status: 500 });
  }
}

/**
 * POST: Send a test email to verify the integration works.
 * Body: { to: string }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userRole = (auth.user as any).role || '';
    const canManage = await hasServerPermission(userRole, 'canViewEmailLogs'); // Reusing same permission for management/test
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: Insufficient permissions to send test emails' }, { status: 403 });
    }

    const body = await request.json();
    const { to } = body;

    if (!to || typeof to !== 'string' || !to.includes('@')) {
      return NextResponse.json({ error: 'Valid email address required' }, { status: 400 });
    }

    const { sendEmailNotification } = await import('@/lib/mailer');

    const result = await sendEmailNotification(to, 'task_assigned', {
      recipientName: 'Admin',
      taskTitle: 'Test Email — Integration Check',
      taskLink: '/admin/email-logs',
      actorName: 'SEDS System',
      dueDate: new Date().toLocaleDateString(),
    });

    return NextResponse.json({
      success: result.success,
      error: result.error,
      message: result.success
        ? `Test email sent to ${to}`
        : `Email failed: ${result.error}`,
    });
  } catch (error) {
    console.error('[email-logs] POST test error:', error);
    return NextResponse.json({ error: 'Failed to send test email' }, { status: 500 });
  }
}
