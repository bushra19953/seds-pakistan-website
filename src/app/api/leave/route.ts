import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import * as admin from 'firebase-admin';

export const dynamic = 'force-dynamic';

const LEAVE_TYPES = ['annual', 'sick', 'emergency', 'exam', 'personal'] as const;
const CANCELLABLE_STATUS = 'pending';
const BLOCKING_STATUSES = ['pending', 'approved'];
const LISTABLE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'completed'];
const REASON_MAX_LENGTH = 500;
const COVERING_REQUIRED_OVER_DAYS = 3;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type LeaveType = (typeof LEAVE_TYPES)[number];

/**
 * Parse a YYYY-MM-DD date-only string into a UTC midnight Date.
 * Returns null when the format is wrong or the calendar date does not exist.
 */
function parseDateOnly(value: unknown): Date | null {
    if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) {
        return null;
    }
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }
    return date;
}

/**
 * Today's date in Asia/Karachi as a YYYY-MM-DD string.
 * Leave dates are date-only, so "in the past" is judged on the calendar
 * date in Pakistan time, not on the server clock or UTC.
 */
function todayInKarachi(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Karachi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

/**
 * Inclusive day count for a validated date range.
 * Same-day leave counts as 1 day.
 */
function inclusiveDayCount(start: Date, end: Date): number {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((end.getTime() - start.getTime()) / msPerDay) + 1;
}

function toISOStringOrNull(value: unknown): string | null {
    if (!value) {
        return null;
    }
    if (typeof value === 'string') {
        return value;
    }
    const maybeTimestamp = value as { toDate?: () => Date };
    if (typeof maybeTimestamp.toDate === 'function') {
        return maybeTimestamp.toDate().toISOString();
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return null;
}

function serializeLeaveRequest(id: string, data: Record<string, unknown>) {
    return {
        id,
        userId: data.userId ?? null,
        reason: data.reason ?? null,
        startDate: data.startDate ?? null,
        endDate: data.endDate ?? null,
        leaveType: data.leaveType ?? null,
        coveringOfficerId: data.coveringOfficerId ?? null,
        coveringOfficerName: data.coveringOfficerName ?? null,
        notes: data.notes ?? null,
        status: data.status ?? null,
        createdAt: toISOStringOrNull(data.createdAt),
        updatedAt: toISOStringOrNull(data.updatedAt),
        reviewedAt: toISOStringOrNull(data.reviewedAt),
        reviewedBy: data.reviewedBy ?? null,
    };
}

async function requireAuth(req: NextRequest) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
        return { auth: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    return { auth, error: null };
}

function requireDb() {
    if (!ensureAdminInitialized()) {
        return { db: null, error: NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 }) };
    }
    const db = getDb();
    if (!db) {
        return { db: null, error: NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 }) };
    }
    return { db, error: null };
}

async function cancelLeave(
    db: FirebaseFirestore.Firestore,
    callerUid: string,
    leaveId: unknown
) {
    if (typeof leaveId !== 'string' || leaveId.trim() === '') {
        return NextResponse.json({ error: 'Leave request id is required' }, { status: 400 });
    }

    const leaveRef = db.collection('leave_requests').doc(leaveId.trim());
    const leaveDoc = await leaveRef.get();
    if (!leaveDoc.exists) {
        return NextResponse.json({ error: 'Leave request not found' }, { status: 404 });
    }

    const data = leaveDoc.data() || {};
    if (data.userId !== callerUid) {
        return NextResponse.json(
            { error: 'Forbidden: you can only cancel your own leave requests' },
            { status: 403 }
        );
    }
    if (data.status !== CANCELLABLE_STATUS) {
        return NextResponse.json(
            { error: 'Only a pending leave request can be cancelled' },
            { status: 409 }
        );
    }

    await leaveRef.update({
        status: 'cancelled',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
        success: true,
        id: leaveDoc.id,
        status: 'cancelled',
        message: 'Leave request cancelled.',
    });
}

/**
 * GET - List the caller's own leave requests, newest first.
 * Optional query param: ?status=pending|approved|rejected|cancelled|completed
 * Members can never see another member's requests through this route.
 */
export async function GET(req: NextRequest) {
    try {
        const { auth, error: authError } = await requireAuth(req);
        if (authError || !auth) {
            return authError;
        }
        const { db, error: dbError } = requireDb();
        if (dbError || !db) {
            return dbError;
        }

        const { searchParams } = new URL(req.url);
        const statusFilter = searchParams.get('status');
        if (statusFilter !== null && !LISTABLE_STATUSES.includes(statusFilter)) {
            return NextResponse.json(
                { error: 'Invalid status filter. Use one of: ' + LISTABLE_STATUSES.join(', ') },
                { status: 400 }
            );
        }

        let query: admin.firestore.Query = db
            .collection('leave_requests')
            .where('userId', '==', auth.user.userId);
        if (statusFilter !== null) {
            query = query.where('status', '==', statusFilter);
        }
        query = query.orderBy('createdAt', 'desc');

        const snapshot = await query.get();
        const leaveRequests = snapshot.docs.map((doc) =>
            serializeLeaveRequest(doc.id, doc.data())
        );

        return NextResponse.json({
            success: true,
            requests: leaveRequests,
            leaveRequests,
            count: leaveRequests.length,
        });
    } catch (error: unknown) {
        console.error('[leave] GET Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to list leave requests' },
            { status: 500 }
        );
    }
}

