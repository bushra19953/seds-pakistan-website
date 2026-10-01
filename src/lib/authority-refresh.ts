import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot, serverTimestamp, getFirestore } from 'firebase/firestore';
import { setDoc } from '@/lib/client/firestore-wrapper';

;

/**
 * Instant Power Refresh v11.0
 * 
 * Logic:
 * 1. Admin updates role and sets a 'lastRoleUpdate' flag on the user's role document.
 * 2. Client-side listener detects the change.
 * 3. Client calls user.getIdToken(true) to force a refresh including the new custom claims.
 */

/**
 * Triggers a refresh signal for a target user
 */
export async function triggerAuthorityRefresh(uid: string) {
    const db = getFirestore();
    const refreshRef = doc(db, 'authority_refresh', uid);
    await setDoc(refreshRef, {
        requestedAt: serverTimestamp(),
        type: 'FORCE_REFRESH'
    });
}

/**
 * Client-side listener to handle incoming refresh signals
 */
export function setupAuthorityListener(onRefresh?: () => void) {
    const auth = getAuth();
    const db = getFirestore();

    onAuthStateChanged(auth, (user) => {
        if (!user) return;

        const refreshRef = doc(db, 'authority_refresh', user.uid);

        // Subscribe to refresh requests for this specific user
        const unsubscribe = onSnapshot(refreshRef, async (snapshot) => {
            if (!snapshot.exists()) return;

            const data = snapshot.data();
            const requestedAt = data?.requestedAt?.toDate()?.getTime() || 0;
            const now = Date.now();

            // Only refresh if requested in the last 30 seconds to avoid infinite loops
            if (now - requestedAt < 30000) {
                console.log('⚡ [v11.0 Instant Auth] Authority change detected. Force refreshing token...');

                try {
                    await user.getIdToken(true);
                    console.log('✅ [v11.0 Instant Auth] Token refreshed successfully.');

                    if (onRefresh) onRefresh();

                    // Clear the request after processing
                    await setDoc(refreshRef, { processedAt: serverTimestamp() }, { merge: true });
                } catch (error) {
                    console.error('❌ [v11.0 Instant Auth] Failed to refresh token:', error);
                }
            }
        }, (error) => {
            // Permission denied is expected if the user document doesn't exist yet or rules are being updated
            if (error.code !== 'permission-denied') {
                console.error('❌ [v11.0 Instant Auth] Authority listener failed:', error);
            }
        });

        return unsubscribe;
    });
}
