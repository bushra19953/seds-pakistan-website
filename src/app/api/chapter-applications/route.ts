import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { updateChapterApplicationStatus, deleteChapterWithCleanup } from '@/app/actions/chapter-applications';
import { notificationService } from '@/lib/server/notification-service';
import { hasServerPermission } from '@/lib/server/permissions';
import { permissionsConfig } from '@/config/permissions.config';

async function verifyAdmin(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const token = authHeader.split('Bearer ')[1];
  if (!ensureAdminInitialized()) throw Object.assign(new Error('Server error'), { status: 500 });
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}

// GET: List chapter applications (with optional status filter)
export async function GET(request: NextRequest) {
  try {
    const decoded = await verifyAdmin(request);
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const userRole = decoded.role || 'member';
    const canManage = await hasServerPermission(userRole, 'canManageChapterApplications');

    if (!canManage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const url = new URL(request.url);
    const statusFilter = url.searchParams.get('status');

    let q = db.collection('chapter_applications').orderBy('createdAt', 'desc');
    if (statusFilter && statusFilter !== 'all') {
      q = q.where('status', '==', statusFilter) as any;
    }

    const snap = await q.limit(100).get();
    const applications = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null,
        reviewedAt: data.reviewedAt?.toDate?.()?.toISOString() || null,
      };
    });

    return NextResponse.json({ applications });
  } catch (err: any) {
    console.error('[chapter-applications API] GET error:', err);
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}

// PATCH: Update application status (approve/reject/request-info)
export async function PATCH(request: NextRequest) {
  try {
    const decoded = await verifyAdmin(request);
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const userRole = decoded.role || 'member';
    const canManage = await hasServerPermission(userRole, 'canManageChapterApplications');

    if (!canManage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await request.json();
    const { applicationId, status, rejectionReason, adminNotes, infoRequestMessage } = body;

    if (!applicationId || !status) {
      return NextResponse.json({ error: 'applicationId and status are required' }, { status: 400 });
    }

    const validStatuses = ['under_review', 'approved', 'rejected', 'info_requested'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
    }

    // Execute the status update (with auto-chapter-creation on approval)
    const result = await updateChapterApplicationStatus(applicationId, status, decoded.uid, {
      rejectionReason,
      adminNotes,
      infoRequestMessage,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // Fetch application data for notifications
    const appDoc = await db.collection('chapter_applications').doc(applicationId).get();
    const appData = appDoc.data();
    const applicantId = appData?.applicantId;
    const chapterName = appData?.proposedChapterName || 'your chapter';

    // Send notifications based on status
    if (applicantId) {
      const notifMap: Record<string, { title: string; body: string; priority: 'P0' | 'P1' | 'P2' }> = {
        approved: {
          title: '🎉 Chapter Application Approved!',
          body: `Congratulations! Your application for "${chapterName}" has been approved. Your chapter has been officially registered with SEDS.`,
          priority: 'P1',
        },
        rejected: {
          title: '📋 Chapter Application Update',
          body: `Your application for "${chapterName}" was not approved.${rejectionReason ? ` Reason: ${rejectionReason}` : ''} Contact us for more details.`,
          priority: 'P1',
        },
        info_requested: {
          title: '📝 Additional Information Requested',
          body: `We need more information about your "${chapterName}" application.${infoRequestMessage ? ` Details: ${infoRequestMessage}` : ''} Please check your application.`,
          priority: 'P1',
        },
        under_review: {
          title: '🔍 Application Under Review',
          body: `Your "${chapterName}" chapter application is now being reviewed by our team. We'll update you soon.`,
          priority: 'P2',
        },
      };

      const notif = notifMap[status];
      if (notif) {
        notificationService.send(applicantId, {
          title: notif.title,
          body: notif.body,
          type: 'chapter_application',
          link: '/register-chapter',
        }, notif.priority).catch(err => console.error('[chapter-applications] Notification failed:', err));
      }
    }

    // Notify admins on approval (new chapter created)
    if (status === 'approved') {
      notificationService.broadcastByRoles(permissionsConfig.canManageChapterApplications, {
        title: '🏫 New Chapter Created',
        body: `"${chapterName}" has been approved and auto-created. Chapter ID: ${result.chapterId}`,
        type: 'chapter_application',
        link: '/admin/chapter-applications',
      }, 'P2').catch(err => console.error('[chapter-applications] Admin broadcast failed:', err));
    }

    return NextResponse.json({
      ok: true,
      applicationId,
      status,
      chapterId: result.chapterId,
    });
  } catch (err: any) {
    console.error('[chapter-applications API] PATCH error:', err);
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}

// DELETE: Delete a chapter with full cleanup (users, application, audit)
export async function DELETE(request: NextRequest) {
  try {
    const decoded = await verifyAdmin(request);
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const userRole = decoded.role || 'member';
    const canManage = await hasServerPermission(userRole, 'canManageChapterApplications');

    if (!canManage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await request.json();
    const { chapterId } = body;

    if (!chapterId) {
      return NextResponse.json({ error: 'chapterId is required' }, { status: 400 });
    }

    const result = await deleteChapterWithCleanup(chapterId, decoded.uid);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      chapterId,
      usersUpdated: result.usersUpdated,
    });
  } catch (err: any) {
    console.error('[chapter-applications API] DELETE error:', err);
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
