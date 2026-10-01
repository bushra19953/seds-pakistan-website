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
}

interface AdminNotificationPayload extends NotificationPayload {
    targetRoles: string[];
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
        ...payload,
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

    // Find all users with matching roles
    const usersRef = db.collection('users');
    let usersQuery = usersRef.where('role', 'in', targetRoles);
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
            ...notificationPayload,
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
        ...payload,
        isGlobal: true,
        read: false,
        createdAt: admin.firestore.Timestamp.now(),
    };

    const docRef = await notificationRef.add(notificationData);
    console.log(`[notification-helper] Created global notification ${docRef.id}`);

    return docRef.id;
}
