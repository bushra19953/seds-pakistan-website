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

/* ------------------------------------------------------------------ */
/* Instruction delivery resilience (Stream D)                          */
/*                                                                     */
/* Push notifications about new/updated task instructions must survive */
/* the loss of the chat message. The push carries only a REFERENCE to  */
/* the in-platform copy (task id + instruction id + version) and a    */
/* click-through target that opens the in-platform instruction view.    */
/* The full brief text must NEVER live only in the push.               */
/* ------------------------------------------------------------------ */

/**
 * The reference an instruction push carries. Note there is deliberately
 * no `briefText` field: the builder below cannot put the full brief in
 * the push, only a pointer to the in-platform copy.
 */
export interface InstructionPushReference {
    /** Task (or workflow step) id that owns the instructions */
    taskId: string;
    /** Instruction document id */
    instructionId: string;
    /** Instruction version (number or string revision) */
    instructionVersion: string | number;
    /** Short task title, shown verbatim in the push */
    taskTitle: string;
    /**
     * Optional explicit click-through target opening the in-platform
     * instruction view. When omitted, defaults to the mission page for
     * the task.
     */
    link?: string;
}

/**
 * The canonical shape of an instruction-related push payload.
 */
export interface InstructionPushPayload {
    title: string;
    body: string;
    icon?: string;
    tag: string;
    data: {
        type: 'instruction_update';
        taskId: string;
        instructionId: string;
        instructionVersion: string;
        link: string;
    };
}

/**
 * Build an instruction-related push payload.
 *
 * Visible text stays short and factual: the task title plus
 * "new instructions". The full brief stays on the platform; the push
 * only references it and links to it.
 */
export function buildInstructionPushPayload(ref: InstructionPushReference): InstructionPushPayload {
    const version = String(ref.instructionVersion);
    const link = ref.link && ref.link.length > 0 ? ref.link : `/missions/${ref.taskId}`;

    return {
        title: ref.taskTitle,
        body: 'New instructions. Tap to read the full brief on the platform.',
        icon: '/icons/icon-192x192.png',
        tag: `instruction-${ref.taskId}-${version}`,
        data: {
            type: 'instruction_update',
            taskId: ref.taskId,
            instructionId: ref.instructionId,
            instructionVersion: version,
            link,
        },
    };
}

/**
 * True when an incoming FCM payload is an instruction-related push
 * (identified by the `instruction_update` type, or by carrying both a
 * task id and an instruction id).
 */
export function isInstructionPush(payload: any): boolean {
    const data = payload?.data || {};
    return data.type === 'instruction_update' || (Boolean(data.taskId) && Boolean(data.instructionId));
}

/**
 * Resolve the click-through URL from an incoming FCM payload, honoring
 * the existing payload patterns: `data.link`, `data.openURL`, and
 * `data.clickAction`. Falls back to '/' when nothing usable is present.
 */
export function resolvePushClickUrl(payload: any): string {
    const data = payload?.data || {};
    const candidates = [data.link, data.openURL, data.openUrl, data.url, data.clickAction, data.click_action];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            if (candidate.startsWith('http') || candidate.startsWith('/')) {
                return candidate;
            }
        }
    }

    return '/';
}

/**
 * Open a push click-through target. Prefers a new tab, falls back to
 * navigating the current tab.
 */
export function openPushTarget(url: string): void {
    if (typeof window === 'undefined') return;

    try {
        const absolute = url.startsWith('http')
            ? url
            : `${window.location.origin}${url.startsWith('/') ? url : `/${url}`}`;
        const opened = window.open(absolute, '_blank', 'noopener,noreferrer');
        if (!opened) {
            window.location.assign(absolute);
        }
    } catch (error) {
        console.debug('[push] Could not open push target:', error);
    }
}

/**
 * Show an instruction push while the app is in the foreground.
 * Tapping it opens the in-platform instruction view via the push's
 * click-through target. Returns true when the notification was shown.
 *
 * Wire this into your `onForegroundMessage` callback for instruction
 * payloads; it does not change the behavior of existing callbacks.
 */
export function showForegroundInstructionNotification(payload: any): boolean {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;
    if (!isInstructionPush(payload)) return false;

    const data = payload?.data || {};
    const url = resolvePushClickUrl(payload);
    const title =
        typeof payload?.notification?.title === 'string' && payload.notification.title.length > 0
            ? payload.notification.title
            : typeof data.taskTitle === 'string' && data.taskTitle.length > 0
                ? data.taskTitle
                : 'New instructions';
    const tag =
        typeof data.tag === 'string' && data.tag.length > 0
            ? data.tag
            : `instruction-${data.taskId || 'unknown'}-${data.instructionVersion || 'unknown'}`;

    try {
        const notification = new Notification(title, {
            body: 'New instructions. Tap to read the full brief on the platform.',
            tag,
            icon: '/icons/icon-192x192.png',
            data: { link: url },
        });

        notification.onclick = (event: Event) => {
            event.preventDefault();
            window.focus();
            openPushTarget(url);
            notification.close();
        };

        playNotificationSound();
        return true;
    } catch (error) {
        console.debug('[push] Could not show foreground instruction notification:', error);
        return false;
    }
}
