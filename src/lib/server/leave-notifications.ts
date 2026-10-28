/**
 * Leave submission notifications (server-side).
 *
 * Defect fixed: submitting a leave request used to notify NOBODY.
 * Admins holding the review permission never learned a request was
 * waiting, and the member named as covering officer was never told.
 *
 * Channel policy: in-app only, mirroring how request_approved /
 * request_rejected / leave_revoked are written by the universal-review
 * route (same doc shape, same Supabase seam mirror). Email is NOT sent:
 * the templated sender (sendEmailNotification) accepts only the six
 * task templates, and the generic sendRawEmail path skips the member
 * email opt-out check; see the leave fix report for the full reasoning.
 *
 * Every export is non-throwing: a notification failure must never fail
 * the leave submission itself.
 */

import { admin } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';
import { permissionsConfig } from '@/config/permissions.config';
import { LEGACY_TO_CATALOG } from '@/lib/role-catalog';
import {
    mirrorNotificationCreate,
    userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';

/** The one permission that gates leave review (universal-review route). */
export const LEAVE_REVIEW_PERMISSION = 'canManageApplications' as const;

/**
 * Defensive caps. The granting-role set is bounded by the role catalog,
 * and the recipient set by the holders of those roles; the caps only
 * guard against a pathological data state turning one submission into
 * an unbounded fan-out.
 */
export const MAX_GRANTING_ROLE_SLUGS = 25;
export const MAX_LEAVE_REVIEW_RECIPIENTS = 100;

export const LEAVE_TYPE_LABELS: Record<string, string> = {
    annual: 'Annual leave',
    sick: 'Sick leave',
    emergency: 'Emergency leave',
    exam: 'Exam leave',
    personal: 'Personal leave',
};

type FirestoreDb = FirebaseFirestore.Firestore;

interface LeaveNotificationContent {
    type: string;
    title: string;
    body: string;
    link: string;
}

/**
 * Write one in-app notification in the exact shape the universal-review
 * route uses for request_approved / request_rejected / leave_revoked,
 * then mirror it through the notifications seam (flag-gated,
 * non-throwing; Firestore stays primary).
 */
async function writeLeaveNotification(
    db: FirestoreDb,
    userId: string,
    content: LeaveNotificationContent,
): Promise<void> {
    const notifRef = db.collection('users').doc(userId).collection('notifications').doc();
    const notifData = {
        type: content.type,
        title: content.title,
        body: content.body,
        link: content.link,
        isRead: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };
    await notifRef.set(notifData);
    await mirrorNotificationCreate(userNotificationsPath(userId), notifRef.id, notifData);
}

/**
 * Candidate role slugs whose holders might hold the leave review
 * permission: every role doc id in roleDefinitions and permissions,
 * every role named anywhere in the static permissions config, every
 * legacy/catalog token in LEGACY_TO_CATALOG, plus the two blanket
 * slugs. Bounded by the role catalog, never by the user count.
 */
async function candidateRoleSlugs(db: FirestoreDb): Promise<string[]> {
    const slugs = new Set<string>(['superadmin', 'founder_patron']);
    for (const roles of Object.values(permissionsConfig)) {
        for (const role of roles) slugs.add(role);
    }
    for (const [legacy, catalog] of Object.entries(LEGACY_TO_CATALOG)) {
        slugs.add(legacy);
        slugs.add(catalog);
    }
    for (const collectionName of ['roleDefinitions', 'permissions'] as const) {
        try {
            const snap = await db.collection(collectionName).get();
            for (const docSnap of snap.docs) slugs.add(docSnap.id);
        } catch (error) {
            console.warn(`[leave-notifications] Could not list ${collectionName}:`, error);
        }
    }
    return [...slugs];
}

/**
 * Resolve the uids of every user holding the leave review permission.
 *
 * Method: compute the granting role slugs by running each candidate
 * slug through hasServerPermission (the same resolver the review gate
 * uses, so dynamic roleDefinitions grants, the legacy permissions
 * fallback, the static config, and the superadmin/founder blanket all
 * resolve identically), then enumerate holders of those slugs with the
 * same query set the role-permissions route uses to find role holders
 * (roles.role, roles.additionalRoles, users.role, users.displayRole,
 * users.additionalRoles). The requester is excluded. The result is
 * capped at MAX_LEAVE_REVIEW_RECIPIENTS.
 */
export async function findLeaveReviewerUids(
    db: FirestoreDb,
    excludeUid?: string,
): Promise<string[]> {
    const candidates = await candidateRoleSlugs(db);
    const granting: string[] = [];
    for (const slug of candidates) {
        if (granting.length >= MAX_GRANTING_ROLE_SLUGS) break;
        try {
            if (await hasServerPermission(slug, LEAVE_REVIEW_PERMISSION)) {
                granting.push(slug);
            }
        } catch (error) {
            console.warn(`[leave-notifications] Permission check failed for role ${slug}:`, error);
        }
    }
    if (granting.length === 0) return [];

    const uids = new Set<string>();
    const holderQueries: Array<Promise<void>> = [];
    const collectFrom = async (
        collectionName: 'roles' | 'users',
        field: string,
        op: '==' | 'array-contains',
        slug: string,
    ) => {
        try {
            const snap = await db.collection(collectionName).where(field, op, slug).get();
            for (const docSnap of snap.docs) uids.add(docSnap.id);
        } catch (error) {
            console.warn(
                `[leave-notifications] Holder lookup failed (${collectionName}.${field} ${op} ${slug}):`,
                error,
            );
        }
    };
    for (const slug of granting) {
        holderQueries.push(collectFrom('roles', 'role', '==', slug));
        holderQueries.push(collectFrom('roles', 'additionalRoles', 'array-contains', slug));
        holderQueries.push(collectFrom('users', 'role', '==', slug));
        holderQueries.push(collectFrom('users', 'displayRole', '==', slug));
        holderQueries.push(collectFrom('users', 'additionalRoles', 'array-contains', slug));
    }
    await Promise.all(holderQueries);

    if (excludeUid) uids.delete(excludeUid);
    return [...uids].slice(0, MAX_LEAVE_REVIEW_RECIPIENTS);
}

export interface LeaveSubmittedNotice {
    leaveRequestId: string;
    requesterUid: string;
    requesterName: string;
    leaveType: string;
    startDate: string;
    endDate: string;
    coveringOfficerId: string | null;
}

export interface LeaveSubmittedFanoutResult {
    reviewerCount: number;
    coveringOfficerNotified: boolean;
}

/**
 * Fan out the two submission notices:
 *  (a) every holder of the leave review permission: a leave request
 *      awaits review, with the member's name and the leave dates;
 *  (b) the covering officer, when one is named: they have been named
 *      covering officer for those dates.
 * Non-throwing: per-recipient failures are logged, never propagated.
 */
export async function notifyLeaveSubmitted(
    db: FirestoreDb,
    notice: LeaveSubmittedNotice,
): Promise<LeaveSubmittedFanoutResult> {
    const result: LeaveSubmittedFanoutResult = {
        reviewerCount: 0,
        coveringOfficerNotified: false,
    };
    const typeLabel = LEAVE_TYPE_LABELS[notice.leaveType] || 'Leave';
    const dates = `${notice.startDate} to ${notice.endDate}`;

    try {
        const reviewerUids = await findLeaveReviewerUids(db, notice.requesterUid);
        const reviewContent: LeaveNotificationContent = {
            type: 'leave_request_submitted',
            title: 'Leave Request Awaiting Review',
            body: `${notice.requesterName} requested ${typeLabel} from ${dates}. A leave request awaits your review.`,
            link: '/admin/submissions',
        };
        await Promise.all(
            reviewerUids.map(async (uid) => {
                try {
                    await writeLeaveNotification(db, uid, reviewContent);
                    result.reviewerCount += 1;
                } catch (error) {
                    console.error(`[leave-notifications] Reviewer notice failed for ${uid}:`, error);
                }
            }),
        );
    } catch (error) {
        console.error('[leave-notifications] Reviewer fan-out failed:', error);
    }

    if (notice.coveringOfficerId && notice.coveringOfficerId !== notice.requesterUid) {
        try {
            await writeLeaveNotification(db, notice.coveringOfficerId, {
                type: 'leave_covering_officer_named',
                title: 'Named as Covering Officer',
                body: `${notice.requesterName} named you as covering officer for their ${typeLabel} from ${dates}.`,
                link: '/profile',
            });
            result.coveringOfficerNotified = true;
        } catch (error) {
            console.error(
                `[leave-notifications] Covering officer notice failed for ${notice.coveringOfficerId}:`,
                error,
            );
        }
    }

    return result;
}
