/**
 * Server-side Push Notification Sender
 * 
 * Uses Firebase Admin SDK to send push notifications to FCM tokens.
 * This file should only be imported in API routes or server components.
 */

import * as admin from 'firebase-admin';
import { getDb } from '@/lib/server/firebase-admin';
import {
    identityPrimaryFlagOn,
    primaryIdentitySet,
} from './supa-identity-primary';

/**
 * Send a push notification to a user's devices
 *
 * @param userId - The user's UID
 * @param notification - The notification content
 * @param prefetchedUserData - Optional: the caller's already-fetched
 *   users/{uid} document data. Callers that have just read the user doc
 *   themselves (NotificationService.send / broadcastByRoles) pass it so
 *   one send costs ONE user-doc read instead of two identical gets.
 *   The caller must only pass data from a doc it verified exists (the
 *   not-found branch below is unreachable on that path, exactly as the
 *   caller's own existence check already returned early). Omit it and
 *   the doc is fetched here, as before.
 * @returns Array of results for each token
 */
export async function sendPushToUser(
    userId: string,
    notification: {
        title: string;
        body: string;
        link?: string;
        icon?: string;
        tag?: string;
    },
    prefetchedUserData?: Record<string, any>
): Promise<{ success: boolean; sent: number; failed: number }> {
    const db = getDb();
    if (!db) {
        console.warn('[push-server] Firestore not available');
        return { success: false, sent: 0, failed: 0 };
    }

    try {
        // Get user's FCM tokens (from the caller's identical fetch when
        // one was passed; otherwise read the doc here).
        let userData: Record<string, any> | undefined;
        if (prefetchedUserData !== undefined) {
            userData = prefetchedUserData;
        } else {
            const userDoc = await db.collection('users').doc(userId).get();
            if (!userDoc.exists) {
                console.warn('[push-server] User not found:', userId);
                return { success: false, sent: 0, failed: 0 };
            }
            userData = userDoc.data();
        }
        const tokens: string[] = userData?.fcmTokens || [];
        const pushEnabled = userData?.pushEnabled !== false;

        if (!pushEnabled || tokens.length === 0) {
            console.log('[push-server] Push disabled or no tokens for user:', userId);
            return { success: true, sent: 0, failed: 0 };
        }

        // Prepare the message
        const message: admin.messaging.MulticastMessage = {
            tokens,
            notification: {
                title: notification.title,
                body: notification.body,
            },
            data: {
                link: notification.link || '/',
                tag: notification.tag || 'default',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK'
            },
            webpush: {
                fcmOptions: {
                    link: notification.link || '/'
                },
                notification: {
                    icon: notification.icon || '/icons/icon-192x192.png',
                    badge: '/icons/badge-72x72.png',
                    vibrate: [100, 50, 100],
                    tag: notification.tag || 'default',
                    requireInteraction: false
                }
            }
        };

        // Send to all tokens
        const response = await admin.messaging().sendEachForMulticast(message);

        console.log(`[push-server] Sent to ${response.successCount}/${tokens.length} devices for user ${userId}`);

        // Remove invalid tokens
        if (response.failureCount > 0) {
            const tokensToRemove: string[] = [];
            response.responses.forEach((result, index) => {
                if (!result.success) {
                    const error = result.error;
                    if (error?.code === 'messaging/registration-token-not-registered' ||
                        error?.code === 'messaging/invalid-registration-token') {
                        tokensToRemove.push(tokens[index]);
                    }
                }
            });

            if (tokensToRemove.length > 0) {
                // WRITE PRIMACY (G-USER-8, U-51): under
                // isSupaPrimary('users') the token cleanup lands on
                // the adapter first (RMW arrayRemove). Named
                // exception to the loud rule: the push has ALREADY
                // been delivered when this runs and cannot be
                // un-sent, so a primary failure is logged at error
                // level and the Firestore mirror still runs — the
                // alternative (failing the send result) would
                // misreport a delivered push as failed.
                if (await identityPrimaryFlagOn('users')) {
                    try {
                        await primaryIdentitySet('users', 'users', userId, {
                            fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove)
                        }, { merge: true });
                    } catch (primaryErr) {
                        console.error(`[push-server] PRIMACY FAILURE removing invalid tokens on the primary for ${userId}:`, primaryErr);
                    }
                }
                await db.collection('users').doc(userId).update({
                    fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove)
                });
                console.log(`[push-server] Removed ${tokensToRemove.length} invalid tokens`);
            }
        }

        return {
            success: true,
            sent: response.successCount,
            failed: response.failureCount
        };
    } catch (error) {
        console.error('[push-server] Error sending push:', error);
        return { success: false, sent: 0, failed: 0 };
    }
}

/**
 * Send push notification to multiple users
 */
export async function sendPushToUsers(
    userIds: string[],
    notification: Parameters<typeof sendPushToUser>[1]
): Promise<{ total: number; sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    for (const userId of userIds) {
        const result = await sendPushToUser(userId, notification);
        sent += result.sent;
        failed += result.failed;
    }

    return { total: userIds.length, sent, failed };
}
