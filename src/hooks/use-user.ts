"use client";

// User hook shim with email verification trigger
// -----------------------------------------------------------------------------
// This wrapper calls the canonical `useUser` implementation, and adds a
// lightweight side-effect: when a brand-new account logs in for the first time
// and the email is not verified, automatically trigger Firebase's
// `sendEmailVerification` once per session.
//
// Why here: The canonical hook lives at `src/firebase/auth/use-user.tsx`.
// Placing the verification trigger in this shim keeps the primary hook focused
// on auth state/role while allowing us to fulfill the project requirement to
// send the verification email immediately after registration without coupling
// it to any specific sign-up page.
// -----------------------------------------------------------------------------

import { useEffect } from 'react';
import {
  sendEmailVerification,
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getFirestoreService } from '@/firebase/provider';
import { hasSiteAdminAccess, UserRole } from '@/lib/roles';
import { useUser as baseUseUser } from '@/firebase/auth/use-user';

export function useUser() {
  const result = baseUseUser();

  useEffect(() => {
    const u = result.user;
    if (!u) return;
    if (u.emailVerified) return;

    // Detect first login right after account creation
    const createdAt = u.metadata?.creationTime;
    const lastSignIn = u.metadata?.lastSignInTime;
    const isFirstLogin = Boolean(createdAt && lastSignIn && createdAt === lastSignIn);

    // Avoid spamming: send once per session per user
    const key = `verificationEmailSent:${u.uid}`;
    const alreadySent = typeof window !== 'undefined' && localStorage.getItem(key) === '1';

    if (isFirstLogin && !alreadySent) {
      sendEmailVerification(u)
        .then(() => {
          try { localStorage.setItem(key, '1'); } catch {}
          console.log('[useUser shim] Verification email sent on first login');
        })
        .catch((err) => {
          console.warn('[useUser shim] Failed to send verification email:', err);
        });
    }
  }, [result.user]);

  return result;
}

// -----------------------------------------------------------------------------
// Auth helpers: Google sign-in with robust mobile/desktop handling
// and safe post-login redirects. These functions avoid component-specific
// dependencies (no Next.js router) to eliminate redirect loops.
// -----------------------------------------------------------------------------

function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const mobileRegex = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i;
  const isMobileUA = mobileRegex.test(navigator.userAgent);
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSmallScreen = window.innerWidth <= 768;
  return isMobileUA || (hasTouch && isSmallScreen);
}

// Centralized helper to determine if a role is considered administrative
// Admin roles include: superadmin, president, vice_president, general_secretary,
// projects_director, marketing_head, hr_director, treasurer, advisor.
// Change note: This clarifies our post-login redirect behavior — admins go to
// `/admin`, all other users go to `/profile`.
function isAdminRole(role?: UserRole | null): boolean {
  return !!role && hasSiteAdminAccess(role as UserRole);
}

/**
 * Resolve post-login destination using role-aware logic.
 * - If a `redirectTo` is provided and is a safe internal path, use it.
 * - Otherwise, determine role from ID token (claims) or Firestore fallback.
 * - Admin-level roles go to `/admin`; standard users go to `/profile`.
 */
async function resolvePostLoginRedirect(redirectTo?: string): Promise<string> {
  // Respect explicit, safe internal redirects
  if (typeof redirectTo === 'string' && redirectTo.startsWith('/')) {
    return redirectTo;
  }

  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) return '/profile';

  // Absolute precedence: Founder UID is always treated as superadmin
  const founderUid = process.env.NEXT_PUBLIC_FIREBASE_FOUNDER_UID || 'pLW0PuQCTAQHCNK1SfllVhPZdMz1';
  if (user.uid === founderUid) {
    return '/admin';
  }

  // Prefer role from custom claims (Fast path: avoids extra Firestore read)
  try {
    const tokenResult = await user.getIdTokenResult();
    const claimedRole = tokenResult?.claims?.role as UserRole | undefined;
    if (isAdminRole(claimedRole)) {
      return '/admin';
    }
    if (claimedRole) {
      return '/profile';
    }
  } catch {
    // fall through to Firestore role lookup
  }

  // Fallback: read role from Firestore `roles/{uid}` document
  try {
    const firestore = getFirestoreService();
    const snap = await getDoc(doc(firestore, 'roles', user.uid));
    const role = (snap.exists() ? (snap.data() as any)?.role : undefined) as UserRole | undefined;
    if (isAdminRole(role)) {
      return '/admin';
    }
  } catch {
    // If role lookup fails, default to profile
  }

  return '/profile';
}

/**
 * Perform a safe, role-aware redirect after login.
 * Uses `resolvePostLoginRedirect` to decide destination, then replaces location.
 */
async function safeRedirect(target?: string) {
  const to = await resolvePostLoginRedirect(target);
  if (typeof window !== 'undefined') {
    window.location.replace(to);
  }
}

export async function signInWithGoogle(redirectTo?: string) {
  const auth = getAuth();
  const provider = new GoogleAuthProvider();
  try {
    if (isMobileDevice()) {
      await signInWithRedirect(auth, provider);
      return; // Redirect flow continues in handleRedirectSignInResult
    } else {
      const cred = await signInWithPopup(auth, provider);
      if (!cred?.user) throw new Error('Google sign-in failed: no user');
      // Role-aware: admins -> /admin, members -> /profile
      await safeRedirect(redirectTo);
    }
  } catch (err: any) {
    // Allow UI layer to display error; avoid loops here
    console.error('[auth] Google sign-in error:', err);
    throw err;
  }
}

// Call this once on auth pages to complete redirect-based social logins
export async function handleRedirectSignInResult(redirectTo?: string) {
  const auth = getAuth();
  try {
    const result = await getRedirectResult(auth);
    if (result?.user) {
      // Role-aware: admins -> /admin, members -> /profile
      await safeRedirect(redirectTo);
    }
  } catch (err: any) {
    console.error('[auth] Redirect sign-in result error:', err);
    throw err;
  }
}
