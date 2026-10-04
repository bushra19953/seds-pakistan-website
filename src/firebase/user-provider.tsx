'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, onIdTokenChanged } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, onSnapshot, setDoc } from 'firebase/firestore';
import { auth, firestore } from './core';
import { UserRole, USER_ROLES, FOUNDER_UID } from '@/lib/roles';
import { injectRoleOverrides } from '@/config/permissions';
import { normalizeRoleSlug } from '@/lib/unified-roles';

const DEBUG_AUTH = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_DEBUG_AUTH === '1';

// Timeout for ID token fetches. A stalled token request must not block the
// auth state callback, so we race getIdToken() against this timer and proceed
// with a null token on timeout. The next onIdTokenChanged event retries the
// fetch in the background.
const ID_TOKEN_TIMEOUT_MS = 5000;

const getIdTokenWithTimeout = (authUser: User): Promise<string | null> => {
    return new Promise((resolve) => {
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
            console.warn('[UserProvider] getIdToken timed out, continuing without fresh token');
            resolve(null);
        }, ID_TOKEN_TIMEOUT_MS);
        authUser.getIdToken().then(
            (token) => {
                clearTimeout(timer);
                resolve(token);
            },
            (e) => {
                clearTimeout(timer);
                console.warn('[UserProvider] Failed to get ID token for cookie', e);
                resolve(null);
            }
        );
    });
};

interface UserContextType {
    user: User | null;
    role: UserRole | null;
    roleLabel: string | null;
    allowedPaths: string[];
    isLoading: boolean;
    error: Error | null;
    activeChapterContext: string | null;
    setActiveChapterContext: (chapterId: string | null) => void;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

/**
 * useUserContext Hook
 * Defined before UserProvider to prevent TDZ issues if needed, although exported at bottom.
 */
export function useUserContext() {
    const context = useContext(UserContext);
    if (context === undefined) {
        throw new Error('useUserContext must be used within a UserProvider');
    }
    return context;
}

export function UserProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [role, setRole] = useState<UserRole | null>(null);
    const [roleLabel, setRoleLabel] = useState<string | null>(null);
    const [allowedPaths, setAllowedPaths] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    
    // Multi-tenant Chapter Context
    const [activeChapterContext, setActiveChapterContextState] = useState<string | null>(null);

    // Persist and Apply Context
    const setActiveChapterContext = (chapterId: string | null) => {
        setActiveChapterContextState(chapterId);
        if (typeof window !== 'undefined') {
            if (chapterId) localStorage.setItem('seds.activeChapter', chapterId);
            else localStorage.removeItem('seds.activeChapter');
        }
    };