/**
 * POST - Create a leave request, or cancel one with { action: 'cancel', id }.
 *
 * Create body: {
 *   reason: string (required, max 500 chars),
 *   startDate: 'YYYY-MM-DD' (required, not in the past in Asia/Karachi),
 *   endDate: 'YYYY-MM-DD' (required, endDate >= startDate),
 *   leaveType: 'annual' | 'sick' | 'emergency' | 'exam' | 'personal' (required),
 *   coveringOfficerId?: string (required when the leave is longer than 3 days),
 *   notes?: string (optional)
 * }
 *
 * The server forces userId to the caller UID and status to 'pending'.
 * Client-supplied status, reviewedAt, reviewedBy, approvedBy are rejected.
 * Returns 201 with the new doc id.
 */
export async function POST(req: NextRequest) {
    try {
        const { auth, error: authError } = await requireAuth(req);
        if (authError || !auth) {
            return authError;
        }
        const { db, error: dbError } = requireDb();
        if (dbError || !db) {
            return dbError;
        }

        let body: Record<string, unknown>;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
        }

        // Cancel path: POST { action: 'cancel', id }.
        if (body.action !== undefined) {
            if (body.action !== 'cancel') {
                return NextResponse.json(
                    { error: "Invalid action. The only supported action is 'cancel'." },
                    { status: 400 }
                );
            }
            const leaveId = body.id ?? body.leaveRequestId ?? body.leaveId;
            return cancelLeave(db, auth.user.userId, leaveId);
        }

        // The caller UID is the only userId this route ever writes.
        // A client-supplied userId that differs from the caller is ignored,
        // never honored: the stored doc always carries the caller UID, so a
        // member can never create a leave for another user.

        // Server-owned review fields. Clients may not set them on create;
        // any client-supplied status, reviewedAt, reviewedBy, or approvedBy
        // is ignored. A client trying to create an already-approved request
        // gets a pending request, never an approved one.

        // reason: required, max 500 chars.
        if (typeof body.reason !== 'string' || body.reason.trim() === '') {
            return NextResponse.json({ error: 'reason is required' }, { status: 400 });
        }
        const reason = body.reason.trim();
        if (reason.length > REASON_MAX_LENGTH) {
            return NextResponse.json(
                { error: 'reason must be at most 500 characters' },
                { status: 400 }
            );
        }

        // leaveType: required, allow-listed.
        if (typeof body.leaveType !== 'string' || !(LEAVE_TYPES as readonly string[]).includes(body.leaveType)) {
            return NextResponse.json(
                { error: 'leaveType is required and must be one of: ' + LEAVE_TYPES.join(', ') },
                { status: 400 }
            );
        }
        const leaveType = body.leaveType as LeaveType;

        // Dates: required, real YYYY-MM-DD calendar dates, endDate >= startDate,
        // startDate not in the past (date-only comparison in Asia/Karachi).
        const startDate = parseDateOnly(body.startDate);
        if (startDate === null) {
            return NextResponse.json(
                { error: 'startDate is required and must be a valid date in YYYY-MM-DD format' },
                { status: 400 }
            );
        }
        const endDate = parseDateOnly(body.endDate);
        if (endDate === null) {
            return NextResponse.json(
                { error: 'endDate is required and must be a valid date in YYYY-MM-DD format' },
                { status: 400 }
            );
        }
        const startDateStr = body.startDate as string;
        const endDateStr = body.endDate as string;
        if (endDate.getTime() < startDate.getTime()) {
            return NextResponse.json(
                { error: 'endDate must be on or after startDate' },
                { status: 400 }
            );
        }
        if (startDateStr < todayInKarachi()) {
            return NextResponse.json(
                { error: 'startDate cannot be in the past' },
                { status: 400 }
            );
        }

        const dayCount = inclusiveDayCount(startDate, endDate);

        // Covering officer: optional, except required when the leave is
        // longer than 3 days (inclusive day count). When present, the user
        // must exist and must not be the requester.
        const rawCoveringOfficerId = body.coveringOfficerId;
        let coveringOfficerId: string | null = null;
        let coveringOfficerName: string | null = null;
        if (typeof rawCoveringOfficerId === 'string' && rawCoveringOfficerId.trim() !== '') {
            coveringOfficerId = rawCoveringOfficerId.trim();
        } else if (rawCoveringOfficerId !== undefined && rawCoveringOfficerId !== null && rawCoveringOfficerId !== '') {
            return NextResponse.json(
                { error: 'coveringOfficerId must be a user id string' },
                { status: 400 }
            );
        }

        if (dayCount > COVERING_REQUIRED_OVER_DAYS && coveringOfficerId === null) {
            return NextResponse.json(
                { error: 'A covering officer is required for leave longer than 3 days' },
                { status: 400 }
            );
        }
        if (coveringOfficerId !== null) {
            if (coveringOfficerId === auth.user.userId) {
                return NextResponse.json(
                    { error: 'coveringOfficerId cannot be your own user id' },
                    { status: 400 }
                );
            }
            const coveringDoc = await db.collection('users').doc(coveringOfficerId).get();
            if (!coveringDoc.exists) {
                return NextResponse.json(
                    { error: 'coveringOfficerId does not match an existing user' },
                    { status: 400 }
                );
            }
            const coveringData = coveringDoc.data() || {};
            coveringOfficerName =
                (typeof coveringData.displayName === 'string' && coveringData.displayName.trim() !== ''
                    ? coveringData.displayName.trim()
                    : null) ||
                (typeof coveringData.email === 'string' && coveringData.email.trim() !== ''
                    ? coveringData.email.trim()
                    : null);
        }

        // Overlap: reject when a pending or approved leave for the same user
        // already covers any day of the requested range.
        const activeSnapshot = await db
            .collection('leave_requests')
            .where('userId', '==', auth.user.userId)
            .where('status', 'in', BLOCKING_STATUSES)
            .get();
        for (const doc of activeSnapshot.docs) {
            const existing = doc.data();
            const existingStart = typeof existing.startDate === 'string' ? existing.startDate : null;
            const existingEnd = typeof existing.endDate === 'string' ? existing.endDate : null;
            if (existingStart === null || existingEnd === null) {
                continue;
            }
            if (existingStart <= endDateStr && startDateStr <= existingEnd) {
                return NextResponse.json(
                    {
                        error: 'This leave overlaps an existing pending or approved leave request',
                        conflictingLeaveRequestId: doc.id,
                    },
                    { status: 409 }
                );
            }
        }

        const notes =
            typeof body.notes === 'string' && body.notes.trim() !== '' ? body.notes.trim() : null;

        const leaveRef = db.collection('leave_requests').doc();
        const leaveData = {
            userId: auth.user.userId,
            reason,
            startDate: startDateStr,
            endDate: endDateStr,
            leaveType,
            coveringOfficerId,
            coveringOfficerName,
            notes,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await leaveRef.set(leaveData);

        return NextResponse.json(
            {
                success: true,
                id: leaveRef.id,
                status: 'pending',
                request: serializeLeaveRequest(leaveRef.id, {
                    ...leaveData,
                    createdAt: null,
                    updatedAt: null,
                }),
                leaveRequest: serializeLeaveRequest(leaveRef.id, {
                    ...leaveData,
                    createdAt: null,
                    updatedAt: null,
                }),
                message: 'Leave request submitted. It is pending review.',
            },
            { status: 201 }
        );
    } catch (error: unknown) {
        console.error('[leave] POST Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to create leave request' },
            { status: 500 }
        );
    }
}

