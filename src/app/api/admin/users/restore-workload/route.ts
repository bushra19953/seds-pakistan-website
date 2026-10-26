import { NextResponse, NextRequest } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { FieldValue } from 'firebase-admin/firestore';
import {
    identityPrimaryFlagOn,
    primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';

import {
    isLeaveSupaEnabled,
    mirrorLeaveAuditSet,
    mirrorLeaveRequestUpdate,
    tryGetLeaveRequestRaw,
} from '@/lib/supa-seams/hr-leave';

// Slice 08: restore-workload plus return-from-leave.
// Trigger for the return path is exactly one signal: returnFromLeave === true.
// action: 'return_from_leave' is NOT a trigger. See NOTES.md for the reason.
// Both paths match the same status list. The list keeps the legacy
// in_progress spelling and adds the canonical in-progress spelling, so
// hyphen-status redirected tasks are restored instead of being skipped.
const RESTORABLE_TASK_STATUSES = ['pending', 'locked', 'in_progress', 'in-progress'];

export async function POST(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const decoded = auth.user.user;

        const canManage = await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canManageUsers');

        if (!canManage) {
            return NextResponse.json({ error: 'Forbidden: Insufficient permissions to restore workload' }, { status: 403 });
        }

        const body = await req.json();
        const { uid, returnFromLeave, leaveRequestId } = body;

        if (!uid) {
            return NextResponse.json({ error: 'User UID is required' }, { status: 400 });
        }

        // Only the strict boolean true triggers the return path. False, null,
        // undefined, a missing field, and any truthy non-boolean value all
        // mean plain restore.
        const isReturn = returnFromLeave === true;

        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
        }

        // Validate leaveRequestId up front on the return path, before any
        // read or write, so a malformed id never partially applies.
        let normalizedLeaveRequestId: string | null = null;
        if (isReturn && leaveRequestId !== undefined && leaveRequestId !== null) {
            if (typeof leaveRequestId !== 'string' || leaveRequestId.trim() === '') {
                return NextResponse.json({ error: 'leaveRequestId must be a non-empty string when provided' }, { status: 400 });
            }
            normalizedLeaveRequestId = leaveRequestId.trim();
        }

        // Fetch tasks that were redirected FROM this user AND are still active.
        // Both paths use RESTORABLE_TASK_STATUSES, so in_progress and
        // in-progress are both matched.
        const snapshot = await db.collection('tasks')
            .where('redirectedFrom', '==', uid)
            .where('status', 'in', RESTORABLE_TASK_STATUSES)
            .get();

        // Return-path pre-reads. The plain path does not read the user doc
        // or any leave doc, so plain behavior and read cost are unchanged.
        let userNeedsClear = false;
        let leaveNeedsComplete = false;
        let leaveStatus: string | null = null;
        let userRef: any = null;
        let leaveRef: any = null;

        if (isReturn) {
            userRef = db.collection('users').doc(uid);
            const userSnap = await userRef.get();
            if (!userSnap.exists) {
                return NextResponse.json({ error: 'User not found' }, { status: 404 });
            }
            const userData = userSnap.data() || {};
            userNeedsClear =
                userData.isOnVacation === true ||
                userData.vacationMode === true ||
                userData.leaveRequestId != null;

            if (normalizedLeaveRequestId) {
                leaveRef = db.collection('leave_requests').doc(normalizedLeaveRequestId);
                // Supa-first read of the leave-owned doc when ON;
                // disabled or any adapter error falls back to Firestore.
                // Only status/owner fields are consumed (raw reader).
                let leaveExists: boolean | null = null;
                let leaveData: Record<string, unknown> = {};
                if (isLeaveSupaEnabled()) {
                    const supaResult = await tryGetLeaveRequestRaw(normalizedLeaveRequestId);
                    if (supaResult.status === 'ok') {
                        leaveExists = supaResult.value !== null;
                        if (supaResult.value) {
                            const { id: _supaId, ...rest } = supaResult.value;
                            void _supaId;
                            leaveData = rest;
                        }
                    }
                }
                if (leaveExists === null) {
                    const leaveSnap = await leaveRef.get();
                    leaveExists = leaveSnap.exists;
                    if (leaveExists) {
                        leaveData = leaveSnap.data() || {};
                    }
                }
                if (!leaveExists) {
                    leaveStatus = 'not_found';
                } else {
                    leaveStatus = typeof leaveData.status === 'string' ? leaveData.status : null;
                    const ownerId = leaveData.userId ?? leaveData.user_id ?? null;
                    if (typeof ownerId === 'string' && ownerId !== uid) {
                        leaveStatus = 'owner_mismatch';
                    } else if (leaveStatus === 'approved') {
                        leaveNeedsComplete = true;
                    }
                }
            }

            // Idempotency gate. When nothing needs doing, return before
            // building or committing any batch, so a second return writes
            // nothing: no leave_audit, no audit_logs, no user or leave write.
            const hasWork = snapshot.size > 0 || userNeedsClear || leaveNeedsComplete;
            if (!hasWork) {
                return NextResponse.json({
                    success: true,
                    restoredCount: 0,
                    alreadyReturned: true,
                    leaveRequestStatus: leaveStatus,
                    flagsCleared: false,
                    message: 'Already returned from leave. No changes made.'
                });
            }
        } else if (snapshot.empty) {
            // Plain path, unchanged: empty restore returns with no writes.
            return NextResponse.json({ success: true, restoredCount: 0, message: 'No active redirected tasks found.' });
        }

        const batch = db.batch();
        let restoredCount = 0;
        // Captured for the Supabase dual-write mirror after commit.
        let capturedLeaveAudit: { id: string; data: Record<string, unknown> } | null = null;

        snapshot.docs.forEach(doc => {
            const docRef = doc.ref;
            batch.update(docRef, {
                assigneeId: uid,
                redirectedFrom: FieldValue.delete(), // Clear the flag since it's now restored
                updatedAt: FieldValue.serverTimestamp()
            });

            // Log the reverse operation
            const activityRef = docRef.collection('activity').doc();
            batch.set(activityRef, {
                type: 'reassign',
                userId: decoded.uid,
                data: {
                    previousAssigneeId: doc.data().assigneeId,
                    newAssigneeId: uid,
                    reason: 'Bulk Workout Restore Engine (Return from Vacation)'
                },
                createdAt: FieldValue.serverTimestamp()
            });

            restoredCount++;
        });

        if (isReturn) {
            // Clear the vacation flags. coveringOfficerId, vacationStartDate,
            // and vacationEndDate are intentionally left untouched and kept
            // for history.
            if (userNeedsClear && userRef) {
                batch.update(userRef, {
                    isOnVacation: false,
                    vacationMode: false,
                    leaveRequestId: FieldValue.delete(),
                    updatedAt: FieldValue.serverTimestamp()
                });
            }

            // Only an approved leave request moves to completed. Pending,
            // rejected, cancelled, already completed, missing, and
            // owner-mismatched docs are left untouched.
            if (leaveNeedsComplete && leaveRef) {
                batch.update(leaveRef, {
                    status: 'completed',
                    updatedAt: FieldValue.serverTimestamp()
                });
            }

            // Return-scoped audit entry. Written on every effective return,
            // even when restoredCount is 0. Not written on a no-op return.
            const leaveAuditRef = db.collection('leave_audit').doc();
            const leaveAuditData: Record<string, unknown> = {
                action: 'leave_returned',
                actorId: decoded.uid,
                targetUid: uid,
                leaveRequestId: normalizedLeaveRequestId,
                restoredCount,
                timestamp: FieldValue.serverTimestamp()
            };
            batch.set(leaveAuditRef, leaveAuditData);
            capturedLeaveAudit = { id: leaveAuditRef.id, data: leaveAuditData };
        }

        // Restore-scoped audit entry. Written only when at least one task
        // was restored, matching the plain-path rule for empty restores.
        if (restoredCount > 0) {
            const auditRef = db.collection('audit_logs').doc();
            batch.set(auditRef, {
                action: 'restore_workload',
                actorId: decoded.uid,
                targetUid: uid,
                restoredTaskCount: restoredCount,
                timestamp: FieldValue.serverTimestamp()
            });
        }

        // WRITE PRIMACY (G-USER-6, U-29 — the second implementation
        // of the U-28 flag clear, H-02 pair): under
        // isSupaPrimary('users') and when this batch carries the
        // vacation-flag clear, the adapter update lands first (loud);
        // the batch's native user update is the reverse mirror.
        if (isReturn && userNeedsClear && userRef && (await identityPrimaryFlagOn('users'))) {
            await primaryIdentityUpdate('users', 'users', uid, {
                isOnVacation: false,
                vacationMode: false,
                leaveRequestId: FieldValue.delete(),
                updatedAt: new Date()
            });
        }
        await batch.commit();

        // Dual-write mirror (leave-owned docs only) after the Firestore
        // commit: the completed leave request and the leave_audit entry.
        // Tasks, users and audit_logs stay Firestore-only (other clusters).
        if (isReturn && leaveNeedsComplete && normalizedLeaveRequestId) {
            await mirrorLeaveRequestUpdate(normalizedLeaveRequestId, {
                status: 'completed',
                updatedAt: FieldValue.serverTimestamp()
            });
        }
        if (isReturn && capturedLeaveAudit) {
            await mirrorLeaveAuditSet(capturedLeaveAudit.id, capturedLeaveAudit.data);
        }

        if (isReturn) {
            return NextResponse.json({
                success: true,
                restoredCount,
                alreadyReturned: false,
                leaveRequestStatus: leaveNeedsComplete ? 'completed' : leaveStatus,
                flagsCleared: userNeedsClear,
                message: restoredCount > 0
                    ? `Successfully transferred ${restoredCount} tasks back.`
                    : 'Leave return completed. No redirected tasks to restore.'
            });
        }

        return NextResponse.json({
            success: true,
            restoredCount,
            message: `Successfully transferred ${restoredCount} tasks back.`
        });

    } catch (error: any) {
        console.error('[restore-workload] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
