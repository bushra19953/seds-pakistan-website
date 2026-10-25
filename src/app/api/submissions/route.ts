import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import * as admin from 'firebase-admin';
import { DEFAULT_SUBMISSION_POINTS, SubmissionType } from '@/lib/submission-types';
import { mirrorSubmissionReview } from '@/lib/supa/seam-submissions';
import {
    mirrorNotificationCreate,
    userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';

export const dynamic = 'force-dynamic';

/**
 * GET - List submissions
 * Query params:
 *   - status: 'pending' | 'approved' | 'rejected' | 'all'
 *   - userId: filter by submitter (for member's own submissions)
 *   - limit: number (default 50)
 */
export async function GET(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status') || 'all';
        const userId = searchParams.get('userId');
        const limitParam = searchParams.get('limit');
        const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

        const userRole = auth.user.role;
        // auth.user.role is canonical-normalized at check time (spec step 03,
        // map aligned in ba0d4cd), so the legacy allow-list below is compared
        // in canonical space too (both sides normalized): admin->superadmin,
        // president->chapter_president, vp->national_vp_operations.
        // NOTE: tokens that unify to 'national_vp_operations' (vice_president,
        // general_secretary, chair_events, secretary, national_vice_president)
        // now pass this check; only 'vp' did before. No existing admin loses access.
        const isAdmin = ['superadmin', 'founder_patron', 'chapter_president', 'national_vp_operations'].includes(userRole || '');

        // Build query
        let query: admin.firestore.Query = db.collection('submissions');

        // Non-admins can only see their own submissions
        if (!isAdmin) {
            query = query.where('userId', '==', auth.user.userId);
        } else if (userId) {
            query = query.where('userId', '==', userId);
        }

        if (status !== 'all') {
            query = query.where('status', '==', status);
        }

        query = query.orderBy('submittedAt', 'desc').limit(limit);

        const snapshot = await query.get();
        const submissions = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            submittedAt: doc.data().submittedAt?.toDate?.()?.toISOString() || null,
            reviewedAt: doc.data().reviewedAt?.toDate?.()?.toISOString() || null,
            deadline: doc.data().deadline?.toDate?.()?.toISOString() || null
        }));

        return NextResponse.json({
            success: true,
            submissions,
            count: submissions.length
        });

    } catch (error: any) {
        console.error('[submissions] GET Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/**
 * POST - Create new submission
 * Body: {
 *   type: 'competition' | 'opportunity' | 'resource' | 'other',
 *   title: string,
 *   url: string,
 *   description?: string,
 *   deadline?: string (ISO),
 *   organization?: string,
 *   tags?: string[]
 * }
 */
export async function POST(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        const body = await req.json();
        const { type, title, url, description, deadline, organization, tags } = body;

        // Validation
        if (!type || !title || !url) {
            return NextResponse.json({ error: 'Missing required fields: type, title, url' }, { status: 400 });
        }

        const validTypes = ['competition', 'opportunity', 'resource', 'other'];
        if (!validTypes.includes(type)) {
            return NextResponse.json({ error: 'Invalid submission type' }, { status: 400 });
        }

        // Basic URL validation
        try {
            new URL(url);
        } catch {
            return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
        }

        // Check for duplicate URL (optional - warn but allow)
        const existingQuery = await db.collection('submissions')
            .where('url', '==', url)
            .limit(1)
            .get();

        let duplicateWarning = false;
        if (!existingQuery.empty) {
            duplicateWarning = true;
        }

        // Get user info
        const userDoc = await db.collection('users').doc(auth.user.userId).get();
        const userData = userDoc.data();

        // Create submission
        const submissionRef = db.collection('submissions').doc();
        const submissionData = {
            userId: auth.user.userId,
            userDisplayName: userData?.displayName || auth.user.email || 'Unknown',
            userEmail: auth.user.email || '',
            type,
            title: String(title).trim(),
            url: String(url).trim(),
            description: description ? String(description).trim() : null,
            deadline: deadline ? admin.firestore.Timestamp.fromDate(new Date(deadline)) : null,
            organization: organization ? String(organization).trim() : null,
            tags: Array.isArray(tags) ? tags.map(t => String(t).trim()) : [],
            status: 'pending',
            submittedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await submissionRef.set(submissionData);

        // Notify admins about new submission
        try {
            const adminsQuery = await db.collection('roles')
                .where('role', 'in', ['admin', 'superadmin', 'president', 'founder_patron'])
                .limit(10)
                .get();

            const batch = db.batch();
            // GAP-N1: queued notification mirrors, flushed only after the
            // batch commit succeeds (flag-gated, non-throwing).
            const notifMirrors: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];
            for (const adminDoc of adminsQuery.docs) {
                const notifRef = db.collection('users').doc(adminDoc.id).collection('notifications').doc();
                const notifData = {
                    type: 'submission_pending',
                    title: 'New Submission',
                    body: `${userData?.displayName || 'A member'} submitted a ${type}: "${title}"`,
                    link: '/admin/submissions',
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                };
                batch.set(notifRef, notifData);
                notifMirrors.push({ uid: adminDoc.id, id: notifRef.id, data: notifData });
            }
            await batch.commit();
            for (const m of notifMirrors) {
                await mirrorNotificationCreate(userNotificationsPath(m.uid), m.id, m.data);
            }
        } catch { }

        return NextResponse.json({
            success: true,
            submissionId: submissionRef.id,
            duplicateWarning,
            message: 'Submission created successfully. It will be reviewed by an admin.'
        });

    } catch (error: any) {
        console.error('[submissions] POST Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

/**
 * PATCH - Review submission (admin only)
 * Body: {
 *   submissionId: string,
 *   action: 'approve' | 'reject',
 *   reviewNotes?: string,
 *   pointsToAward?: number,
 *   addToCompetitions?: boolean
 * }
 */
export async function PATCH(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Admin only
        const userRole = auth.user.role;
        // auth.user.role is canonical-normalized at check time (spec step 03,
        // map aligned in ba0d4cd), so the legacy allow-list below is compared
        // in canonical space too (both sides normalized): admin->superadmin,
        // president->chapter_president, vp->national_vp_operations.
        // NOTE: tokens that unify to 'national_vp_operations' (vice_president,
        // general_secretary, chair_events, secretary, national_vice_president)
        // now pass this check; only 'vp' did before. No existing admin loses access.
        const isAdmin = ['superadmin', 'founder_patron', 'chapter_president', 'national_vp_operations'].includes(userRole || '');
        if (!isAdmin) {
            return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 });
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        const body = await req.json();
        const { submissionId, action, reviewNotes, pointsToAward, addToCompetitions } = body;

        if (!submissionId || !action) {
            return NextResponse.json({ error: 'Missing submissionId or action' }, { status: 400 });
        }

        if (!['approve', 'reject'].includes(action)) {
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
        }

        // Get submission
        const submissionRef = db.collection('submissions').doc(submissionId);
        const submissionDoc = await submissionRef.get();

        if (!submissionDoc.exists) {
            return NextResponse.json({ error: 'Submission not found' }, { status: 404 });
        }

        const submission = submissionDoc.data()!;

        // Points-integrity guard (Item 4): a repeat review must not
        // re-award points. Clause 1: terminal status (approved/rejected)
        // blocks any further review. Clause 2: an approve when
        // pointsAwarded is already a positive number blocks even if the
        // status somehow stayed pending (legacy inconsistent shape).
        // Runs BEFORE the reviewer fetch and BEFORE any batch is created,
        // so a repeat queues no writes and overwrites no review stamps.
        {
            const priorStatus = typeof submission.status === 'string' ? submission.status.toLowerCase() : '';
            const isTerminal = priorStatus === 'approved' || priorStatus === 'rejected';
            const alreadyAwarded = action === 'approve' && typeof submission.pointsAwarded === 'number' && submission.pointsAwarded > 0;
            if (isTerminal || alreadyAwarded) {
                return NextResponse.json(
                    {
                        error: 'Submission already reviewed',
                        status: submission.status,
                        pointsAwarded: typeof submission.pointsAwarded === 'number' ? submission.pointsAwarded : 0,
                    },
                    { status: 409 },
                );
            }
        }

        // Get reviewer info
        const reviewerDoc = await db.collection('users').doc(auth.user.userId).get();
        const reviewerData = reviewerDoc.data();

        const batch = db.batch();

        // Supabase mirror capture (tasks surface): plain copies of the
        // decision's audit/competition payloads, filled in below where
        // the batch ops are built; mirrored after commit via the seam.
        let auditMirrorId: string | null = null;
        let auditMirrorData: Record<string, any> | null = null;
        let competitionMirrorData: Record<string, any> | null = null;

        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        const finalPoints = action === 'approve'
            ? (typeof pointsToAward === 'number' ? pointsToAward : DEFAULT_SUBMISSION_POINTS[submission.type as SubmissionType] || 10)
            : 0;

        // Update submission
        batch.update(submissionRef, {
            status: newStatus,
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedBy: auth.user.userId,
            reviewerDisplayName: reviewerData?.displayName || auth.user.email || 'Admin',
            reviewNotes: reviewNotes || null,
            pointsAwarded: finalPoints
        });

        // If approved, award points
        if (action === 'approve' && finalPoints > 0) {
            const userRef = db.collection('users').doc(submission.userId);
            batch.set(userRef, {
                points: admin.firestore.FieldValue.increment(finalPoints),
                submissionsApprovedCount: admin.firestore.FieldValue.increment(1)
            }, { merge: true });

            // Points audit
            const auditRef = db.collection('points_audit').doc();
            const auditData = {
                userId: submission.userId,
                delta: finalPoints,
                reason: 'submission_approved',
                submissionId,
                submissionTitle: submission.title,
                submissionType: submission.type,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                actorId: auth.user.userId
            };
            batch.set(auditRef, auditData);
            auditMirrorId = auditRef.id;
            auditMirrorData = {
                userId: auditData.userId,
                delta: auditData.delta,
                reason: auditData.reason,
                submissionId: auditData.submissionId,
                submissionTitle: auditData.submissionTitle,
                submissionType: auditData.submissionType,
                actorId: auditData.actorId
            };
        }

        // If approved and addToCompetitions, create competition entry
        let linkedCompetitionId: string | null = null;
        if (action === 'approve' && addToCompetitions && submission.type === 'competition') {
            const compRef = db.collection('competitions').doc();
            const compData = {
                title: submission.title,
                url: submission.url,
                description: submission.description || '',
                deadline: submission.deadline || null,
                organization: submission.organization || '',
                tags: submission.tags || [],
                submittedBy: submission.userId,
                submitterName: submission.userDisplayName,
                sourceSubmissionId: submissionId,
                status: 'active',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: auth.user.userId
            };
            batch.set(compRef, compData);
            competitionMirrorData = {
                title: compData.title,
                url: compData.url,
                description: compData.description,
                deadline: compData.deadline,
                organization: compData.organization,
                tags: compData.tags,
                submittedBy: compData.submittedBy,
                submitterName: compData.submitterName,
                sourceSubmissionId: compData.sourceSubmissionId,
                status: compData.status,
                createdBy: compData.createdBy
            };
            linkedCompetitionId = compRef.id;

            batch.update(submissionRef, {
                linkedCompetitionId: compRef.id
            });
        }

        // Notify submitter
        const notifRef = db.collection('users').doc(submission.userId).collection('notifications').doc();
        const notifEmoji = action === 'approve' ? '🎉' : '❌';
        const notifTitle = action === 'approve' ? 'Submission Approved!' : 'Submission Rejected';
        const notifBody = action === 'approve'
            ? `Your submission "${submission.title}" was approved! You earned ${finalPoints} points.`
            : `Your submission "${submission.title}" was not approved.${reviewNotes ? ` Reason: ${reviewNotes}` : ''}`;

        const notifData = {
            type: action === 'approve' ? 'points_awarded' : 'submission_rejected',
            title: `${notifEmoji} ${notifTitle}`,
            body: notifBody,
            link: `/profile`,
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        batch.set(notifRef, notifData);

        await batch.commit();

        // GAP-N1: mirror the submitter notification (mirrorSubmissionReview
        // below mirrors the submission/competition/audit docs only, never
        // this notification). Flag-gated, non-throwing; Firestore primary.
        await mirrorNotificationCreate(userNotificationsPath(submission.userId), notifRef.id, notifData);

        // Supabase mirror of the review decision (surface 'tasks', the
        // submissions-join surface). Firestore above is primary and
        // already committed; the seam is best-effort, gated on the
        // flag, and never throws, so a mirror failure cannot change
        // this response. No task doc is written by this route (see
        // supa-rebase-notes/tasks-5.md), so no task doc is mirrored;
        // the users.points increment is likewise not mirrored (an
        // increment has no safe absolute-value mirror).
        await mirrorSubmissionReview({
            submissionId,
            status: newStatus,
            reviewedBy: auth.user.userId,
            reviewerDisplayName: reviewerData?.displayName || auth.user.email || 'Admin',
            reviewNotes: reviewNotes || null,
            pointsAwarded: finalPoints,
            reviewedAtIso: new Date().toISOString(),
            linkedCompetitionId,
            competition: competitionMirrorData,
            auditId: auditMirrorId,
            audit: auditMirrorData
        });

        return NextResponse.json({
            success: true,
            action,
            pointsAwarded: finalPoints,
            linkedCompetitionId,
            message: action === 'approve'
                ? `Submission approved! ${finalPoints} points awarded.`
                : 'Submission rejected.'
        });

    } catch (error: any) {
        console.error('[submissions] PATCH Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
