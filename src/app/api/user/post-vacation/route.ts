import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { returnFromLeave } from '@/lib/server/leave-return';
import {
    isLeaveSupaEnabled,
    tryGetLeaveRequestRaw,
} from '@/lib/supa-seams/hr-leave';

export const dynamic = 'force-dynamic';

/**
 * POST /api/user/post-vacation
 *
 * Member self-return from approved leave. The caller must be on leave.
 * This route never trusts a client-supplied uid. The uid always comes
 * from the verified auth token.
 *
 * All state changes (flag clear, workload restore, held-task clear,
 * request marked completed, audit entry) live in the shared helper
 * returnFromLeave in src/lib/server/leave-return.ts. This route only
 * authenticates, validates the caller is on leave, resolves the
 * leaveRequestId, and delegates. It performs no Firestore writes
 * itself, so a rejected request changes nothing.
 *
 * Dependency: src/lib/server/leave-return.ts is built by another slice.
 * Expected interface:
 *   returnFromLeave(db, { uid, leaveRequestId?, actorId, actorName?, auditAction? })
 *   returns { restoredCount: number, alreadyReturned: boolean }
 */

const NOT_ON_LEAVE_MESSAGE =
    'You are not currently on leave. Nothing was changed.';
const NOT_APPROVED_MESSAGE =
    'Your leave request is not approved. Nothing was changed.';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Canonical uid from the verified token. Fall back to the decoded
        // token uid, matching the shape verifyAuthentication returns.
        const uid = auth.user.userId || auth.user.user?.uid;
        if (!uid) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body: unknown = await req.json().catch(() => ({}));
        if (!isRecord(body)) {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        // Optional leaveRequestId. A non-string or blank value is a client
        // error, not something to silently ignore.
        let bodyLeaveRequestId: string | null = null;
        if (body.leaveRequestId !== undefined && body.leaveRequestId !== null) {
            if (typeof body.leaveRequestId !== 'string' || body.leaveRequestId.trim() === '') {
                return NextResponse.json(
                    { error: 'leaveRequestId must be a non-empty string when provided' },
                    { status: 400 },
                );
            }
            bodyLeaveRequestId = body.leaveRequestId.trim();
        }

        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
        }

        // Read the caller's own user doc. This is the source of truth for
        // the on-leave flags and the fallback leaveRequestId.
        const userSnap = await db.collection('users').doc(uid).get();
        if (!userSnap.exists) {
            return NextResponse.json({ error: 'User record not found' }, { status: 404 });
        }
        const userData = userSnap.data() || {};

        // Gate 1: caller must actually be on leave. Either flag counts.
        // The flags are treated as one flag everywhere in the codebase.
        const isOnVacation = userData.isOnVacation === true || userData.vacationMode === true;
        if (!isOnVacation) {
            return NextResponse.json({ error: NOT_ON_LEAVE_MESSAGE }, { status: 400 });
        }

        // Resolve the leave request id. Explicit body value wins. Otherwise
        // use the one stamped on the user doc at approval time.
        const userLeaveRequestId =
            typeof userData.leaveRequestId === 'string' && userData.leaveRequestId.trim() !== ''
                ? userData.leaveRequestId.trim()
                : null;
        const leaveRequestId = bodyLeaveRequestId || userLeaveRequestId;

        // Gate 2: when a leave request id resolves, the request must belong
        // to the caller and must not be in a never-approved state. A missing
        // doc is treated as a dangling pointer from an older or manual flow,
        // not as a reason to strand the caller on leave forever, so it
        // still proceeds and the helper clears the flags. A request with
        // status pending, rejected, or cancelled was never approved, so
        // the return is rejected and nothing changes.
        if (leaveRequestId) {
            // Supa-first read of the leave-owned doc when ON; disabled
            // flag or any adapter error falls back to Firestore below.
            // Only owner/status fields are consumed, so the raw reader
            // (no timestamp conversion) is used deliberately.
            let leaveExists: boolean | null = null;
            let leaveData: Record<string, unknown> = {};
            if (isLeaveSupaEnabled()) {
                const supaResult = await tryGetLeaveRequestRaw(leaveRequestId);
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
                const leaveSnap = await db.collection('leave_requests').doc(leaveRequestId).get();
                leaveExists = leaveSnap.exists;
                if (leaveExists) {
                    leaveData = leaveSnap.data() || {};
                }
            }
            if (leaveExists) {
                const ownerId =
                    (typeof leaveData.userId === 'string' && leaveData.userId) ||
                    (typeof leaveData.requesterId === 'string' && leaveData.requesterId) ||
                    (typeof leaveData.user_id === 'string' && leaveData.user_id) ||
                    null;
                if (ownerId !== null && ownerId !== uid) {
                    return NextResponse.json(
                        { error: 'This leave request belongs to another user' },
                        { status: 403 },
                    );
                }
                const status = typeof leaveData.status === 'string' ? leaveData.status : null;
                if (status === 'pending' || status === 'rejected' || status === 'cancelled') {
                    return NextResponse.json({ error: NOT_APPROVED_MESSAGE }, { status: 400 });
                }
            }
        }
        // When no leaveRequestId resolves at all (legacy console-flagged
        // user with no request doc), the return still proceeds. Returning
        // only restores the caller's own work and clears the caller's own
        // flags, so there is no privilege gain in proceeding without a
        // request doc, and refusing would strand the caller on leave.

        const actorName =
            (typeof userData.displayName === 'string' && userData.displayName) ||
            auth.user.displayName ||
            auth.user.email ||
            uid;

        const result = await returnFromLeave(db, {
            uid,
            leaveRequestId: leaveRequestId || undefined,
            actorId: uid,
            actorName,
            auditAction: 'leave_returned',
        });

        const restoredCount = result.restoredCount ?? 0;
        const heldClearedCount = (result as { heldClearedCount?: number }).heldClearedCount ?? 0;
        const alreadyReturned = result.alreadyReturned === true;

        const message = alreadyReturned
            ? 'You have already returned from leave. Nothing else needed restoring.'
            : restoredCount > 0
              ? `Welcome back. ${restoredCount} task(s) restored to you.`
              : 'Welcome back. No redirected tasks needed restoring.';

        return NextResponse.json({
            success: true,
            restoredCount,
            heldClearedCount,
            leaveRequestId: leaveRequestId || null,
            alreadyReturned,
            message,
        });
    } catch (error) {
        console.error('[post-vacation] Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to process return from leave' },
            { status: 500 },
        );
    }
}