    useEffect(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('seds.activeChapter');
            if (saved) setActiveChapterContextState(saved);
        }
    }, []);

    useEffect(() => {
        if (DEBUG_AUTH) console.log('[UserProvider] Initializing auth listener.');
        let isMounted = true;
        let timeoutId: NodeJS.Timeout | undefined;
        let unsubscribeAuth: (() => void) | undefined;
        let unsubscribeRole: (() => void) | undefined;

        const maxTimeout = 10000; 
        timeoutId = setTimeout(() => {
            if (isMounted && isLoading) {
                console.warn('[UserProvider] Auth initialization timed out after 10s');
                setIsLoading(false);
                if (!role) setRole('guest');
                setError(new Error('Authentication timeout'));
            }
        }, maxTimeout);

        try {
            unsubscribeAuth = onIdTokenChanged(
                auth,
                async (authUser) => {
                    // Sync cookie for Middleware SSR visibility
                    if (typeof window !== 'undefined') {
                        if (authUser) {
                            const token = await getIdTokenWithTimeout(authUser);
                            if (token) {
                                document.cookie = `__session=${token}; path=/; max-age=3600; secure; samesite=strict`;
                            }
                            // On timeout the cookie keeps its previous value and the
                            // next onIdTokenChanged event refreshes it in the background.
                        } else {
                            document.cookie = `__session=; path=/; max-age=0; secure; samesite=strict`;
                        }
                    }

                    if (!isMounted) return;
                    setUser(authUser);
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        timeoutId = undefined;
                    }

                    if (authUser) {
                        // NEW v11.0: Real-time Authority & Permissions Sync
                        const roleDocRef = doc(firestore, 'roles', authUser.uid);
                        const userDocRef = doc(firestore, 'users', authUser.uid);

                        const fetchAndInjectOverrides = async (resolvedRole: UserRole) => {
                            if (!firestore || resolvedRole === 'guest') return;
                            const roleSlug = normalizeRoleSlug(resolvedRole);
                            
                            try {
                                // 1. Attempt to fetch from roleDefinitions (Primary source for dynamic RBAC)
                                const rdRef = doc(firestore, 'roleDefinitions', roleSlug);
                                const rdSnap = await getDoc(rdRef);
                                
                                if (rdSnap.exists()) {
                                    const data = rdSnap.data();
                                    if (data.name || data.label) setRoleLabel(data.name || data.label);
                                    if (Array.isArray(data.allowedPaths)) setAllowedPaths(data.allowedPaths);
                                    if (data.permissions && Array.isArray(data.permissions)) {
                                        injectRoleOverrides(roleSlug, data.permissions);
                                    }
                                } else {
                                    // 2. Legacy fallback
                                    const rpRef = doc(firestore, 'role_permissions', roleSlug);
                                    const rpSnap = await getDoc(rpRef);
                                    if (rpSnap.exists()) {
                                        const data = rpSnap.data();
                                        if (data.label) setRoleLabel(data.label);
                                        if (Array.isArray(data.allowedPaths)) setAllowedPaths(data.allowedPaths);
                                        if (data.canAccessAdmin) injectRoleOverrides(roleSlug, ['canAccessAdmin']);
                                    }
                                }
                            } catch (e: any) {
                                console.warn('[UserProvider] Error fetching dynamic permissions:', e);
                            }
                        };

                        if (FOUNDER_UID && authUser.uid === FOUNDER_UID) {
                            await fetchAndInjectOverrides('superadmin');
                            setRole('superadmin');
                            setAllowedPaths(['all']);
                            setIsLoading(false);
                            return;
                        }

                        // Try token claims first for speed
                        try {
                            const tokenResult = await authUser.getIdTokenResult();
                            const claimedRoleRaw = tokenResult?.claims?.role as UserRole | undefined;
                            if (claimedRoleRaw) {
                                const claimedRole = normalizeRoleSlug(claimedRoleRaw);
                                await fetchAndInjectOverrides(claimedRole);
                                setRole(claimedRole);
                                setIsLoading(false);
                            }
                        } catch (claimsError: any) {}

                        // Setup real-time listener for role document
                        if (unsubscribeRole) unsubscribeRole();
                        unsubscribeRole = onSnapshot(roleDocRef, async (docSnap) => {
                            try {
                                if (docSnap.exists()) {
                                    const newRoleRaw = (docSnap.data() as any).role as UserRole;
                                    const newRole = normalizeRoleSlug(newRoleRaw);
                                    
                                    // Self-healing normalization
                                    if (newRoleRaw !== newRole && authUser.uid) {
                                        setDoc(roleDocRef, { role: newRole }, { merge: true }).catch(() => {});
                                    }

                                    await fetchAndInjectOverrides(newRole);
                                    setRole(newRole);
                                } else {
                                    setRole('member');
                                    setRoleLabel('Member');
                                    setAllowedPaths([]);
                                }
                            } catch (roleFetchError: any) {
                                setRole('guest');
                            } finally {
                                setIsLoading(false);
                            }
                        }, (err) => {
                            console.error('[UserProvider] Role subscription error:', err);
                            setIsLoading(false);
                        });

                    } else {
                        setRole('guest');
                        setAllowedPaths([]);
                        setIsLoading(false);
                    }
                },
                (authError) => {
                    console.error('[UserProvider] Auth state error:', authError);
                    setError(authError);
                    setIsLoading(false);
                }
            );
        } catch (setupError: any) {
            console.error('[UserProvider] Setup error:', setupError);
            setError(setupError instanceof Error ? setupError : new Error(String(setupError)));
            setIsLoading(false);
        }

        return () => {
            isMounted = false;
            if (unsubscribeAuth) unsubscribeAuth();
            if (unsubscribeRole) unsubscribeRole();
            if (timeoutId) clearTimeout(timeoutId);
        };
    }, []);

    const value = { 
        user, 
        role, 
        roleLabel,
        allowedPaths,
        isLoading, 
        error,
        activeChapterContext,
        setActiveChapterContext
    };

    return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
