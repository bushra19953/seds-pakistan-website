"use client";

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, getAdditionalUserInfo, onAuthStateChanged } from 'firebase/auth';
import { doc, getFirestore, serverTimestamp, getDoc, collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
;
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { validateInvite } from '@/lib/invite-system';
import { assignRole } from '@/lib/role-management';
import { logAuditEntry } from '@/lib/audit-logging';
import Image from 'next/image';

function GoogleOnlyAuthFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useEnhancedToast();
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [hasConsented, setHasConsented] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteData, setInviteData] = useState<any>(null);
  const auth = getAuth();
  const processedRedirectRef = useRef(false);

  // NEW: Track if we're still checking auth state
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const authCheckedRef = useRef(false);

  // Enhanced safe redirect logic
  const getSafeRedirect = () => {
    const target = searchParams.get('callbackUrl');
    if (target && target.startsWith('/') && !target.startsWith('/auth/') && !target.includes('..')) {
      console.log('[auth] Redirecting to intended destination:', target);
      return target;
    }
    console.log('[auth] No valid redirect target, defaulting to /profile');
    return '/profile';
  };

  // Fetch current terms version
  const getCurrentTermsVersion = async () => {
    try {
      const firestore = getFirestore();
      const termsRef = collection(firestore, 'legalDocuments');
      const termsQuery = query(termsRef, orderBy('version', 'desc'), limit(1));
      const snapshot = await getDocs(termsQuery);

      if (!snapshot.empty) {
        const latestTerms = snapshot.docs[0].data();
        return latestTerms.version || '1.0';
      }
      return '1.0'; // Default version
    } catch (error) {
      console.error('[auth] Error fetching terms version:', error);
      return '1.0'; // Fallback to default
    }
  };

  // CRITICAL FIX: Check if user is already authenticated BEFORE rendering login form
  // This fixes the mobile redirect loop where form renders before getRedirectResult processes
  useEffect(() => {
    if (authCheckedRef.current) return;

    console.log('[auth] Setting up auth state listener to check for existing session...');

    // Track if we've received a user from onAuthStateChanged
    let hasReceivedUser = false;
    let initialCheckComplete = false;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      // If we already processed a redirect, don't do anything
      if (processedRedirectRef.current) {
        console.log('[auth] Redirect already processed, ignoring auth state change');
        return;
      }

      if (user) {
        hasReceivedUser = true;
        console.log('[auth] User already authenticated:', user.uid, user.email);

        // User is already logged in - proceed with redirect
        if (!processedRedirectRef.current) {
          authCheckedRef.current = true;
          processedRedirectRef.current = true;
          setIsRedirecting(true);

          // Check if user profile exists to determine new vs returning user
          const firestore = getFirestore();
          const userDocRef = doc(firestore, 'users', user.uid);
          try {
            const userSnap = await getDoc(userDocRef);
            if (!userSnap.exists()) {
              // New user - redirect to welcome
              console.log('[auth] New user detected, redirecting to welcome');
              window.location.replace('/welcome');
            } else {
              // Returning user - redirect to intended destination
              console.log('[auth] Returning user, redirecting to:', getSafeRedirect());
              window.location.replace(getSafeRedirect());
            }
          } catch (err) {
            console.error('[auth] Error checking user profile:', err);
            // Default to safe redirect
            window.location.replace(getSafeRedirect());
          }
        }
      } else if (!initialCheckComplete) {
        // First null callback - wait a moment for getRedirectResult to potentially fire
        console.log('[auth] No user on initial check, waiting for potential redirect result...');
        initialCheckComplete = true;

        // Give getRedirectResult 1.5 seconds to process before showing login form
        setTimeout(() => {
          if (!hasReceivedUser && !processedRedirectRef.current && !authCheckedRef.current) {
            console.log('[auth] No redirect result after wait, showing login form');
            authCheckedRef.current = true;
            setIsCheckingAuth(false);
          }
        }, 1500);
      }
    });

    // Timeout fallback - if auth check takes too long, show the form anyway
    const timeout = setTimeout(() => {
      if (!authCheckedRef.current && !processedRedirectRef.current) {
        console.log('[auth] Auth check timeout, showing login form');
        authCheckedRef.current = true;
        setIsCheckingAuth(false);
      }
    }, 4000);

    return () => {
      unsubscribe();
      clearTimeout(timeout);
    };
  }, [auth]);

  // Check for invite token in URL
  useEffect(() => {
    const token = searchParams.get('invite');
    if (token) {
      setInviteToken(token);
      fetchInviteData(token);
    }
  }, [searchParams]);

  // Detect in-app browsers (Instagram, Facebook, LinkedIn, etc.) 
  // These have broken third-party cookie support and break signInWithRedirect
  const isInAppBrowser = (): { isInApp: boolean; appName: string | null } => {
    if (typeof window === 'undefined') return { isInApp: false, appName: null };
    const ua = navigator.userAgent || navigator.vendor || (window as any).opera || '';

    // Common in-app browser patterns
    const inAppPatterns: { pattern: RegExp; name: string }[] = [
      { pattern: /FBAN|FBAV/i, name: 'Facebook' },
      { pattern: /Instagram/i, name: 'Instagram' },
      { pattern: /LinkedIn/i, name: 'LinkedIn' },
      { pattern: /Twitter|X/i, name: 'Twitter/X' },
      { pattern: /Snapchat/i, name: 'Snapchat' },
      { pattern: /TikTok/i, name: 'TikTok' },
      { pattern: /Pinterest/i, name: 'Pinterest' },
      { pattern: /Line\//i, name: 'Line' },
      { pattern: /KAKAOTALK/i, name: 'KakaoTalk' },
      { pattern: /WeChat|MicroMessenger/i, name: 'WeChat' },
      { pattern: /Telegram/i, name: 'Telegram' },
      { pattern: /WhatsApp/i, name: 'WhatsApp' },
    ];

    for (const { pattern, name } of inAppPatterns) {
      if (pattern.test(ua)) {
        return { isInApp: true, appName: name };
      }
    }

    // Generic WebView detection
    if (/wv/.test(ua) || /WebView/i.test(ua)) {
      return { isInApp: true, appName: 'WebView' };
    }

    return { isInApp: false, appName: null };
  };

  // Check if we're on mobile (for UI adjustments, not auth strategy)
  const isMobileDevice = () => {
    if (typeof window === 'undefined') return false;
    const mobileRegex = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i;
    return mobileRegex.test(navigator.userAgent);
  };

  // State for in-app browser warning
  const [showInAppWarning, setShowInAppWarning] = useState(false);
  const [detectedApp, setDetectedApp] = useState<string | null>(null);

  // Check for in-app browser on mount
  useEffect(() => {
    const { isInApp, appName } = isInAppBrowser();
    if (isInApp) {
      console.log('[auth] In-app browser detected:', appName);
      setDetectedApp(appName);
      setShowInAppWarning(true);
    }
  }, []);

  // Handle redirect result for social logins with new user detection
  useEffect(() => {
    if (typeof window === 'undefined' || processedRedirectRef.current) return;

    console.log('[auth] Checking for redirect result...');
    getRedirectResult(auth)
      .then(async (result) => {
        if (result) {
          processedRedirectRef.current = true;
          console.log('[auth] Redirect result received, processing user...');
          const user = result.user;

          if (!user) {
            console.error('[auth] No user data in redirect result');
            throw new Error("No user data received from redirect result");
          }

          console.log('[auth] User authenticated:', user.uid, user.email);

          // Check if this is a new user
          const additionalUserInfo = getAdditionalUserInfo(result);
          const isNewUser = additionalUserInfo?.isNewUser || false;

          console.log('[auth] New user detected:', isNewUser);

          // Create or update user profile
          const firestore = getFirestore();
          const userDocRef = doc(firestore, 'users', user.uid);

          try {
            const existingSnap = await getDoc(userDocRef);
            const currentTermsVersion = await getCurrentTermsVersion();
            const baseData: Record<string, any> = {
              uid: user.uid,
              email: user.email,
              photoURL: user.photoURL,
              updatedAt: serverTimestamp(),
              lastSeenAt: serverTimestamp(),
            };

            const userProfileData = existingSnap.exists()
              ? baseData
              : {
                ...baseData,
                role: 'member',
                displayName: user.displayName,
                // Add default points and other required fields
                points: 0,
                upvotes: 0,
                downvotes: 0,
                tasksAssignedCount: 0,
                tasksCompletedOnTimeCount: 0,
                createdAt: serverTimestamp(),
                agreedToTermsAt: serverTimestamp(),
                agreedToTermsVersion: currentTermsVersion,
                termsAgreementTimestamp: serverTimestamp(),
              };

            // Handle invite-based role assignment
            if (inviteData) {
              userProfileData.role = inviteData.role;
            }

            await setDoc(userDocRef, userProfileData, { merge: true });

            // Handle invite-based role assignment
            if (inviteData) {
              const roleAssigned = await assignRole(
                firestore,
                user.uid,
                inviteData.role,
                inviteData.createdBy,
                'Assigned via invite (redirect)'
              );

              if (roleAssigned) {
                await logAuditEntry(
                  firestore,
                  'accept_invite',
                  user.uid,
                  inviteToken || '',
                  { role: inviteData.role }
                );

                showToast({
                  title: "Account Created & Invite Accepted!",
                  description: "Your account has been created and the invited role has been assigned.",
                });
              }
            }

            // NEW USER REDIRECT LOGIC
            if (isNewUser) {
              console.log('[auth] New user detected, redirecting to welcome page');
              showToast({
                title: "Welcome to SEDS Pakistan!",
                description: "Let's complete your profile to get started.",
              });
              // Forward the redirect param so welcome page can honor intent after profile completion
              const redirectParam = searchParams.get('callbackUrl');
              const welcomeUrl = redirectParam
                ? `/welcome?callbackUrl=${encodeURIComponent(redirectParam)}`
                : '/welcome';
              window.location.replace(welcomeUrl);
            } else {
              // Returning user - direct redirect
              console.log('[auth] Returning user, redirecting to intended destination');
              showToast({
                title: "Welcome back!",
                description: "You have been successfully signed in.",
              });
              window.location.replace(getSafeRedirect());
            }

          } catch (profileError) {
            console.error("[auth] Error creating user profile from redirect:", profileError);
            // Even if profile creation fails, let user proceed
            const redirectTarget = isNewUser ? '/welcome' : getSafeRedirect();
            console.log('[auth] Profile creation failed, but proceeding to:', redirectTarget);
            window.location.replace(redirectTarget);
          }
        } else {
          console.log('[auth] No redirect result found');
        }
      })
      .catch((error) => {
        console.error("[auth] Redirect result error:", error);
        console.error("[auth] Error code:", error.code);

        let errorMessage = error.message || "An unexpected error occurred during sign-in.";
        if (error.code === 'auth/internal-error') {
          errorMessage = "Google sign-in configuration error. Please contact support. (Error: 500)";
          console.error("[auth] CRITICAL: Check GOOGLE_OAUTH_CONFIGURATION_GUIDE.md for configuration steps");
        }

        showToast({
          title: "Authentication Failed",
          description: errorMessage,
          variant: "destructive",
        });
      });
  }, [auth, router, showToast, inviteData, inviteToken]);

  const fetchInviteData = async (token: string) => {
    try {
      const firestore = getFirestore();
      const invite = await validateInvite(firestore, token);
      if (invite) {
        setInviteData(invite);
      } else {
        showToast({
          title: "Invalid Invite",
          description: "This invite link is invalid or has expired.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error fetching invite:", error);
      showToast({
        title: "Error",
        description: "Failed to validate invite link.",
        variant: "destructive",
      });
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    const auth = getAuth();
    const provider = new GoogleAuthProvider();

    // Add scopes for better user experience
    provider.addScope('profile');
    provider.addScope('email');

    const isMobile = isMobileDevice();
    const { isInApp, appName } = isInAppBrowser();

    console.log('[auth] Starting Google sign-in, mobile:', isMobile, 'inApp:', isInApp, 'app:', appName);

    // Helper function to handle successful auth
    const handleSuccessfulAuth = async (userCredential: any, method: 'popup' | 'redirect') => {
      const user = userCredential.user;
      if (!user) throw new Error("No user object after sign-in");

      console.log(`[auth] ${method} sign-in successful:`, user.uid, user.email);

      const additionalUserInfo = getAdditionalUserInfo(userCredential);
      const isNewUser = additionalUserInfo?.isNewUser || false;

      // Create or update user profile
      const firestore = getFirestore();
      const userDocRef = doc(firestore, 'users', user.uid);
      const existingSnap = await getDoc(userDocRef);

      const baseData: Record<string, any> = {
        uid: user.uid,
        email: user.email,
        photoURL: user.photoURL,
        updatedAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      };

      const userProfileData = existingSnap.exists()
        ? baseData
        : {
          ...baseData,
          role: 'member',
          displayName: user.displayName,
          points: 0,
          upvotes: 0,
          downvotes: 0,
          tasksAssignedCount: 0,
          tasksCompletedOnTimeCount: 0,
          createdAt: serverTimestamp(),
          agreedToTermsAt: serverTimestamp(),
          termsAgreementTimestamp: serverTimestamp(),
        };

      if (inviteData) {
        userProfileData.role = inviteData.role;
      }

      try {
        await setDoc(userDocRef, userProfileData, { merge: true });
      } catch (_) { }

      if (inviteData && inviteToken) {
        await logAuditEntry(firestore, 'accept_invite', user.uid, inviteToken, { role: inviteData.role });
      }

      // Redirect based on user type
      if (isNewUser) {
        console.log('[auth] New user, redirecting to welcome');
        showToast({ title: "Welcome to SEDS Pakistan!", description: "Let's complete your profile." });
        // Forward the redirect param so welcome page can honor intent after profile completion
        const redirectParam = searchParams.get('callbackUrl');
        const welcomeUrl = redirectParam
          ? `/welcome?callbackUrl=${encodeURIComponent(redirectParam)}`
          : '/welcome';
        window.location.replace(welcomeUrl);
      } else {
        console.log('[auth] Returning user, redirecting to:', getSafeRedirect());
        showToast({ title: "Welcome back!", description: "Signed in successfully." });
        window.location.replace(getSafeRedirect());
      }
    };

    try {
      // ALWAYS try popup first - it works better in 2024 due to third-party cookie blocking
      console.log('[auth] Attempting popup sign-in (recommended for all devices)...');

      try {
        const userCredential = await signInWithPopup(auth, provider);
        if (userCredential) {
          await handleSuccessfulAuth(userCredential, 'popup');
          return;
        }
      } catch (popupError: any) {
        console.log('[auth] Popup error:', popupError.code, popupError.message);

        // Handle specific popup errors
        if (popupError.code === 'auth/popup-blocked') {
          // Popup was blocked - fall back to redirect for mobile, show message for desktop
          if (isMobile) {
            console.log('[auth] Popup blocked on mobile, falling back to redirect...');
            setIsRedirecting(true);
            try {
              await signInWithRedirect(auth, provider);
            } catch (redirErr) {
              setIsRedirecting(false);
              throw redirErr;
            }
            return;
          } else {
            throw popupError; // Let the outer catch handle it
          }
        }

        if (popupError.code === 'auth/popup-closed-by-user') {
          // User closed popup - don't fall back, they cancelled intentionally
          throw popupError;
        }

        if (popupError.code === 'auth/cancelled-popup-request') {
          // Another popup was opened - ignore
          return;
        }

        // For in-app browsers or other popup failures on mobile, try redirect
        if (isMobile || isInApp) {
          console.log('[auth] Popup failed on mobile/in-app, trying redirect as fallback...');
          setIsRedirecting(true);
          try {
            await signInWithRedirect(auth, provider);
          } catch (redirErr) {
            setIsRedirecting(false);
            throw redirErr;
          }
          return;
        }

        // For desktop, just throw the error
        throw popupError;
      }
    } catch (error: any) {
      console.error("[auth] Google Sign-In error:", error);
      setIsRedirecting(false);

      let errorTitle = "Google Sign-In Failed";
      let errorDescription = error.message || "An unexpected error occurred.";

      if (error.code === 'auth/popup-blocked') {
        errorTitle = "Popup Blocked";
        errorDescription = "Please allow popups for this site and try again. On mobile, try opening this page directly in Chrome or Safari.";
      } else if (error.code === 'auth/popup-closed-by-user') {
        errorTitle = "Sign-In Cancelled";
        errorDescription = "You closed the sign-in window.";
      } else if (error.code === 'auth/network-request-failed') {
        errorTitle = "Network Error";
        errorDescription = "Check your internet connection and try again.";
      } else if (error.code === 'auth/internal-error' || error.code === 'auth/unauthorized-domain') {
        errorTitle = "Configuration Error";
        errorDescription = "This domain is not authorized in Firebase. Please add this URL to Authorized Domains in Firebase Console.";
      }

      showToast({ title: errorTitle, description: errorDescription, variant: "destructive" });
    } finally {
      setIsGoogleLoading(false);
    }
  };

  return (
    <>
      {/* Full-screen loading overlay during mobile redirect */}
      {isRedirecting && (
        <div className="fixed inset-0 z-50 bg-gradient-to-br from-gray-900 to-black flex flex-col items-center justify-center">
          <Image src="/assets/logo.png" alt="SEDS" width={80} height={80} className="animate-pulse" priority />
          <p className="text-white mt-4 text-lg font-medium">Signing you in...</p>
          <Loader2 className="mt-4 h-8 w-8 text-primary animate-spin" />
        </div>
      )}
      {/* Loading screen while checking if user is already authenticated */}
      {isCheckingAuth && !isRedirecting && (
        <div className="fixed inset-0 z-50 bg-gradient-to-br from-gray-900 to-black flex flex-col items-center justify-center">
          <Image src="/assets/logo.png" alt="SEDS" width={80} height={80} className="animate-pulse" priority />
          <p className="text-white mt-4 text-lg font-medium">Loading...</p>
          <Loader2 className="mt-4 h-8 w-8 text-primary animate-spin" />
        </div>
      )}
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-900 to-black p-4">
        <Card className="w-full max-w-md mx-auto">
          <div className="flex justify-center mb-4">
            <Image
              src="/assets/logo.png"
              alt="SEDS Pakistan Logo"
              width={64}
              height={64}
              className="h-16 w-16"
            />
          </div>
          <CardHeader className="text-center">
            <CardTitle className="text-3xl font-bold">
              Join the Mission
            </CardTitle>
            <CardDescription className="text-md text-muted-foreground mt-2">
              Students for the Exploration and Development of Space
            </CardDescription>
          </CardHeader>

          <CardContent>
            <div className="space-y-6">
              {/* In-app browser warning */}
              {showInAppWarning && (
                <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-amber-800">
                      <p className="font-semibold mb-1">Open in Browser for Best Experience</p>
                      <p className="text-xs">
                        You&apos;re using {detectedApp || 'an in-app browser'}. For reliable sign-in:
                      </p>
                      <ul className="text-xs mt-1 list-disc list-inside space-y-0.5">
                        <li>Tap the <strong>⋯</strong> menu (top right)</li>
                        <li>Select &quot;<strong>Open in Chrome</strong>&quot; or &quot;<strong>Open in Safari</strong>&quot;</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}
              <Button
                type="button"
                className="w-full h-12 text-lg font-semibold"
                onClick={handleGoogleSignIn}
                disabled={isGoogleLoading}
              >
                {isGoogleLoading ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <Image src="/assets/google-icon.svg" alt="Google Icon" width={20} height={20} className="mr-3" />
                )}
                Continue with Google
              </Button>

              <div className="text-center">
                <p className="text-sm text-muted-foreground">
                  Quick, secure, and hassle-free authentication
                </p>
              </div>

              {/* Security Notice */}
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-blue-800">
                    <p className="font-medium mb-1">Simplified Authentication</p>
                    <p>We use Google Sign-In exclusively for the best security and user experience.</p>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

import { Suspense } from 'react';
import { setDoc } from '@/lib/client/firestore-wrapper';


export default function GoogleOnlyAuthForm() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-900 to-black p-4">
      <div className="w-full max-w-md mx-auto text-center text-white">Loading...</div>
    </div>}>
      <GoogleOnlyAuthFormContent />
    </Suspense>
  );
}
