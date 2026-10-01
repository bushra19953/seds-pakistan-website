import { getDb } from '@/lib/server/firebase-admin';
import { sendPushToUser } from '@/lib/server/push-server';
import { emailService } from '@/lib/server/email-service';
import admin from 'firebase-admin';
import { generateEmailHtml } from '@/lib/mailer';

/**
 * PRODUCTION-GRADE UNIFIED NOTIFICATION SERVICE
 * Orchestrates In-App, Push, and Email delivery.
 */

export type NotificationPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface NotificationPayload {
    type: string;
    title: string;
    body: string;
    link?: string;
    icon?: string;
    tag?: string;
    metadata?: Record<string, any>;
}

class NotificationService {
    /**
     * Send a notification to a specific user across all applicable channels
     */
    async send(
        userId: string,
        payload: NotificationPayload,
        priority: NotificationPriority = 'P2'
    ) {
        const db = getDb();
        if (!db) {
            console.warn('[NotificationService] Firestore unavailable.');
            return;
        }

        try {
            const userRef = db.collection('users').doc(userId);
            const userDoc = await userRef.get();
            if (!userDoc.exists) {
                console.warn(`[NotificationService] User ${userId} not found.`);
                return;
            }

            const userData = userDoc.data();

            // 1. IN-APP (Always - Firestore storage)
            const notifRef = userRef.collection('notifications').doc();
            const firestorePayload: any = {
                ...payload,
                userId,
                priority,
                isRead: false,
                deliveryStatus: {
                    push: 'pending',
                    email: 'pending'
                },
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            await notifRef.set(firestorePayload);
            console.log(`[NotificationService] In-app notification created for ${userId}: ${payload.title}`);

            // 2. EXTERNAL CHANNELS
            this.dispatchExternalChannels(userId, userData, payload, priority, notifRef);
        } catch (error) {
            console.error('[NotificationService] Error sending notification:', error);
        }
    }

    /**
     * Shared logic for external channel dispatch
     */
    private async dispatchExternalChannels(
        userId: string,
        userData: any,
        payload: NotificationPayload,
        priority: NotificationPriority,
        notifRef: admin.firestore.DocumentReference
    ) {
        const email = userData?.email;
        const pushEnabled = userData?.pushEnabled !== false;

        // 1. PUSH
        if (pushEnabled && priority !== 'P3') {
            sendPushToUser(userId, {
                title: payload.title,
                body: payload.body,
                link: payload.link,
                icon: payload.icon,
                tag: payload.tag || payload.type,
            }).then(() => {
                notifRef.update({ 'deliveryStatus.push': 'sent' });
            }).catch(err => {
                console.error('[NotificationService] Push failed:', err);
                notifRef.update({ 'deliveryStatus.push': 'failed', 'deliveryStatus.pushError': String(err) });
            });
        } else {
            notifRef.update({ 'deliveryStatus.push': 'skipped' });
        }

        // 2. EMAIL
        if (email && (priority === 'P0' || priority === 'P1')) {
            const { subject, html } = generateEmailHtml('task_status_change' as any, {
                recipientName: userData.displayName || userData.email || 'User',
                taskTitle: payload.title,
                taskLink: payload.link || '/profile/unified',
                actorName: 'Mission Control'
            });

            emailService.sendEmail({
                to: email,
                subject: subject,
                text: payload.body,
                html: html,
            }).then((success) => {
                notifRef.update({ 'deliveryStatus.email': success ? 'sent' : 'failed' });
            }).catch(err => {
                console.error('[NotificationService] Email failed:', err);
                notifRef.update({ 'deliveryStatus.email': 'failed', 'deliveryStatus.emailError': String(err) });
            });
        } else {
            notifRef.update({ 'deliveryStatus.email': 'skipped' });
        }
    }

    /**
     * Send notification to multiple roles (Admin Broadcast)
     */
    async broadcastByRoles(roles: string[], payload: NotificationPayload, priority: NotificationPriority = 'P2') {
        const db = getDb();
        if (!db) return;

        try {
            const usersSnap = await db.collection('users').where('displayRole', 'in', roles).get();
            const docs = usersSnap.docs;

            console.log(`[NotificationService] Broadcasting to ${docs.length} users with roles: ${roles.join(', ')}`);

            for (let i = 0; i < docs.length; i += 500) {
                const batch = db.batch();
                const chunk = docs.slice(i, i + 500);

                for (const userDoc of chunk) {
                    const userId = userDoc.id;
                    const userData = userDoc.data();
                    const notifRef = db.collection('users').doc(userId).collection('notifications').doc();

                    batch.set(notifRef, {
                        ...payload,
                        userId,
                        priority,
                        isRead: false,
                        deliveryStatus: { push: 'pending', email: 'pending' },
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    });

                    this.dispatchExternalChannels(userId, userData, payload, priority, notifRef);
                }
                await batch.commit();
            }
        } catch (error) {
            console.error('[NotificationService] Broadcast failed:', error);
        }
    }
}

export const notificationService = new NotificationService();
