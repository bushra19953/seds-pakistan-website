import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import type { PermissionKey } from '@/config/permissions.config';
import * as admin from 'firebase-admin';
import { returnFromLeave } from '@/lib/server/leave-return';
import { karachiTodayString, leaveHasStarted } from '@/lib/server/leave-dates';
import { redirectTasksForLeave } from '@/lib/server/leave-redirect';
import { validateUserStatus } from '@/lib/server/user-status';
import { taskHasProofUploaded } from '@/lib/server/bug4-proof-guards';
import { queueCadetshipEnrolmentInBatch } from '@/lib/server/cadetship/create';
import { mirrorCadetshipSet } from '@/lib/supa-seams/hr-cadetships';
import { isPhase2Live } from '@/lib/server/governance-settings';
import { KNOWN_APPLICATION_STATUSES } from '@/lib/applications/status';
import {
    inboxSupaServerEnabled,
    getInboxSupaServerConfig,
    supaFetchInboxFeeds,
    supaListInboxSourceRows,
    selectUniversalReviewGet,
    supaTimestampToIso,
    mirrorUniversalReviewToSupa,
} from '@/lib/inbox-supa';
import {
    mirrorNotificationCreate,
    userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';
import { isSupaPrimary } from '@/lib/supa/flags';
import { applyPointsAwardViaSupa, type PointsAwardInput } from '@/lib/supa/gamification';
import { mirrorApplicationUpdate, updateApplicationPrimaryFirst } from '@/lib/applications-supa';
import {
    identityPrimaryFlagOn,
    primaryIdentitySet,
} from '@/lib/server/supa-identity-primary';

/**
 * WRITE PRIMACY (identity full build, G-USER-5/G-USER-6/G-USER-7):
 * this route composes ONE Firestore batch across a loop of reviewed
 * items; its users/{uid} ops (points/counter increments U-31, leave
 * flags U-32, skillIds arrayUnion U-30) are additionally collected
 * into a pending list as they are composed and, under
 * isSupaPrimary('users'), flushed to the adapter IN ORDER immediately
 * before batch.commit() — primary first, the batch's native
 * increments/array ops then commit as the reverse mirror (the only
 * race-safe representation on the Firestore side; the primary side
 * resolves the same sentinels by RMW in the identity-primary module,
 * H-04 race stated + bounded there). A primary failure throws into
 * the route's existing batch-error path before any Firestore commit.
 */
type PendingIdentityPrimaryOp = { uid: string; payload: Record<string, unknown> };

async function flushIdentityPrimaryOps(ops: PendingIdentityPrimaryOp[]): Promise<void> {
    if (ops.length === 0) return;
    if (!(await identityPrimaryFlagOn('users'))) return;
    for (const op of ops) {
        await primaryIdentitySet('users', 'users', op.uid, op.payload, { merge: true });
    }
}

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

// Derive the lookup slug for a skill name. Matches the slug scheme used by
// POST /api/skills and the legacy skill migration, so approvals reuse the
// same canonical docs instead of creating near-duplicates.
function slugifySkillName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Wire the free-text skills claimed on an approved application into the
// structured skill graph. Each name resolves to a skills/{id} doc, found by
// slug and created with status 'active' when missing. The resolved ids are
// unioned into users/{uid}.skillIds. Idempotent: find-by-slug plus
// arrayUnion make a second approval a no-op. The slugCache is scoped to the
// request so one batch never creates two docs for the same slug. Returns
// the number of skill ids attached to the user doc.
async function syncApplicationSkillsToUser(
    db: FirebaseFirestore.Firestore,
    batch: FirebaseFirestore.WriteBatch,
    applicantUid: string,
    skillNames: unknown,
    slugCache: Map<string, string>,
    pendingIdentityPrimary?: PendingIdentityPrimaryOp[],
): Promise<number> {
    const rawNames: string[] = Array.isArray(skillNames)
        ? skillNames.filter((v): v is string => typeof v === 'string')
        : typeof skillNames === 'string'
            ? skillNames.split(',')
            : [];
    const bySlug = new Map<string, string>();
    for (const raw of rawNames) {
        const name = raw.trim();
        if (!name) continue;
        const slug = slugifySkillName(name);
        if (!slug || bySlug.has(slug)) continue;
        bySlug.set(slug, name);
    }
    if (bySlug.size === 0) return 0;

    const skillIds: string[] = [];
    for (const [slug, name] of bySlug) {
        let skillId = slugCache.get(slug);
        if (!skillId) {
            const snap = await db.collection('skills').where('slug', '==', slug).limit(1).get();
            if (!snap.empty) {
                skillId = snap.docs[0].id;
            } else {
                const skillRef = db.collection('skills').doc();
                batch.set(skillRef, {
                    name,
                    slug,
                    category: '',
                    status: 'active',
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                skillId = skillRef.id;
            }
            slugCache.set(slug, skillId);
        }
        skillIds.push(skillId);
    }

    const userRef = db.collection('users').doc(applicantUid);
    const skillPayload = {
        skillIds: admin.firestore.FieldValue.arrayUnion(...skillIds),
    };
    batch.set(userRef, skillPayload, { merge: true });
    // G-USER-7 (U-30): the same arrayUnion payload is queued as a
    // primary RMW op (set-union is commutative — H-04 does not apply).
    pendingIdentityPrimary?.push({ uid: applicantUid, payload: skillPayload });
    return skillIds.length;
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

        // Universal Inbox Supabase feed branch (inbox seam): serves all
        // five inbox feeds from the fs_* tables when the 'inbox' surface
        // flag is ON. Any other case (flag OFF, Supabase unconfigured, or
        // a Supabase error) returns non-200 so the page falls back to its
        // Firestore listeners, byte-identical to today. Gated on
        // canManageApplications, the inbox page's own AuthorizationGate
        // permission. DEFECT (c): the feeds object has no form_responses
        // entry; that tab has no data feed in either mode.
        if (searchParams.get('inboxFeeds') === '1') {
            const inboxAuthorized = await hasServerPermissionForUser(getDb()!, auth.user.userId, 'canManageApplications');
            if (!inboxAuthorized) {
                return NextResponse.json({ error: `Forbidden: 'canManageApplications' access required for this collection` }, { status: 403 });
            }
            const config = inboxSupaServerEnabled() ? getInboxSupaServerConfig() : null;
            if (!config) {
                return NextResponse.json({ error: 'Supabase inbox not enabled' }, { status: 404 });
            }
            try {
                const feeds = await supaFetchInboxFeeds(config);
                return NextResponse.json({ success: true, feeds });
            } catch (feedError: any) {
                console.warn(`[Universal Review] Supabase inbox feed failed: ${feedError.message}`);
                return NextResponse.json({ error: 'Supabase inbox unavailable' }, { status: 503 });
            }
        }

        if (!collectionName || !COLLECTION_PERMISSION_MAP[collectionName]) {
            return NextResponse.json({ error: 'Invalid or unsupported collection map' }, { status: 400 });
        }

        const requiredPermission = COLLECTION_PERMISSION_MAP[collectionName];

        // REPLACED: Lazy string array check with strict Granular Claim Check mapped to role.
        const isAuthorized = await hasServerPermissionForUser(getDb()!, auth.user.userId, requiredPermission);

        if (!isAuthorized) {
            return NextResponse.json({ error: `Forbidden: '${requiredPermission}' access required for this collection` }, { status: 403 });
        }

        // Supabase read path (inbox seam): when the 'inbox' surface flag
        // is ON, serve this collection read from its fs_* table with the
        // identical status filter, submittedAt-descending order
        // (orderBy excludes docs missing submittedAt, as in Firestore),
        // limit 100, and ISO timestamp shape. Any Supabase error falls
        // through to the Firestore query below, unchanged.
        if (inboxSupaServerEnabled()) {
            const supaConfig = getInboxSupaServerConfig();
            if (supaConfig) {
                try {
                    const rows = await supaListInboxSourceRows(supaConfig, collectionName);
                    const selected = selectUniversalReviewGet(rows, status);
                    const data = selected.map((row) => {
                        const docData: any = row.data ?? {};
                        return {
                            id: row.id,
                            ...docData,
                            submittedAt: supaTimestampToIso(docData.submittedAt),
                            reviewedAt: supaTimestampToIso(docData.reviewedAt),
                            deadline: supaTimestampToIso(docData.deadline),
                        };
                    });
                    return NextResponse.json({ success: true, data });
                } catch (supaError: any) {
                    console.warn(`[Universal Review] Supabase GET failed, falling back to Firestore. Details: ${supaError.message}`);
                }
            }
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
        let { collection: collectionName, ids, action, notes, points, updatedData, extraFields, reviewDeadline } = body;

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

        const isAuthorized = await hasServerPermissionForUser(getDb()!, auth.user.userId, requiredPermission);
        if (!isAuthorized) {
            return NextResponse.json({ error: `Forbidden: '${requiredPermission}' access required` }, { status: 403 });
        }

        if (!ensureAdminInitialized()) {
            return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
        }
        const db = getDb();
        if (!db) return NextResponse.json({ error: 'Db error' }, { status: 500 });

        // Phase 2 cadetship gate (spec F.6): read once per request. Flag
        // off -> the applications approval path below is byte-identical
        // to its pre-Phase-2 behaviour.
        const cadetshipLive = await isPhase2Live('cadetshipLive').catch(() => false);

        const batch = db.batch();
        const reviewerDoc = await db.collection('users').doc(auth.user.userId).get();
        const reviewerName = reviewerDoc.data()?.displayName || auth.user.email || 'Admin';
        const skippedAlreadyReviewed: string[] = [];
        const failedLeaveRequests: Array<{ id: string; error: string }> = [];
        // Request-scoped skill slug to doc id cache so approving several
        // applications that claim the same new skill creates one skills doc,
        // not one per application.
        const skillSlugCache = new Map<string, string>();
        let skillsSyncedCount = 0;
        // Supabase mirror queue (inbox seam): the reviewed doc's primary
        // mutation per processed id. Firestore stays primary; after the
        // Firestore commit succeeds, each entry is mirrored best-effort
        // (mirror failure never fails the action). Side-effect docs
        // (points ledger, skills, user flags) are not mirrored here; they
        // belong to their own surfaces. GAP-N1: notification writes in
        // this handler get their own queue (notifMirrorOps), flushed to
        // the notifications seam after the same commit.
        const mirrorOps: Array<{ collection: string; id: string; payload: Record<string, any> }> = [];
        // Cadetship batch-mirror queue: enrolments queued into the batch
        // by queueCadetshipEnrolmentInBatch, mirrored to Supabase only
        // AFTER batch.commit() succeeds below (the seam is flag-gated
        // and never throws, so a mirror failure never changes the
        // response). On batch failure the DLQ path returns first and
        // nothing here is mirrored - correctly, since nothing landed.
        const cadetshipMirrors: Array<{ cadetshipId: string; data: Record<string, any> }> = [];
        const notifMirrorOps: Array<{ uid: string; id: string; data: Record<string, unknown> }> = [];
        // C-07: under gamification Supa-primary, points awards computed
        // in the batch below are queued here and claimed post-commit
        // via apply_points_award (the deterministic ledger id replaces
        // this route's terminal-status guard as the Supa-side guard;
        // the terminal-status guard still runs first, unchanged).
        const supaGamePrimary = isSupaPrimary('gamification');
        const pendingGameAwards: PointsAwardInput[] = [];
        const pendingIdentityPrimary: PendingIdentityPrimaryOp[] = [];
        // Leave handover queue: approvals naming a covering officer
        // collect one redirect job per leave request, executed AFTER
        // the review batch commits (a redirect failure must not roll
        // back the approval itself; failures are logged for replay,
        // the same contract as the C-07 points awards below).
        // Approvals with NO covering officer named push a note into
        // leaveRedirectResults instead: short leaves keep their
        // tasks with the member, and that is recorded, not silent.
        const pendingLeaveRedirects: Array<{
            memberUid: string;
            coveringOfficerId: string;
            leaveRequestId: string;
            windowStart: unknown;
            windowEnd: unknown;
            actorId: string;
        }> = [];
        const leaveRedirectResults: Array<Record<string, any>> = [];

        // DEADLINE FAIRNESS (founder rule, 2026-10-26): rejecting a
        // TASK SUBMISSION from this inbox returns the work to the
        // assignee, and a return from review must carry a NEW deadline
        // set by the reviewer. Parsed once here and enforced per doc
        // inside the loop, only for tasks actually carrying a
        // submission (status submitted-for-review, or proof uploaded
        // and awaiting review), after the terminal-status guard, so
        // already-decided items still skip silently. A task reject
        // that fails the mandate is reported in failedTaskRejects and
        // the task is left undecided, never silently rejected back
        // into an already-passed deadline.
        const taskReturnDeadline = (() => {
            if (reviewDeadline == null) return null;
            const d = new Date(reviewDeadline as any);
            return isNaN(d.getTime()) ? null : d;
        })();
        const failedTaskRejects: Array<{ id: string; error: string }> = [];

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
                        const notifData = {
                            type: 'leave_revoked',
                            title: 'Leave revoked',
                            body: notes
                                ? `Your approved leave was revoked by an admin. Reason: ${notes}`
                                : 'Your approved leave was revoked by an admin. Your tasks have been returned to you.',
                            link: '/profile',
                            isRead: false,
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        };
                        await notifRef.set(notifData);
                        // GAP-N1: Supabase mirror (flag-gated, non-throwing;
                        // Firestore stays primary).
                        await mirrorNotificationCreate(userNotificationsPath(targetUid), notifRef.id, notifData);
                    } catch (notifError: any) {
                        console.error(
                            `[universal-review PATCH revoke] Notification failed for ${collectionName}/${id}:`,
                            notifError,
                        );
                    }

                    if (!returnResult.alreadyReturned) {
                        mirrorOps.push({
                            collection: 'leave_requests',
                            id,
                            payload: {
                                status: 'completed',
                                revokedAt: new Date().toISOString(),
                                revokedBy: auth.user.userId,
                                revocationReason: typeof notes === 'string' ? notes : null,
                                updatedAt: new Date().toISOString(),
                            },
                        });
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

            for (const op of mirrorOps) {
                await mirrorUniversalReviewToSupa(op.collection, op.id, op.payload);
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

            // Terminal-status idempotency guard (Item 4). Generalized
            // from the leave-only guard to ALL collections. Must run
            // BEFORE the updatedData merge and BEFORE any batch write is
            // queued for this id. If the doc is already in a terminal
            // state (approved, rejected, cancelled, completed), skip it
            // entirely: no status flip, no flag set, no audit, no
            // notification, no points. This prevents a repeat approve
            // from re-awarding points via FieldValue.increment and a
            // second points_ledger doc.
            let priorStatus = '';
            {
                priorStatus = typeof docData.status === 'string' ? docData.status.toLowerCase() : '';
                if (priorStatus === 'approved' || priorStatus === 'rejected' || priorStatus === 'cancelled' || priorStatus === 'completed') {
                    skippedAlreadyReviewed.push(id);
                    continue;
                }
            }

            // Deadline-fairness mandate for task returns (see the
            // taskReturnDeadline note above): a task carrying a
            // submission (submitted-for-review, or proof uploaded and
            // awaiting review, the two shapes the inbox queue lists)
            // can only be rejected WITH a usable future deadline.
            const isTaskReturn = effectiveCollection === 'tasks' && action === 'reject'
                && (priorStatus === 'submitted-for-review' || taskHasProofUploaded(docData));
            if (isTaskReturn && (!taskReturnDeadline || taskReturnDeadline.getTime() <= Date.now())) {
                failedTaskRejects.push({
                    id,
                    error: !taskReturnDeadline
                        ? 'A new deadline is mandatory for rejecting a task submission'
                        : 'The new deadline for a rejected task must be in the future',
                });
                continue;
            }

            // Tasks have ONE canonical terminal spelling: an inbox
            // approval of a task lands on 'completed', never the legacy
            // 'approved' (which stranded tasks off the profile board and
            // out of History). Other collections keep their own
            // 'approved' lifecycle. A rejected task SUBMISSION lands on
            // the canonical return status 'changes-requested' (the
            // legacy 'rejected' was a foreign status with no resubmit
            // path, TS-P16); rejects of tasks carrying no submission
            // keep the legacy spelling.
            const newStatus = action === 'approve'
                ? (effectiveCollection === 'tasks' ? 'completed' : 'approved')
                : (isTaskReturn ? 'changes-requested' : 'rejected');
            const pointsRecipient = resolvePointsRecipient(docData);

            const updatePayload: any = {
                status: newStatus,
                reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
                reviewedBy: auth.user.userId,
                reviewerDisplayName: reviewerName,
                reviewNotes: notes || null,
            };

            // Deadline fairness: a task return carries the reviewer's
            // NEW deadline into the task's effective deadline field
            // (individualDeadline for workflow steps, deadline for
            // plain tasks) and records the return in feedback_history
            // with the submission instant it answers, the same record
            // the tasks API writes for its changes-requested returns.
            if (isTaskReturn && taskReturnDeadline) {
                if (docData.individualDeadline != null) {
                    updatePayload.individualDeadline = taskReturnDeadline;
                } else {
                    updatePayload.deadline = taskReturnDeadline;
                }
                updatePayload.feedback_history = admin.firestore.FieldValue.arrayUnion({
                    admin_id: auth.user.userId,
                    timestamp: new Date(),
                    text: typeof notes === 'string' ? notes : '',
                    previous_status: priorStatus || 'unknown',
                    submitted_at: docData.submittedAt ?? null,
                    new_deadline: taskReturnDeadline.toISOString(),
                });
            }

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
                    if (supaGamePrimary) {
                        // C-07 guard swap: points + ledger are claimed
                        // post-commit by the RPC. Only the submissions
                        // counter stays in this batch — it is not a
                        // gamification counter and the RPC has no
                        // submissionsApprovedCount.
                        if (effectiveCollection === 'submissions') {
                            const counterPayload = {
                                submissionsApprovedCount: admin.firestore.FieldValue.increment(1)
                            };
                            batch.set(userRef, counterPayload, { merge: true });
                            pendingIdentityPrimary.push({ uid: pointsRecipient, payload: counterPayload });
                        }
                        pendingGameAwards.push({
                            taskId: id,
                            userId: pointsRecipient,
                            action: 'COMPLETION',
                            points,
                        });
                    } else {
                    // SEC-RACE (audit item 11): the terminal-status guard
                    // above reads the doc BEFORE this batch is composed,
                    // so two concurrent approvals could both pass it and
                    // both award. The award is therefore claimed HERE,
                    // inside runTransaction (the gamification-transaction
                    // pattern), keyed on a deterministic ledger doc
                    // (ur_<collection>_<id>): the transaction re-reads
                    // the reviewed doc's status AND the claim doc, and
                    // the user increment + ledger entry commit atomically
                    // with the claim. Outcomes:
                    // - 'claimed': this call won the award; the rest of
                    //   the review (status flip etc.) proceeds in the
                    //   batch below. If that batch later fails, the DLQ
                    //   retry re-enters, gets 'already-awarded', and
                    //   completes the flip without re-paying.
                    // - 'already-awarded': a concurrent winner already
                    //   paid; proceed with the status flip only, and do
                    //   not restamp pointsAwarded with this call's value.
                    // - 'already-terminal': the winner's review fully
                    //   committed; skip this doc entirely.
                    const pointsPayload = {
                        total_points: admin.firestore.FieldValue.increment(points),
                        points: admin.firestore.FieldValue.increment(points), // keep legacy for compatibility if needed
                        ...(effectiveCollection === 'submissions' ? { submissionsApprovedCount: admin.firestore.FieldValue.increment(1) } : {})
                    };
                    const claimRef = db.collection('points_ledger').doc(`ur_${effectiveCollection}_${id}`);
                    const claimOutcome = await db.runTransaction(async (t) => {
                        const claimSnap = await t.get(claimRef);
                        const freshSnap = await t.get(docRef);
                        const freshStatus = typeof freshSnap.data()?.status === 'string'
                            ? (freshSnap.data()!.status as string).toLowerCase()
                            : '';
                        const freshTerminal = freshStatus === 'approved' || freshStatus === 'rejected' || freshStatus === 'cancelled' || freshStatus === 'completed';
                        if (claimSnap.exists) {
                            return freshTerminal ? 'already-terminal' as const : 'already-awarded' as const;
                        }
                        if (freshTerminal) return 'already-terminal' as const;
                        // Points Ledger strictly mandated. user_id is the
                        // resolved recipient, never undefined.
                        t.set(claimRef, {
                            user_id: pointsRecipient,
                            task_id: id,
                            points_awarded: points,
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                            status: 'PROCESSED'
                        });
                        t.set(userRef, pointsPayload, { merge: true });
                        return 'claimed' as const;
                    });
                    if (claimOutcome === 'already-terminal') {
                        skippedAlreadyReviewed.push(id);
                        continue;
                    }
                    if (claimOutcome === 'claimed') {
                        // G-USER-5 (U-31): queued as a primary RMW op —
                        // points + submissionsApprovedCount land in ONE
                        // adapter update (IC-10 mixed-payload rule).
                        pendingIdentityPrimary.push({ uid: pointsRecipient, payload: pointsPayload });
                    } else {
                        delete updatePayload.pointsAwarded;
                    }
                    }
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

            // Application approvals wire the applicant's claimed skills
            // (free-text array on applications/{uid}.skills) into the
            // structured skill graph: find-or-create skills docs by slug,
            // arrayUnion their ids onto users/{uid}.skillIds. Idempotent by
            // construction, so a repeated approval adds nothing new.
            if (action === 'approve' && effectiveCollection === 'applications' && pointsRecipient) {
                const synced = await syncApplicationSkillsToUser(db, batch, pointsRecipient, docData.skills, skillSlugCache, pendingIdentityPrimary);
                skillsSyncedCount += synced;
            }

            // Cadetship enrolment (spec F.6): approval is the SINGLE entry
            // point into the cadetship pipeline. The create joins THIS
            // batch, so approval and enrolment commit atomically; if
            // enrolment throws, the shared catch aborts before
            // batch.commit() and the approval fails with it. Idempotent:
            // an application already stamped with a cadetshipId is left
            // alone, and the create itself no-ops when a live cadetship
            // exists. Skipped entirely while the cadetshipLive flag is off.
            if (
                action === 'approve' &&
                effectiveCollection === 'applications' &&
                cadetshipLive &&
                pointsRecipient &&
                (KNOWN_APPLICATION_STATUSES as readonly string[]).includes(newStatus)
            ) {
                if (typeof docData.cadetshipId === 'string' && docData.cadetshipId !== '') {
                    updatePayload.cadetshipId = docData.cadetshipId;
                } else {
                    let chapterId = typeof docData.chapterId === 'string' ? docData.chapterId : '';
                    if (!chapterId) {
                        const applicantSnap = await db.collection('users').doc(pointsRecipient).get();
                        const userChapter = applicantSnap.data()?.chapterId;
                        chapterId = typeof userChapter === 'string' ? userChapter : '';
                    }
                    const enrolment = await queueCadetshipEnrolmentInBatch(db, batch, {
                        personUid: pointsRecipient,
                        applicationId: id,
                        chapterId,
                        createdVia: 'application_approval',
                        startedAt: new Date(),
                        openedBy: 'system',
                    });
                    updatePayload.cadetshipId = enrolment.cadetshipId;
                    if (enrolment.created && enrolment.cadetshipData) {
                        cadetshipMirrors.push({
                            cadetshipId: enrolment.cadetshipId,
                            data: { ...enrolment.cadetshipData },
                        });
                    }
                    if (enrolment.created) {
                        // Governance audit joins the batch too (atomic with
                        // the approval), which is stronger than the
                        // writeGovernanceAuditOrThrow contract.
                        const auditRef = db.collection('audit_logs').doc();
                        batch.set(auditRef, {
                            actorUid: auth.user.userId,
                            action: 'cadetship.enrolled',
                            subjectType: 'cadetship',
                            subjectId: enrolment.cadetshipId,
                            details: {
                                applicationId: id,
                                cohortId: enrolment.cohortId,
                                createdVia: 'application_approval',
                            },
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    }
                }
            }

            batch.update(docRef, updatePayload);

            // Queue the Supabase mirror of this reviewed doc's update.
            // reviewedAt is a serverTimestamp sentinel in updatePayload;
            // the mirror stamps the same instant as an ISO string. The
            // feedback_history FieldValue sentinel cannot cross the
            // REST mirror, so it is stripped here; the entry lives in
            // Firestore and rides the next doc-level mirror of the
            // tasks surface.
            const mirrorPayload: Record<string, any> = { ...updatePayload, reviewedAt: new Date().toISOString() };
            delete mirrorPayload.feedback_history;
            mirrorOps.push({
                collection: effectiveCollection,
                id,
                payload: mirrorPayload,
            });

            // Leave-specific side effect, queued AFTER the status flip
            // in the same batch, so the status flip, the flag set, the
            // audit write, and the notification commit atomically. Reject
            // queues nothing here: no flags, no audit.
            //
            // Lifecycle fix (2026-10-28): the flags are stamped here
            // ONLY when the leave has already started (start date on
            // or before today, Asia/Karachi). A future leave is
            // approved WITHOUT flags; the daily leave-lifecycle sweep
            // (src/lib/server/leave-lifecycle.ts) stamps them when
            // the start date arrives and clears them when the leave
            // ends. Stamping at approval for a future leave blocked
            // all assignment to the member from the approval moment.
            if (isLeave && action === 'approve' && leaveRequesterUid) {
                const leaveStartDate = docData.startDate || docData.start_date || null;
                const leaveEndDate = docData.endDate || docData.end_date || null;
                const leaveCoveringOfficerId = normalizeLeaveString(docData.coveringOfficerId ?? docData.covering_officer_id);

                if (leaveHasStarted(leaveStartDate, karachiTodayString())) {
                    const leaveUserRef = db.collection('users').doc(leaveRequesterUid);
                    const leaveFlagPayload = {
                        isOnVacation: true,
                        vacationMode: true,
                        coveringOfficerId: leaveCoveringOfficerId,
                        vacationStartDate: leaveStartDate,
                        vacationEndDate: leaveEndDate,
                        leaveRequestId: id,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    batch.set(leaveUserRef, leaveFlagPayload, { merge: true });
                    // G-USER-6 (U-32): queued as a primary op; the batch
                    // set stays as the reverse mirror (validateUserStatus
                    // readers on Firestore must not see a stale
                    // not-on-vacation copy).
                    pendingIdentityPrimary.push({ uid: leaveRequesterUid, payload: leaveFlagPayload });
                }

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

            // Leave handover (redirect-out): queue the member's
            // in-window live tasks for reassignment to the covering
            // officer. Execution is post-commit (see
            // pendingLeaveRedirects above) so a redirect failure
            // never rolls back the approval. The values are derived
            // here from docData, independent of the flag block
            // above. With NO covering officer named there is nothing
            // to redirect to: the tasks stay with the member, and
            // that outcome is noted in the result and the log
            // instead of passing silently.
            if (isLeave && action === 'approve' && leaveRequesterUid) {
                const redirectOfficerId = normalizeLeaveString(docData.coveringOfficerId ?? docData.covering_officer_id);
                if (redirectOfficerId) {
                    pendingLeaveRedirects.push({
                        memberUid: leaveRequesterUid,
                        coveringOfficerId: redirectOfficerId,
                        leaveRequestId: id,
                        windowStart: docData.startDate || docData.start_date || null,
                        windowEnd: docData.endDate || docData.end_date || null,
                        actorId: auth.user.userId,
                    });
                } else {
                    leaveRedirectResults.push({
                        leaveRequestId: id,
                        note: 'no_covering_officer_named',
                        redirectedCount: 0,
                        redirectedTaskIds: [],
                        skipped: [],
                    });
                    console.log(`[universal-review PATCH] Leave ${id} approved with no covering officer named; tasks stay with ${leaveRequesterUid}, no redirect queued.`);
                }
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
                const notifData = {
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
                };
                batch.set(notifRef, notifData);
                notifMirrorOps.push({ uid: notifyRecipient, id: notifRef.id, data: notifData });
            }
        }

        // If the transaction fails, the task must not be marked as approved. The system must throw an error,
        // revert to PENDING, and trigger an automated retry.
            // WRITE PRIMACY flush: adapter ops land BEFORE the
            // Firestore batch commits (primary first); a primary
            // failure throws into the batch-error path below with
            // zero Firestore writes from this handler.
            await flushIdentityPrimaryOps(pendingIdentityPrimary);
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

        // Firestore commit succeeded: mirror the reviewed docs to
        // Supabase best-effort (never throws, never changes the outcome).
        for (const op of mirrorOps) {
            await mirrorUniversalReviewToSupa(op.collection, op.id, op.payload);
            // Applications mirror completeness (apps-1): the inbox-seam
            // mirror above is gated on the 'inbox' surface token, so
            // applications reviews ALSO mirror through the applications
            // seam (same fs_applications row, same payload) — the
            // surface's own dual-write no longer depends on the inbox
            // flag. Write primacy (isSupaPrimary('applications')): the
            // applications-seam primary update is the COMMIT GATE — it
            // throws on failure and the route answers 500 instead of
            // reporting success while the primary store holds stale
            // state (the tasks PATCH pattern; the batch above already
            // committed, which is the named two-phase residual).
            if (op.collection === 'applications') {
                const gated = await updateApplicationPrimaryFirst(op.id, op.payload);
                if (!gated) {
                    await mirrorApplicationUpdate(op.id, op.payload);
                }
            }
        }
        // GAP-N1: mirror the committed notification writes the same way.
        for (const m of notifMirrorOps) {
            await mirrorNotificationCreate(userNotificationsPath(m.uid), m.id, m.data);
        }

        // Leave handover: run the queued task redirects now that the
        // approval batch has committed. validateUserStatus is the
        // platform's own assignment gate, so a covering officer who
        // cannot receive work (on leave themselves, banned) fails
        // closed inside the helper and every affected task is
        // skipped with a recorded reason, never forced. A helper
        // failure is logged for operator replay and reported in the
        // response; the approval itself already landed.
        for (const redirectJob of pendingLeaveRedirects) {
            try {
                const redirectResult = await redirectTasksForLeave(db, {
                    ...redirectJob,
                    checkAssigneeEligible: validateUserStatus,
                });
                leaveRedirectResults.push({
                    leaveRequestId: redirectJob.leaveRequestId,
                    redirectedCount: redirectResult.redirectedTaskIds.length,
                    redirectedTaskIds: redirectResult.redirectedTaskIds,
                    skipped: redirectResult.skipped,
                });
            } catch (redirectError: any) {
                console.error('[universal-review PATCH] Leave task redirect failed post-commit; approval already committed, redirect needs operator replay:', redirectJob.leaveRequestId, redirectError);
                leaveRedirectResults.push({
                    leaveRequestId: redirectJob.leaveRequestId,
                    error: redirectError?.message || String(redirectError),
                    redirectedCount: 0,
                    redirectedTaskIds: [],
                    skipped: [],
                });
            }
        }

        // C-07: claim the queued points awards on the Supa primary now
        // that the review batch has committed. A duplicate result is
        // the unified guard working (the same doc's award was already
        // claimed by another caller). A null result is logged for
        // operator replay; the review outcome itself already landed.
        for (const award of pendingGameAwards) {
            const awardResult = await applyPointsAwardViaSupa(award);
            if (awardResult === null) {
                console.error('[universal-review PATCH] C-07 post-commit points award did not land on Supa primary; review already committed, award needs operator replay:', award);
            }
        }

        // Same post-commit point for cadetships created inside the
        // batch: mirror the queued enrolment body now that it has
        // actually landed in Firestore.
        for (const cadetshipMirror of cadetshipMirrors) {
            await mirrorCadetshipSet(cadetshipMirror.cadetshipId, cadetshipMirror.data);
        }

        return NextResponse.json({
            success: true,
            message: `Successfully processed ${ids.length} records.`,
            skippedAlreadyReviewed,
            failedLeaveRequests,
            failedTaskRejects,
            skillsSynced: skillsSyncedCount,
            leaveRedirects: leaveRedirectResults
        });

    } catch (error: any) {
        console.error('[universal-review PATCH] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
