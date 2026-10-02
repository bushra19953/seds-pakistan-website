// Firebase Cloud Messaging Service Worker
// This file MUST be in the /public directory for FCM to work

// Import Firebase scripts
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

// ---------------------------------------------------------------------------
// Firebase Web configuration for background push.
// NOTE: Service workers are static assets served from /public, so they cannot
// read build-time environment variables (process.env). The values below are
// the public Firebase Web client identifiers for this project (the same
// identifiers shipped in the main client bundle via src/firebase/config.ts).
// A Firebase Web API key is a public client identifier, not a secret: it must
// be restricted via API key restrictions (HTTP referrers) in Google Cloud
// Console, and data access is enforced by Firestore Security Rules, not by
// hiding this key. To rotate, update the key here and in the GCP console.
// ---------------------------------------------------------------------------
const FIREBASE_WEB_CONFIG = {
    apiKey: 'AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg',
    authDomain: 'seds-pakistan.firebaseapp.com',
    projectId: 'seds-pakistan',
    storageBucket: 'seds-pakistan.appspot.com',
    messagingSenderId: '884993774057',
    appId: '1:884993774057:web:50eb3cd3917dc61045fb78'
};

// Initialize Firebase
firebase.initializeApp(FIREBASE_WEB_CONFIG);

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Background message received:', payload);

    const notificationTitle = payload.notification?.title || 'SEDS Pakistan';
    const notificationOptions = {
        body: payload.notification?.body || 'You have a new notification',
        icon: '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png',
        tag: payload.data?.tag || 'default',
        data: payload.data,
        vibrate: [100, 50, 100],
        actions: [
            { action: 'view', title: 'View' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
    console.log('[firebase-messaging-sw.js] Notification clicked:', event);

    event.notification.close();

    if (event.action === 'dismiss') return;

    // Get the link from notification data or default to home
    const urlToOpen = event.notification.data?.link || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Check if there's already a window open
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    client.navigate(urlToOpen);
                    return client.focus();
                }
            }
            // If no window is open, open a new one
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});
