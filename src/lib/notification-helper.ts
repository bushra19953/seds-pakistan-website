/**
 * Notification Helper Functions
 * Server-side utility for creating notifications using Firebase Admin SDK
 */

import admin from 'firebase-admin';

interface NotificationPayload {
    title: string;
    message: string;
    type: string;
    link?: string;
    metadata?: Record<string, any>;
    /**
     * Optional task whose instruction brief this notification points at.
     * When set (and no explicit `link` is given), the created notification
     * is assigned a durable deep link to the in-platform instruction view
     * via buildInstructionDeepLink, so the brief survives channels that
     * auto-delete (e.g. WhatsApp disappearing messages).
     */
    taskId?: string;
    /**
     * 1-based revision number of the instruction brief to open, matching
     * InstructionVersion.version in instruction-retention.ts. Carried in the
     * deep link so a notification received today still opens the exact brief
     * revision weeks later, even if the brief was republished since.
     */
    instructionVersion?: number;
}

interface AdminNotificationPayload extends NotificationPayload {
    targetRoles: string[];
}

/**
 * Payload for createTaskInstructionNotification. `taskId` is required;
 * `instructionVersion` pins the exact brief revision the deep link opens.
 */
export interface TaskInstructionNotificationPayload {
    taskId: string;
    instructionVersion?: number;
    title: string;
    message: string;
    type?: string;
    /**
     * Explicit link override. Rarely needed; when omitted the durable
     * instruction deep link is used.
     */
    link?: string;
    metadata?: Record<string, any>;
}

/**
 * Build the durable deep link to the in-platform instruction view for a task.
 *
 * Format: /tasks/<taskId>?instructionVersion=<version>
 *
 * The version is carried as a query param so the notification document stays
 * self-contained: any renderer that reads `link` (notification center,
 * /notifications page, push payloads) opens the exact brief revision without
 * depending on message text that may have been auto-deleted elsewhere.
 */
export function buildInstructionDeepLink(taskId: string, instructionVersion?: number): string {
    const safeId = encodeURIComponent(taskId);
    const base = `/tasks/${safeId}`;
    if (typeof instructionVersion === 'number' && Number.isFinite(instructionVersion)) {
        const version = Math.max(1, Math.floor(instructionVersion));
        return `${base}?instructionVersion=${encodeURIComponent(String(version))}`;
    }
    return base;
}

/**
 * Enrich a notification payload with the instruction deep link.
 *
 * Rules:
 * - No `taskId` on the payload: returned unchanged (backward compatible).
 * - Explicit `link` already set: the caller's link wins; only metadata is
 *   enriched so the identifiers survive even if link rendering changes.
 * - Otherwise: `link` is filled from buildInstructionDeepLink(taskId,
 *   instructionVersion), and `taskId`/`instructionVersion` are mirrored into
 *   `metadata` (explicit metadata keys win on collision) for durability.
 */
function withInstructionDeepLink<T extends NotificationPayload>(payload: T): T {
    if (!payload.taskId) {
        return payload;
    }

    const { taskId, instructionVersion } = payload;
    const identifierMetadata: Record<string, any> = { taskId };
    if (typeof instructionVersion === 'number' && Number.isFinite(instructionVersion)) {
        identifierMetadata.instructionVersion = Math.max(1, Math.floor(instructionVersion));
    }

    const metadata = {
        ...identifierMetadata,
        ...(payload.metadata ?? {}),
    };

    if (payload.link) {
        return { ...payload, metadata };
    }

    return {
        ...payload,
        link: buildInstructionDeepLink(taskId, instructionVersion),
        metadata,
    };
}

/**
 * Create a notification for a specific user
 */
export async function createNotificationToUser(
    db: admin.firestore.Firestore,
    userId: string,
    payload: NotificationPayload
): Promise<string> {
    const notificationRef = db.collection('users').doc(userId).collection('notifications');

    const notificationData = {
        ...withInstructionDeepLink(payload),
        userId,
        read: false,
        createdAt: admin.firestore.Timestamp.now(),
    };

    const docRef = await notificationRef.add(notificationData);
    console.log(`[notification-helper] Created notification ${docRef.id} for user ${userId}`);

    return docRef.id;
}

/**
 * Create notifications for all users with specific roles (admin broadcast)
 */
export async function createAdminNotification(
    db: admin.firestore.Firestore,
    payload: AdminNotificationPayload
): Promise<number> {
    const { targetRoles, ...notificationPayload } = payload;
    const enrichedPayload = withInstructionDeepLink(notificationPayload);

    // Find all users with matching roles
    const usersRef = db.collection('users');
    const usersQuery = usersRef.where('role', 'in', targetRoles);
    const usersSnap = await usersQuery.get();

    if (usersSnap.empty) {
        console.log('[notification-helper] No users found with roles:', targetRoles);
        return 0;
    }

    const batch = db.batch();
    let count = 0;

    for (const userDoc of usersSnap.docs) {
        const userId = userDoc.id;
        const notificationRef = db.collection('users').doc(userId).collection('notifications').doc();

        batch.set(notificationRef, {
            ...enrichedPayload,
            userId,
            read: false,
            createdAt: admin.firestore.Timestamp.now(),
        });

        count++;
    }

    await batch.commit();
    console.log(`[notification-helper] Created ${count} admin notifications for roles:`, targetRoles);

    return count;
}

/**
 * Create a global notification (stored in top-level notifications collection)
 */
export async function createGlobalNotification(
    db: admin.firestore.Firestore,
    payload: NotificationPayload
): Promise<string> {
    const notificationRef = db.collection('notifications');

    const notificationData = {
        ...withInstructionDeepLink(payload),
        isGlobal: true,
        read: false,
        createdAt: admin.firestore.Timestamp.now(),
    };

    const docRef = await notificationRef.add(notificationData);
    console.log(`[notification-helper] Created global notification ${docRef.id}`);

    return docRef.id;
}

/**
 * Create a task-instruction notification: points the assignee at the durable
 * in-platform instruction view instead of (or alongside) an ephemeral
 * WhatsApp brief, so disappearing messages cannot lose the brief.
 *
 * The stored notification gets:
 * - `link`: the durable deep link from buildInstructionDeepLink
 * - `metadata.taskId` / `metadata.instructionVersion`: the identifiers, so
 *   the right brief revision can be resolved even if the link format changes.
 */
export async function createTaskInstructionNotification(
    db: admin.firestore.Firestore,
    userId: string,
    payload: TaskInstructionNotificationPayload
): Promise<string> {
    if (!payload.taskId || typeof payload.taskId !== 'string' || payload.taskId.trim() === '') {
        throw new Error('[notification-helper] createTaskInstructionNotification requires a non-empty taskId.');
    }

    return createNotificationToUser(db, userId, {
        title: payload.title,
        message: payload.message,
        type: payload.type ?? 'task_instruction',
        taskId: payload.taskId,
        instructionVersion: payload.instructionVersion,
        link: payload.link,
        metadata: payload.metadata,
    });
}
