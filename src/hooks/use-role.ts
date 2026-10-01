/**
 * Hook to fetch and manage user role information
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { useFirestore } from '@/firebase/provider';
import { UserRole, hasSufficientRole } from '@/lib/roles';

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
  const [role, setRole] = useState<UserRole | null>(() => {
    // Initialize with cached value if available
    return userId ? roleCache.get(userId) || null : null;
  });
  const [loading, setLoading] = useState(userId ? !roleCache.has(userId) : false);
  const [error, setError] = useState<Error | null>(null);
  
  // Superadmin override: read from env, fallback to known founder UID in codebase
  const FOUNDER_UID = (process.env.NEXT_PUBLIC_FIREBASE_FOUNDER_UID as string | undefined) || 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
   
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

    // Immediate superadmin override for founder UID
    if (userId === FOUNDER_UID) {
      setRole('superadmin');
      roleCache.set(userId, 'superadmin');
      setLoading(false);
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