/**
 * PATCH - Cancel the caller's own PENDING leave request.
 * Body: { action: 'cancel', id }. Only cancel is supported; any other
 * action returns 400. Sets status to 'cancelled'. Touches no user flags.
 */
export async function PATCH(req: NextRequest) {
    try {
        const { auth, error: authError } = await requireAuth(req);
        if (authError || !auth) {
            return authError;
        }
        const { db, error: dbError } = requireDb();
        if (dbError || !db) {
            return dbError;
        }

        let body: Record<string, unknown>;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
        }
        if (body.action !== 'cancel') {
            return NextResponse.json(
                { error: "Invalid action. The only supported action is 'cancel'." },
                { status: 400 }
            );
        }
        const leaveId = body.id ?? body.leaveRequestId ?? body.leaveId;
        return cancelLeave(db, auth.user.userId, leaveId);
    } catch (error: unknown) {
        console.error('[leave] PATCH Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to cancel leave request' },
            { status: 500 }
        );
    }
}

/**
 * DELETE - Cancel the caller's own PENDING leave request.
 * Query param: ?id=<leaveRequestId>
 * Sets status to 'cancelled'. Touches no user flags. 403 when the request
 * is not owned by the caller or is not pending. 404 when it does not exist.
 */
export async function DELETE(req: NextRequest) {
    try {
        const { auth, error: authError } = await requireAuth(req);
        if (authError || !auth) {
            return authError;
        }
        const { db, error: dbError } = requireDb();
        if (dbError || !db) {
            return dbError;
        }

        const { searchParams } = new URL(req.url);
        return cancelLeave(db, auth.user.userId, searchParams.get('id'));
    } catch (error: unknown) {
        console.error('[leave] DELETE Error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to cancel leave request' },
            { status: 500 }
        );
    }
}
