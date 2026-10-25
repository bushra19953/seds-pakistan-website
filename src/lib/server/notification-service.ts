import { getDb } from '@/lib/server/firebase-admin';
import { sendPushToUser } from '@/lib/server/push-server';
import { emailService } from '@/lib/server/email-service';
import admin from 'firebase-admin';
import { generateEmailHtml } from '@/lib/mailer';
import {
    mirrorNotificationCreate,
    mirrorNotificationUpdate,
    userNotificationsPath,
} from '@/lib/server/notifications-supa-seam';

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
            // Supabase mirror (flag-gated, non-throwing; Firestore stays primary).
            await mirrorNotificationCreate(userNotificationsPath(userId), notifRef.id, firestorePayload);
            console.log(`[NotificationService] In-app notification created for ${userId}: ${payload.title}`);

            // 2. EXTERNAL CHANNELS
            this.dispatchExternalChannels(userId, userData, payload, priority, notifRef);
        } catch (error) {
            console.error('[NotificationService] Error sending notification:', error);
        }
    }

    /**
     * Apply a deliveryStatus update to the in-app notification document.
     * Firestore first (unchanged semantics); the Supabase mirror follows
     * once the Firestore update settles and never throws (flag-gated).
     * Dot-path update keys ('deliveryStatus.push') are passed through to
     * the adapter, which expands them the way Firestore does.
     */
    private updateNotificationDoc(
        userId: string,
        notifRef: admin.firestore.DocumentReference,
        updates: Record<string, any>
    ) {
        const result = notifRef.update(updates);
        void Promise.resolve(result).then(
            () => mirrorNotificationUpdate(userNotificationsPath(userId), notifRef.id, updates),
            () => undefined
        );
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
                this.updateNotificationDoc(userId, notifRef, { 'deliveryStatus.push': 'sent' });
            }).catch(err => {
                console.error('[NotificationService] Push failed:', err);
                this.updateNotificationDoc(userId, notifRef, { 'deliveryStatus.push': 'failed', 'deliveryStatus.pushError': String(err) });
            });
        } else {
            this.updateNotificationDoc(userId, notifRef, { 'deliveryStatus.push': 'skipped' });
        }

        // 2. EMAIL
        if (email && (priority === 'P0' || priority === 'P1')) {
            // Pass the real status transition when the caller supplied one
            // in the payload metadata; the template renders the transition
            // only then (it previously printed "undefined" on every send,
            // because no status was ever passed). The greeting name must
            // never fall back to the raw email address.
            const meta = payload.metadata || {};
            const { subject, html } = await generateEmailHtml('task_status_change' as any, {
                recipientName: userData.displayName || 'Team Member',
                taskTitle: payload.title,
                taskLink: payload.link || '/profile/unified',
                actorName: 'Mission Control',
                statusFrom: typeof meta.statusFrom === 'string' ? meta.statusFrom : undefined,
                statusTo: typeof meta.statusTo === 'string' ? meta.statusTo : undefined
            });

            emailService.sendEmail({
                to: email,
                subject: subject,
                text: payload.body,
                html: html,
            }).then((success) => {
                this.updateNotificationDoc(userId, notifRef, { 'deliveryStatus.email': success ? 'sent' : 'failed' });
            }).catch(err => {
                console.error('[NotificationService] Email failed:', err);
                this.updateNotificationDoc(userId, notifRef, { 'deliveryStatus.email': 'failed', 'deliveryStatus.emailError': String(err) });
            });
        } else {
            this.updateNotificationDoc(userId, notifRef, { 'deliveryStatus.email': 'skipped' });
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
                const created: Array<{ userId: string; id: string; data: Record<string, any> }> = [];

                for (const userDoc of chunk) {
                    const userId = userDoc.id;
                    const userData = userDoc.data();
                    const notifRef = db.collection('users').doc(userId).collection('notifications').doc();

                    const data = {
                        ...payload,
                        userId,
                        priority,
                        isRead: false,
                        deliveryStatus: { push: 'pending', email: 'pending' },
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    batch.set(notifRef, data);
                    created.push({ userId, id: notifRef.id, data });

                    this.dispatchExternalChannels(userId, userData, payload, priority, notifRef);
                }
                await batch.commit();
                // Supabase mirror (flag-gated, non-throwing; Firestore stays primary).
                await Promise.all(
                    created.map((c) => mirrorNotificationCreate(userNotificationsPath(c.userId), c.id, c.data))
                );
            }
        } catch (error) {
            console.error('[NotificationService] Broadcast failed:', error);
        }
    }
}

export const notificationService = new NotificationService();
