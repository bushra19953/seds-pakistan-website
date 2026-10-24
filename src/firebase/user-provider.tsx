'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, onIdTokenChanged } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, onSnapshot, setDoc } from 'firebase/firestore';
import { auth, firestore } from './core';
import { UserRole, USER_ROLES } from '@/lib/roles';
import { injectRoleOverrides } from '@/config/permissions';
import { heldCustomRoleSlugs, toCustomRoleDefinition } from '@/lib/custom-roles';
import { normalizeRoleSlug } from '@/lib/unified-roles';
import { ensureUserProfile } from '@/lib/auth/ensure-user-profile';

// Tracks uids for which a self-healing profile check has already been
// attempted in this page session, so the heal runs at most once per uid
// and a failure never loops.
const attemptedHealUids = new Set<string>();

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
    // Custom roles this holder currently holds via roles/{uid}
    // .additionalRoles (unexpired custom_ slugs only), and the union of
    // their definitions' allowedPaths. Both are empty for a user with
    // no custom roles, in which case every consumer behaves exactly as
    // it did before custom-role grants were honored client-side.
    customRoles: string[];
    customAllowedPaths: string[];
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
    const [customRoles, setCustomRoles] = useState<string[]>([]);
    const [customAllowedPaths, setCustomAllowedPaths] = useState<string[]>([]);
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
                        // Custom grants belong to the previous identity
                        // until this user's roles doc loads; never let
                        // them bleed across an account switch.
                        setCustomRoles([]);
                        setCustomAllowedPaths([]);
                        // Self-healing profile creation: if the users/{uid} doc
                        // is missing (signup profile write failed silently),
                        // create it. Fire-and-forget so role resolution and
                        // loading state are never blocked. Runs once per uid
                        // per page session, including for the founder (it
                        // no-ops when a doc already exists).
                        if (!attemptedHealUids.has(authUser.uid)) {
                            attemptedHealUids.add(authUser.uid);
                            ensureUserProfile(firestore, authUser).then((result) => {
                                if (result === 'created') {
                                    console.log('[UserProvider] Created missing users profile for', authUser.uid);
                                }
                            });
                        }

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

                                // Perm-resolution parity (contracts 4.4): the
                                // role_permissions fallback is reached whenever
                                // no permissions array was injected — doc
                                // missing OR doc without an array — mirroring
                                // the server's step-1-to-step-2 fallthrough in
                                // hasServerPermission. Previously a definition
                                // doc without an array silently cut the client
                                // off from the fallback the server still takes.
                                let definitionInjected = false;
                                if (rdSnap.exists()) {
                                    const data = rdSnap.data();
                                    if (data.name || data.label) setRoleLabel(data.name || data.label);
                                    if (Array.isArray(data.allowedPaths)) setAllowedPaths(data.allowedPaths);
                                    if (data.permissions && Array.isArray(data.permissions)) {
                                        injectRoleOverrides(roleSlug, data.permissions);
                                        definitionInjected = true;
                                    }
                                }
                                if (!definitionInjected) {
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

                        // Custom-role grants: fetch one held custom role's
                        // definition and inject its permissions under the
                        // CUSTOM slug only — never under the primary role,
                        // or the grant would leak to every holder of that
                        // primary role at this layer. The definition must
                        // pass the four-part test (toCustomRoleDefinition)
                        // and be active, mirroring getCustomRoleDefinitions
                        // and the server's deny-by-absence for a missing
                        // or junk definition. Returns the definition's
                        // allowedPaths for the sidebar's path union; the
                        // primary role's label and allowedPaths are never
                        // touched here.
                        const fetchAndInjectCustomOverrides = async (customSlug: string): Promise<string[]> => {
                            if (!firestore) return [];
                            try {
                                const rdRef = doc(firestore, 'roleDefinitions', customSlug);
                                const rdSnap = await getDoc(rdRef);
                                if (!rdSnap.exists()) return [];
                                const data = rdSnap.data() as Record<string, unknown>;
                                const definition = toCustomRoleDefinition(customSlug, data);
                                if (!definition || !definition.isActive) return [];
                                injectRoleOverrides(customSlug as UserRole, definition.permissions);
                                return Array.isArray(data.allowedPaths)
                                    ? data.allowedPaths.filter((p): p is string => typeof p === 'string')
                                    : [];
                            } catch (e: any) {
                                console.warn('[UserProvider] Error fetching custom role permissions:', e);
                                return [];
                            }
                        };

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
                                    const roleData = docSnap.data() as any;
                                    const newRoleRaw = roleData.role as UserRole;
                                    const newRole = normalizeRoleSlug(newRoleRaw);
                                    
                                    // Phase 1 (spec B.2 item 12): the client
                                    // self-healing normalization write is
                                    // REMOVED. A client listener must never
                                    // rewrite the authoritative roles record;
                                    // stored-token normalization is the
                                    // migration's job (workstream M) and
                                    // divergence is surfaced for the
                                    // reconciliation job instead.
                                    if (newRoleRaw !== newRole && authUser.uid) {
                                        console.warn(
                                            `[UserProvider] Role token divergence on roles/${authUser.uid}: ` +
                                            `stored "${newRoleRaw}" resolves as "${newRole}". ` +
                                            'Left unchanged; the reconciliation job reports stored-token divergence.'
                                        );
                                    }

                                    await fetchAndInjectOverrides(newRole);

                                    // Custom-role grants held via this same
                                    // roles doc: resolve the held slugs
                                    // (custom_ only, unexpired), inject each
                                    // definition's permissions under its own
                                    // slug, and expose the slugs plus their
                                    // allowedPaths union on the context.
                                    const heldCustomRoles = heldCustomRoleSlugs(roleData, newRole, new Date());
                                    setCustomRoles(heldCustomRoles);
                                    if (heldCustomRoles.length > 0) {
                                        const pathLists = await Promise.all(
                                            heldCustomRoles.map((slug) => fetchAndInjectCustomOverrides(slug))
                                        );
                                        setCustomAllowedPaths(Array.from(new Set(pathLists.flat())));
                                    } else {
                                        setCustomAllowedPaths([]);
                                    }

                                    setRole(newRole);
                                } else {
                                    setCustomRoles([]);
                                    setCustomAllowedPaths([]);
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
                        setCustomRoles([]);
                        setCustomAllowedPaths([]);
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
        customRoles,
        customAllowedPaths,
        isLoading,
        error,
        activeChapterContext,
        setActiveChapterContext
    };

    return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
