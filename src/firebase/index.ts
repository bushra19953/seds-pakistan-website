'use client';

import { getAnalytics, isSupported } from 'firebase/analytics';
import { getPerformance } from 'firebase/performance';
import { firebaseApp, auth, firestore, storage, functions } from './core';

// Re-exporting hooks for easy access
export { useUser } from './auth/use-user';
export { UserProvider, useUserContext } from './user-provider';
export { useCollection } from './firestore/use-collection';
export { useDoc } from './firestore/use-doc';
export { useFirebase, useAuth, useFirestore, useStorage, getFirebaseApp, useFirebaseApp } from './provider';
export { FirebaseProvider } from './provider';
export { FirebaseClientProvider } from './client-provider';

// Initialize Analytics only when explicitly enabled and in production
if (typeof window !== 'undefined') {
  const isProd = process.env.NODE_ENV === 'production';
  const enableAnalytics =
    process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === 'true' ||
    process.env.NEXT_PUBLIC_ENABLE_DETAILED_ANALYTICS === 'true';
  const enablePerformance = process.env.NEXT_PUBLIC_ENABLE_PERFORMANCE === 'true';

  if (enableAnalytics && isProd) {
    isSupported()
      .then((supported: boolean) => {
        if (supported) {
          getAnalytics(firebaseApp);
        }
      })
      .catch(() => {
        // Silently ignore analytics init errors in non-critical path
      });
  }

  if (enablePerformance && isProd) {
    try {
      // Initialize Firebase Performance Monitoring for Web
      getPerformance(firebaseApp);
    } catch {
      // Ignore performance init errors; non-critical path
    }
  }
}
export { firebaseApp, auth, firestore, storage, functions };
