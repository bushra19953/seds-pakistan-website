import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import type { PermissionKey } from '@/config/permissions.config';
import * as admin from 'firebase-admin';
import { returnFromLeave } from '@/lib/server/leave-return';

export const dynamic = 'force-dynamic';

// Task docs never carry userId. They carry the submitter on assigneeId
// (string or array) or submittedBy, with userId only on non-task docs
// (submissions, applications, and similar). Resolve the points and
// notification recipient from those fields in that order. Returns null
// when no field resolves to a non-empty string, so callers can skip the
// points block gracefully instead of calling doc(undefined), which the
// Admin SDK rejects synchronously.
function resolvePointsRecipient(docData: any): string | null {
    const candidates = [docData.assigneeId, docData.submittedBy, docData.userId];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const first = candidate.find((v) => typeof v === 'string' && v.trim() !== '');
            if (first) return first;
        } else if (typeof candidate === 'string' && candidate.trim() !== '') {
            return candidate;
        }
    }
    return null;
}

// Leave requests carry the requester on userId (canonical), with
// user_id, submittedBy, and assigneeId as legacy fallbacks. Order is
// intentional and differs from resolvePointsRecipient: userId wins for
// leave, because assigneeId on a leave doc must never redirect the
// vacation flags or the notification to a different person.
function resolveLeaveRequesterUid(docData: any): string | null {
    const candidates = [docData.userId, docData.user_id, docData.submittedBy, docData.assigneeId];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const first = candidate.find((v) => typeof v === 'string' && v.trim() !== '');
            if (first) return first;
        } else if (typeof candidate === 'string' && candidate.trim() !== '') {
            return candidate;
        }
    }
    return null;
}

