/**
 * Hook to fetch and manage user role information
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { useFirestore } from '@/firebase/provider';
import { UserRole, hasSufficientRole } from '@/lib/roles';
import { isClientSupaSurfaceOn, LIVE_AUTHORITY_SURFACE } from '@/lib/client-supa-flags';
import { fetchAuthorityRoleDoc } from '@/lib/listeners-ce-client';
import { usePollingRefresh, MIN_POLL_INTERVAL_MS } from '@/hooks/use-polling-refresh';

interface UseRoleReturn {
  role: UserRole | null;
  loading: boolean;
  error: Error | null;
  hasRole: (requiredRoles: UserRole | UserRole[]) => boolean;
}

// Simple cache to prevent multiple simultaneous fetches for the same user
const roleCache = new Map<string, UserRole>();

export function useRole(userId: string | null): UseRoleReturn {
  const firestore = useFirestore();
  // listeners-ce (Class E conversion, A22): moves ONLY together with
  // A21/B10 behind 'live-authority' (F5 atomicity). ON = the roles
  // listener below is never registered; the roles doc is fetched and
  // re-polled through the token-verified roles seam route on the
  // shared 5-minute floor. OFF (default) = byte-identical to before,
  // including the roleCache short-circuit preserved in both modes
  // (a cache hit creates no listener today and no poll under the
  // flag — the F5-noted nuance, preserved deliberately).
  const authorityPolling = isClientSupaSurfaceOn(LIVE_AUTHORITY_SURFACE);
  const pollRef = useRef<(() => Promise<void>) | null>(null);
  usePollingRefresh(
    () => { void pollRef.current?.(); },
    MIN_POLL_INTERVAL_MS,
    authorityPolling,
  );
  const [role, setRole] = useState<UserRole | null>(() => {
    // Initialize with cached value if available
    return userId ? roleCache.get(userId) || null : null;
  });
  const [loading, setLoading] = useState(userId ? !roleCache.has(userId) : false);
  const [error, setError] = useState<Error | null>(null);
  
  // Memoize the hasRole function to prevent unnecessary re-creations
  const hasRole = useCallback((requiredRoles: UserRole | UserRole[]): boolean => {
    if (!role) return false;
    
    const rolesToCheck = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
    return rolesToCheck.some(requiredRole => hasSufficientRole(role, requiredRole));
  }, [role]);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | null = null;
    
    if (!userId) {
      setLoading(false);
      setRole(null);
      return;
    }

    // Use cached value if available
    if (roleCache.has(userId)) {
      setRole(roleCache.get(userId)!);
      setLoading(false);
      return;
    }

    setLoading(true);

    // First, try to get the role with a single fetch to avoid listener issues
    const roleDocRef = doc(firestore, 'roles', userId);
    const userDocRef = doc(firestore, 'users', userId);

    if (authorityPolling) {
      // ON path: route fetch + poll. A missing roles doc takes the
      // SAME users/{uid} fallback as the OFF path; that fallback is a
      // retained ONE-SHOT Firestore read, not a listener (named in
      // the listeners-ce report as a decommission residual). A null
      // route result keeps the last known role — the OFF listener's
      // own error posture — and the next poll retries.
      const pollRole = async () => {
        const res = await fetchAuthorityRoleDoc(userId);
        if (!isMounted) return;
        if (res && res.exists) {
          const updatedRole = ((res.data as any)?.role || 'guest') as UserRole;
          setRole(updatedRole);
          roleCache.set(userId, updatedRole);
        } else if (res) {
          try {
            const userSnap = await getDoc(userDocRef);
            if (!isMounted) return;
            const fallbackRole = userSnap.exists() ? (userSnap.data() as any)?.role || 'guest' : 'guest';
            setRole(fallbackRole);
            roleCache.set(userId, fallbackRole);
          } catch {
            if (!isMounted) return;
            const guestRole = 'guest' as UserRole;
            setRole(guestRole);
            roleCache.set(userId, guestRole);
          }
        }
        setLoading(false);
      };
      pollRef.current = pollRole;
      void pollRole();
      return () => {
        isMounted = false;
        pollRef.current = null;
      };
    }

    // Initial fetch
    getDoc(roleDocRef)
      .then((docSnap) => {
        if (!isMounted) return;
        
        if (docSnap.exists()) {
          const roleData = docSnap.data();
          const userRole = roleData.role || 'guest';
          setRole(userRole);
          // Cache the role for future use
          roleCache.set(userId, userRole);
        } else {
          // Fallback: try reading role from the user's profile document
          getDoc(userDocRef)
            .then((userSnap) => {
              if (!isMounted) return;
              const fallbackRole = userSnap.exists() ? (userSnap.data() as any)?.role || 'guest' : 'guest';
              setRole(fallbackRole);
              roleCache.set(userId, fallbackRole);
            })
            .catch(() => {
              // If fallback fails, default to guest
              const guestRole = 'guest';
              setRole(guestRole);
              roleCache.set(userId, guestRole);
            });
        }
        
        setLoading(false);
        
        // Set up real-time listener for subsequent changes
        if (isMounted) {
          unsubscribe = onSnapshot(
            roleDocRef,
            (docSnap) => {
              if (!isMounted) return;
              
              if (docSnap.exists()) {
                const roleData = docSnap.data();
                const updatedRole = roleData.role || 'guest';
                setRole(updatedRole);
                roleCache.set(userId, updatedRole);
              } else {
                // Fallback to the user's profile doc if roles doc is missing
                getDoc(userDocRef)
                  .then((userSnap) => {
                    if (!isMounted) return;
                    const fallbackRole = userSnap.exists() ? (userSnap.data() as any)?.role || 'guest' : 'guest';
                    setRole(fallbackRole);
                    roleCache.set(userId, fallbackRole);
                  })
                  .catch(() => {
                    const guestRole = 'guest';
                    setRole(guestRole);
                    roleCache.set(userId, guestRole);
                  });
              }
            },
            (err) => {
              if (!isMounted) return;
              console.error('Role listener error:', err);
              // Keep existing role on listener error rather than resetting
            }
          );
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        
        setError(err);
        // Default to guest role on error
        const guestRole = 'guest';
        setRole(guestRole);
        roleCache.set(userId, guestRole);
        setLoading(false);
        console.error('Error fetching initial role for userId:', userId, err);
      });

    return () => {
      isMounted = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [userId, firestore]);

  return { role, loading, error, hasRole };
}