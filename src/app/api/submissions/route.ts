import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import * as admin from 'firebase-admin';
import { DEFAULT_SUBMISSION_POINTS, SubmissionType } from '@/lib/submission-types';

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
        const isAdmin = ['admin', 'superadmin', 'president', 'vp'].includes(userRole || '');

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
                .where('role', 'in', ['admin', 'superadmin', 'president'])
                .limit(10)
                .get();

            const batch = db.batch();
            for (const adminDoc of adminsQuery.docs) {
                const notifRef = db.collection('users').doc(adminDoc.id).collection('notifications').doc();
                batch.set(notifRef, {
                    type: 'submission_pending',
                    title: 'New Submission',
                    body: `${userData?.displayName || 'A member'} submitted a ${type}: "${title}"`,
                    link: '/admin/submissions',
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            await batch.commit();
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
        const isAdmin = ['admin', 'superadmin', 'president', 'vp'].includes(userRole || '');
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

        // Get reviewer info
        const reviewerDoc = await db.collection('users').doc(auth.user.userId).get();
        const reviewerData = reviewerDoc.data();

        const batch = db.batch();

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
            batch.set(auditRef, {
                userId: submission.userId,
                delta: finalPoints,
                reason: 'submission_approved',
                submissionId,
                submissionTitle: submission.title,
                submissionType: submission.type,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                actorId: auth.user.userId
            });
        }

        // If approved and addToCompetitions, create competition entry
        let linkedCompetitionId: string | null = null;
        if (action === 'approve' && addToCompetitions && submission.type === 'competition') {
            const compRef = db.collection('competitions').doc();
            batch.set(compRef, {
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
            });
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

        batch.set(notifRef, {
            type: action === 'approve' ? 'points_awarded' : 'submission_rejected',
            title: `${notifEmoji} ${notifTitle}`,
            body: notifBody,
            link: `/profile`,
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();

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