// Normalize an optional leave string field to a non-empty string or null.
// Firestore rejects undefined, so empty or missing values become null.
function normalizeLeaveString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim() !== '') {
        return value;
    }
    return null;
}

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
        let { collection: collectionName, ids, action, notes, points, updatedData, extraFields } = body;

        // Leave inbox rows carry global_id / original_ref as
        // "leave_requests/{docId}". The drawer sends that identifier
        // instead of a bare doc id. Accept it as a single-id fallback
        // when ids is absent, and derive the collection from it so the
        // permission check below sees leave_requests.
        const leaveRefCandidate =
            typeof body.global_id === 'string' && body.global_id
                ? body.global_id
                : typeof body.original_ref === 'string' && body.original_ref
                    ? body.original_ref
                    : typeof body.id === 'string' && body.id
                        ? body.id
                        : typeof body.submissionId === 'string' && body.submissionId
                            ? body.submissionId
                            : null;
        if ((!ids || !Array.isArray(ids) || ids.length === 0) && leaveRefCandidate) {
            ids = [leaveRefCandidate];
        }
        if (!collectionName && leaveRefCandidate && leaveRefCandidate.startsWith('leave_requests/')) {
            collectionName = 'leave_requests';
        }
        if (!collectionName && Array.isArray(ids)) {
            const firstLeaveRef = ids.find((v: any) => typeof v === 'string' && v.startsWith('leave_requests/'));
            if (firstLeaveRef) {
                collectionName = 'leave_requests';
            }
        }
        // A homogeneous batch of leave_requests/{docId} refs was
        // misrouted if the caller named a different collection. The
        // leave ref wins so the doc is fetched from leave_requests.
        if (
            collectionName &&
            collectionName !== 'leave_requests' &&
            Array.isArray(ids) &&
            ids.length > 0 &&
            ids.every((v: any) => typeof v === 'string' && v.startsWith('leave_requests/'))
        ) {
            collectionName = 'leave_requests';
        }

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
        const skippedAlreadyReviewed: string[] = [];
        const failedLeaveRequests: Array<{ id: string; error: string }> = [];

        // Revoke branch: admin early-revokes an APPROVED leave.
        // Separate from the generic approve/reject path below and returns
        // early, so the generic path never sees a revoke. Per-id results
        // are collected so one bad id does not abort the rest.
        if (action === 'revoke') {
            if (collectionName !== 'leave_requests') {
                return NextResponse.json(
                    { error: 'Revoke is only supported for leave_requests' },
                    { status: 400 },
                );
            }

            const results: Array<{
                id: string;
                revoked: boolean;
                restoredCount: number;
                heldClearedCount: number;
                alreadyReturned: boolean;
                skippedReason?: string;
                error?: string;
            }> = [];
            let failedCount = 0;

            for (const rawId of ids) {
                // Strip a leave_requests/{docId} ref to the bare doc id.
                const id = typeof rawId === 'string' && rawId.startsWith('leave_requests/')
                    ? rawId.slice('leave_requests/'.length)
                    : rawId;
                try {
                    const leaveRef = db.collection('leave_requests').doc(id);
                    const leaveSnap = await leaveRef.get();
                    if (!leaveSnap.exists) {
                        results.push({
                            id,
                            revoked: false,
                            restoredCount: 0,
                            heldClearedCount: 0,
                            alreadyReturned: false,
                            skippedReason: 'Leave request not found',
                        });
                        continue;
                    }

                    const leaveData = leaveSnap.data() || {};
                    const leaveStatus =
                        typeof leaveData.status === 'string' ? leaveData.status : null;

                    // Only an approved leave can be revoked. A pending
                    // leave is rejected, not revoked. An already
                    // completed, rejected, or cancelled leave is left
                    // untouched. This is what makes double-revoke a
                    // safe no-op instead of a second return.
                    if (leaveStatus !== 'approved') {
                        results.push({
                            id,
                            revoked: false,
                            restoredCount: 0,
                            heldClearedCount: 0,
                            alreadyReturned: leaveStatus === 'completed',
                            skippedReason:
                                `Leave request is ${leaveStatus || 'unknown'}, ` +
                                'only an approved leave can be revoked',
                        });
                        continue;
                    }

                    const targetUid =
                        (typeof leaveData.userId === 'string' && leaveData.userId) ||
                        (typeof leaveData.requesterId === 'string' && leaveData.requesterId) ||
                        (typeof leaveData.user_id === 'string' && leaveData.user_id) ||
                        null;
                    if (!targetUid) {
                        results.push({
                            id,
                            revoked: false,
                            restoredCount: 0,
                            heldClearedCount: 0,
                            alreadyReturned: false,
                            skippedReason: 'Leave request has no owner user id',
                        });
                        continue;
                    }

                    const returnResult = await returnFromLeave(db, {
                        uid: targetUid,
                        leaveRequestId: id,
                        actorId: auth.user.userId,
                        actorName: reviewerName,
                        auditAction: 'leave_revoked',
                        reason: typeof notes === 'string' ? notes : undefined,
                    });

                    try {
                        const notifRef = db
                            .collection('users')
                            .doc(targetUid)
                            .collection('notifications')
                            .doc();
                        await notifRef.set({
                            type: 'leave_revoked',
                            title: 'Leave revoked',
                            body: notes
                                ? `Your approved leave was revoked by an admin. Reason: ${notes}`
                                : 'Your approved leave was revoked by an admin. Your tasks have been returned to you.',
                            link: '/profile',
                            isRead: false,
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    } catch (notifError: any) {
                        console.error(
                            `[universal-review PATCH revoke] Notification failed for ${collectionName}/${id}:`,
                            notifError,
                        );
                    }

                    results.push({
                        id,
                        revoked: true,
                        restoredCount: returnResult.restoredCount,
                        heldClearedCount: returnResult.heldClearedCount,
                        alreadyReturned: returnResult.alreadyReturned,
                    });
                } catch (revokeError: any) {
                    failedCount += 1;
                    console.error(
                        `[universal-review PATCH revoke] Failed for ${collectionName}/${id}:`,
                        revokeError,
                    );
                    results.push({
                        id,
                        revoked: false,
                        restoredCount: 0,
                        heldClearedCount: 0,
                        alreadyReturned: false,
                        error: revokeError?.message || String(revokeError),
                    });
                }
            }

            const revokedCount = results.filter((r) => r.revoked).length;
            return NextResponse.json(
                {
                    success: failedCount === 0,
                    message:
                        revokedCount > 0
                            ? `Revoked ${revokedCount} leave request(s).`
                            : 'No leave requests were revoked.',
                    results,
                },
                { status: failedCount > 0 ? 207 : 200 },
            );
        }

        // The per-doc loop and the commit share one try/catch so that a
        // throw before batch.commit() (for example doc(undefined)) also
        // lands in the DLQ instead of bypassing it, and the real error
        // message is preserved in the DLQ entry and the response.
        try {
        for (const rawId of ids) {
            // Resolve a leave_requests/{docId} ref directly against the
            // leave_requests collection. A bare doc id keeps the existing
            // collectionName behavior unchanged.
            const leaveMatch = typeof rawId === 'string' ? rawId.match(/^leave_requests\/(.+)$/) : null;
            const id = leaveMatch ? leaveMatch[1] : rawId;
            const effectiveCollection = leaveMatch ? 'leave_requests' : collectionName;
            const docRef = db.collection(effectiveCollection).doc(id);
            const docSnap = await docRef.get();
            if (!docSnap.exists) continue;

            const docData = docSnap.data()!;
            const isLeave = effectiveCollection === 'leave_requests';

            // Leave idempotency guard. Must run BEFORE the updatedData
            // merge and BEFORE any batch write is queued for this id. If
            // the request is already in a terminal state (approved,
            // rejected, cancelled, completed), skip it entirely: no status
            // flip, no flag set, no audit, no notification, no points.
            if (isLeave) {
                const priorStatus = typeof docData.status === 'string' ? docData.status.toLowerCase() : '';
                if (priorStatus === 'approved' || priorStatus === 'rejected' || priorStatus === 'cancelled' || priorStatus === 'completed') {
                    skippedAlreadyReviewed.push(id);
                    continue;
                }
            }

            const newStatus = action === 'approve' ? 'approved' : 'rejected';
            const pointsRecipient = resolvePointsRecipient(docData);

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

            // Resolve the leave requester AFTER the updatedData merge so
            // an admin correction to userId is honored. For non-leave
            // collections this stays null and is unused.
            const leaveRequesterUid = isLeave ? resolveLeaveRequesterUid(docData) : null;

            // Coordinator fix: an approve with no resolvable requester must
            // NOT flip the status. Flipping without setting flags would
            // strand the doc in approved (the guard above would then skip
            // every retry). Skip and report it instead.
            if (isLeave && action === 'approve' && !leaveRequesterUid) {
                failedLeaveRequests.push({ id, error: 'No leave requester resolved; status not changed.' });
                continue;
            }

            // Leave approvals award no points by default. The leave
            // exclusion must stay even if the caller passes points.
            if (action === 'approve' && !isLeave && typeof points === 'number' && points > 0) {
                updatePayload.pointsAwarded = points;
                // Skip the points block when no recipient resolves. The
                // status update below still applies.
                if (pointsRecipient) {
                    const userRef = db.collection('users').doc(pointsRecipient);
                    batch.set(userRef, {
                        total_points: admin.firestore.FieldValue.increment(points),
                        points: admin.firestore.FieldValue.increment(points), // keep legacy for compatibility if needed
                        ...(effectiveCollection === 'submissions' ? { submissionsApprovedCount: admin.firestore.FieldValue.increment(1) } : {})
                    }, { merge: true });

                    // Points Ledger strictly mandated. user_id is the
                    // resolved recipient, never undefined.
                    const ledgerRef = db.collection('points_ledger').doc();
                    batch.set(ledgerRef, {
                        user_id: pointsRecipient,
                        task_id: id,
                        points_awarded: points,
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'PROCESSED'
                    });
                } else {
                    console.warn(`[universal-review PATCH] No points recipient resolved for ${effectiveCollection}/${id}; awarding ${points} points skipped, status update still applies.`);
                }
            }

            // Submissions specific schema mapping: Send to Competitions collection.
            if (action === 'approve' && extraFields?.addToCompetitions && effectiveCollection === 'submissions' && docData.type === 'competition') {
                const compRef = db.collection('competitions').doc();
                batch.set(compRef, {
                    title: docData.title,
                    url: docData.url,
                    description: docData.description || '',
                    deadline: docData.deadline || null,
                    organization: docData.organization || '',
                    tags: docData.tags || [],
                    submittedBy: pointsRecipient,
                    submitterName: docData.userDisplayName || 'Unknown',
                    sourceSubmissionId: id,
                    status: 'active',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdBy: auth.user.userId
                });
                updatePayload.linkedCompetitionId = compRef.id;
            }

            batch.update(docRef, updatePayload);

            // Leave-specific side effect, queued AFTER the status flip
            // in the same batch, so the status flip, the flag set, the
            // audit write, and the notification commit atomically. Reject
            // queues nothing here: no flags, no audit.
            if (isLeave && action === 'approve' && leaveRequesterUid) {
                const leaveStartDate = docData.startDate || docData.start_date || null;
                const leaveEndDate = docData.endDate || docData.end_date || null;
                const leaveCoveringOfficerId = normalizeLeaveString(docData.coveringOfficerId ?? docData.covering_officer_id);

                const leaveUserRef = db.collection('users').doc(leaveRequesterUid);
                batch.set(leaveUserRef, {
                    isOnVacation: true,
                    vacationMode: true,
                    coveringOfficerId: leaveCoveringOfficerId,
                    vacationStartDate: leaveStartDate,
                    vacationEndDate: leaveEndDate,
                    leaveRequestId: id,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });

                const leaveAuditRef = db.collection('leave_audit').doc();
                batch.set(leaveAuditRef, {
                    actorId: auth.user.userId,
                    targetUid: leaveRequesterUid,
                    action: 'leave_approved',
                    leaveRequestId: id,
                    startDate: leaveStartDate,
                    endDate: leaveEndDate,
                    coveringOfficerId: leaveCoveringOfficerId,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                });
            }

            // Notification System Push To Submitter
            // Leave uses the leave requester as the recipient. Non-leave
            // collections keep the existing points recipient. Leave
            // bodies never mention points, even if the caller passed a
            // points value, because leave approvals award no points.
            const notifyRecipient = isLeave ? leaveRequesterUid : pointsRecipient;
            if (notifyRecipient) {
                const notifRef = db.collection('users').doc(notifyRecipient).collection('notifications').doc();
                const emoji = action === 'approve' ? '✅' : '❌';
                batch.set(notifRef, {
                    type: action === 'approve' ? 'request_approved' : 'request_rejected',
                    title: `${emoji} ${docData.title || 'Request'} ${action === 'approve' ? 'Approved' : 'Rejected'}`,
                    body: action === 'approve'
                        ? (isLeave
                            ? `Your request was approved.`
                            : `Your request was approved.${points ? ` You earned ${points} points.` : ''}`)
                        : `Your request was rejected. ${notes ? `Reason: ${notes}` : ''}`,
                    link: '/profile',
                    isRead: false,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }

        // If the transaction fails, the task must not be marked as approved. The system must throw an error,
        // revert to PENDING, and trigger an automated retry.
            await batch.commit();
        } catch (batchError: any) {
            console.error('[universal-review PATCH] Batch transaction failed, sending to DLQ:', batchError);

            // Log to DLQ for automated retry via background worker. A DLQ
            // write failure must not mask the real error, so it is
            // logged separately and the original error is still returned.
            try {
                const dlqRef = db.collection('dlq_points_retry').doc();
                await dlqRef.set({
                    action: 'universal_review_approval_failed',
                    ids,
                    error: batchError?.message || String(batchError),
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'PENDING_RETRY'
                });
            } catch (dlqError: any) {
                console.error('[universal-review PATCH] DLQ write failed:', dlqError);
            }

            return NextResponse.json({ error: `Transaction failed. Reverted to PENDING and triggered DLQ retry. Cause: ${batchError?.message || String(batchError)}` }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            message: `Successfully processed ${ids.length} records.`,
            skippedAlreadyReviewed,
            failedLeaveRequests
        });

    } catch (error: any) {
        console.error('[universal-review PATCH] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