export async function GET(req: NextRequest) {
    // Read-only status check: when the caller is signed in, return their
    // own leave status. Side-effect free: no writes of any kind. This is
    // a genuine read, not a write-success response.
    try {
        const auth = await verifyAuthentication(req);
        if (!auth.authenticated || !auth.user) {
            return NextResponse.json({ success: true, isOnVacation: false, leaveRequestId: null });
        }

        const uid = auth.user.userId || auth.user.user?.uid;
        if (!uid) {
            return NextResponse.json({ success: true, isOnVacation: false, leaveRequestId: null });
        }

        const db = getDb();
        if (!db) {
            return NextResponse.json({ success: true, isOnVacation: false, leaveRequestId: null });
        }

        const userSnap = await db.collection('users').doc(uid).get();
        if (!userSnap.exists) {
            return NextResponse.json({
                success: true,
                isOnVacation: false,
                leaveRequestId: null,
            });
        }

        const userData = userSnap.data() || {};
        const leaveRequestId =
            typeof userData.leaveRequestId === 'string' && userData.leaveRequestId.trim() !== ''
                ? userData.leaveRequestId.trim()
                : null;

        return NextResponse.json({
            success: true,
            isOnVacation: userData.isOnVacation === true || userData.vacationMode === true,
            leaveRequestId,
        });
    } catch {
        // A read error reports no leave state. It never claims success
        // for a write, because this endpoint performs no writes.
        return NextResponse.json({ success: true, isOnVacation: false, leaveRequestId: null });
    }
}
