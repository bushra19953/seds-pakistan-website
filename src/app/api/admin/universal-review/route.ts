import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import type { PermissionKey } from '@/config/permissions.config';
import * as admin from 'firebase-admin';

export const dynamic = 'force-dynamic';

const COLLECTION_PERMISSION_MAP: Record<string, PermissionKey> = {
    'submissions': 'canManageApplications',
    'leave_requests': 'canManageApplications',
    'applications': 'canManageApplications',
    'form_responses': 'canManageForms',
    'tasks': 'canManageTasks'
};

export async function GET(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const collectionName = searchParams.get('collection');
        const status = searchParams.get('status') || 'pending';

        if (!collectionName || !COLLECTION_PERMISSION_MAP[collectionName]) {
            return NextResponse.json({ error: 'Invalid or unsupported collection map' }, { status: 400 });
        }

        const requiredPermission = COLLECTION_PERMISSION_MAP[collectionName];

        // REPLACED: Lazy string array check with strict Granular Claim Check mapped to role.
        const isAuthorized = await hasServerPermission(auth.user.role || '', requiredPermission);

        if (!isAuthorized) {
            return NextResponse.json({ error: `Forbidden: '${requiredPermission}' access required for this collection` }, { status: 403 });
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
        }

        let query: admin.firestore.Query = db.collection(collectionName);
        if (status !== 'all') {
            query = query.where('status', '==', status);
        }

        // Use submittedAt if exists, else createdAt
        query = query.orderBy('submittedAt', 'desc').limit(100);

        try {
            const snapshot = await query.get();
            const data = snapshot.docs.map(doc => {
                const docData = doc.data();
                return {
                    id: doc.id,
                    ...docData,
                    submittedAt: docData.submittedAt?.toDate?.()?.toISOString() || null,
                    reviewedAt: docData.reviewedAt?.toDate?.()?.toISOString() || null,
                    deadline: docData.deadline?.toDate?.()?.toISOString() || null
                };
            });
            return NextResponse.json({ success: true, data });
        } catch (queryError: any) {
            // Fallback if index on submittedAt doesn't exist yet
            console.warn(`[Universal Review] Query failed, falling back to unindexed fetch. Details: ${queryError.message}`);

            let fbQuery: admin.firestore.Query = db.collection(collectionName);
            if (status !== 'all') {
                fbQuery = fbQuery.where('status', '==', status);
            }
            const fallbackSnap = await fbQuery.get();
            const fallbackData = fallbackSnap.docs.map(d => {
                const dData = d.data();
                return {
                    id: d.id,
                    ...dData,
                    submittedAt: dData.submittedAt?.toDate?.()?.toISOString() || null,
                    reviewedAt: dData.reviewedAt?.toDate?.()?.toISOString() || null,
                    deadline: dData.deadline?.toDate?.()?.toISOString() || null
                }
            }).sort((a, b) => {
                const tA = new Date(a.submittedAt || 0).getTime();
                const tB = new Date(b.submittedAt || 0).getTime();
                return tB - tA;
            });

            return NextResponse.json({ success: true, data: fallbackData.slice(0, 100) });
        }

    } catch (error: any) {
        console.error('[universal-review GET] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { collection: collectionName, ids, action, notes, points, updatedData, extraFields } = body;

        if (!collectionName || !ids || !Array.isArray(ids) || ids.length === 0 || !action) {
            return NextResponse.json({ error: 'Missing required payload parameters' }, { status: 400 });
        }

        const requiredPermission = COLLECTION_PERMISSION_MAP[collectionName];
        if (!requiredPermission) {
            return NextResponse.json({ error: 'Unsupported collection' }, { status: 400 });
        }

        const isAuthorized = await hasServerPermission(auth.user.role || '', requiredPermission);
        if (!isAuthorized) {
            return NextResponse.json({ error: `Forbidden: '${requiredPermission}' access required` }, { status: 403 });
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Db error' }, { status: 500 });

        const batch = db.batch();
        const reviewerDoc = await db.collection('users').doc(auth.user.userId).get();
        const reviewerName = reviewerDoc.data()?.displayName || auth.user.email || 'Admin';

        for (const id of ids) {
            const docRef = db.collection(collectionName).doc(id);
            const docSnap = await docRef.get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            const newStatus = action === 'approve' ? 'approved' : 'rejected';

            const updatePayload: any = {
                status: newStatus,
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedBy: auth.user.userId,
                reviewerDisplayName: reviewerName,
                reviewNotes: notes || null,
            };

            // Inline data edits from Admin Approval Table (e.g. typos in URL)
            if (updatedData && typeof updatedData === 'object') {
                for (const [k, v] of Object.entries(updatedData)) {
                    updatePayload[k] = v;
                    docData[k] = v; // Update memory reference for subsequent local logic
                }
            }

            if (action === 'approve' && typeof points === 'number' && points > 0) {
                updatePayload.pointsAwarded = points;
                const userRef = db.collection('users').doc(docData.userId);
                batch.set(userRef, {
                    total_points: admin.firestore.FieldValue.increment(points),
                    points: admin.firestore.FieldValue.increment(points), // keep legacy for compatibility if needed
                    ...(collectionName === 'submissions' ? { submissionsApprovedCount: admin.firestore.FieldValue.increment(1) } : {})
                }, { merge: true });

                // Points Ledger strictly mandated
                const ledgerRef = db.collection('points_ledger').doc();
                batch.set(ledgerRef, {
                    user_id: docData.userId,
                    task_id: id,
                    points_awarded: points,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'PROCESSED'
                });
            }

            // Submissions specific schema mapping: Send to Competitions collection.
            if (action === 'approve' && extraFields?.addToCompetitions && collectionName === 'submissions' && docData.type === 'competition') {
                const compRef = db.collection('competitions').doc();
                batch.set(compRef, {
                    title: docData.title,
                    url: docData.url,
                    description: docData.description || '',
                    deadline: docData.deadline || null,
                    organization: docData.organization || '',
                    tags: docData.tags || [],
                    submittedBy: docData.userId,
                    submitterName: docData.userDisplayName || 'Unknown',
                    sourceSubmissionId: id,
                    status: 'active',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdBy: auth.user.userId
                });
                updatePayload.linkedCompetitionId = compRef.id;
            }

            batch.update(docRef, updatePayload);

            // Notification System Push To Submitter
            if (docData.userId) {
                const notifRef = db.collection('users').doc(docData.userId).collection('notifications').doc();
                const emoji = action === 'approve' ? '✅' : '❌';
                batch.set(notifRef, {
                    type: action === 'approve' ? 'request_approved' : 'request_rejected',
                    title: `${emoji} ${docData.title || 'Request'} ${action === 'approve' ? 'Approved' : 'Rejected'}`,
                    body: action === 'approve'
                        ? `Your request was approved.${points ? ` You earned ${points} points.` : ''}`
                        : `Your request was rejected. ${notes ? `Reason: ${notes}` : ''}`,
                    link: '/profile',
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }

        // If the transaction fails, the task must not be marked as approved. The system must throw an error,
        // revert to PENDING, and trigger an automated retry.
        try {
            await batch.commit();
        } catch (commitError: any) {
            console.error('[universal-review PATCH] Batch transaction failed, sending to DLQ:', commitError);

            // Log to DLQ for automated retry via background worker
            const dlqRef = db.collection('dlq_points_retry').doc();
            await dlqRef.set({
                action: 'universal_review_approval_failed',
                ids,
                error: commitError.message,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: 'PENDING_RETRY'
            });

            return NextResponse.json({ error: 'Transaction failed. Reverted to PENDING and triggered DLQ retry.' }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            message: `Successfully processed ${ids.length} records.`
        });

    } catch (error: any) {
        console.error('[universal-review PATCH] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
