// Firebase Cloud Messaging Service Worker
// This file MUST be in the /public directory for FCM to work

// Import Firebase scripts
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

// Initialize Firebase (values from firebase/config.ts)
firebase.initializeApp({
    apiKey: 'AIzaSyDpKUqoo-OZHTXSrkPj1HiCQwZWE7CyeIg',
    authDomain: 'seds-pakistan.firebaseapp.com',
    projectId: 'seds-pakistan',
    storageBucket: 'seds-pakistan.appspot.com',
    messagingSenderId: '884993774057',
    appId: '1:884993774057:web:50eb3cd3917dc61045fb78'
});

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
