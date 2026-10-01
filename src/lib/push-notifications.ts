/**
 * Push Notification Utilities
 * 
 * Uses Firebase Cloud Messaging (FCM) - 100% FREE unlimited push notifications.
 * 
 * Features:
 * - Request permission and get FCM token
 * - Store token in user's Firestore document
 * - Send push via Firebase Admin SDK (server-side)
 */

import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import { doc, arrayUnion, arrayRemove } from 'firebase/firestore';
;
import { firebaseApp, firestore } from '@/firebase';
import { updateDoc } from '@/lib/client/firestore-wrapper';


// Your VAPID key from Firebase Console > Project Settings > Cloud Messaging
const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || '';

/**
 * Check if push notifications are supported in this browser
 */
export async function isPushSupported(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (!('Notification' in window)) return false;
    if (!('serviceWorker' in navigator)) return false;

    try {
        return await isSupported();
    } catch {
        return false;
    }
}

/**
 * Get current notification permission status
 */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
    if (typeof window === 'undefined' || !('Notification' in window)) {
        return 'unsupported';
    }
    return Notification.permission;
}

/**
 * Request notification permission and get FCM token
 * Returns the token if successful, null otherwise
 */
export async function requestPushPermission(userId: string): Promise<string | null> {
    try {
        // Check support
        if (!(await isPushSupported())) {
            console.warn('[push] Push notifications not supported');
            return null;
        }

        // Request permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.log('[push] Permission denied');
            return null;
        }

        // Register service worker
        const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
        console.log('[push] Service worker registered');

        // Get FCM token
        const messaging = getMessaging(firebaseApp);
        const token = await getToken(messaging, {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration
        });

        if (!token) {
            console.warn('[push] Failed to get FCM token');
            return null;
        }

        // Store token in user's Firestore document
        if (firestore && userId) {
            const userRef = doc(firestore, 'users', userId);
            await updateDoc(userRef, {
                fcmTokens: arrayUnion(token),
                pushEnabled: true,
                pushUpdatedAt: new Date()
            });
            console.log('[push] Token stored for user:', userId);
        }

        return token;
    } catch (error) {
        console.error('[push] Error requesting permission:', error);
        return null;
    }
}

/**
 * Disable push notifications for a user
 */
export async function disablePushNotifications(userId: string, token?: string): Promise<void> {
    try {
        if (!firestore || !userId) return;

        const userRef = doc(firestore, 'users', userId);
        const updates: any = { pushEnabled: false };

        if (token) {
            updates.fcmTokens = arrayRemove(token);
        }

        await updateDoc(userRef, updates);
        console.log('[push] Push disabled for user:', userId);
    } catch (error) {
        console.error('[push] Error disabling push:', error);
    }
}

/**
 * Listen for foreground messages (when app is open)
 * Returns an unsubscribe function
 */
export function onForegroundMessage(callback: (payload: any) => void): (() => void) | null {
    if (typeof window === 'undefined') return null;

    try {
        const messaging = getMessaging(firebaseApp);
        return onMessage(messaging, (payload) => {
            console.log('[push] Foreground message:', payload);
            callback(payload);
        });
    } catch (error) {
        console.error('[push] Error setting up foreground listener:', error);
        return null;
    }
}

/**
 * Play a notification sound (for foreground messages)
 */
export function playNotificationSound(): void {
    try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + 0.1);

        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.3);

        // Vibrate if supported
        if ('vibrate' in navigator) {
            navigator.vibrate([100, 50, 100]);
        }
    } catch (error) {
        console.debug('[push] Could not play sound:', error);
    }
}
