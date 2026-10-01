/**
 * Hook for managing contextual redirects with user feedback
 * Provides intelligent redirect logic based on user intent and authentication state
 */

'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@/firebase';
import { useErrorToast } from '@/hooks/use-error-toast';
import { UserRole, hasSufficientRole } from '@/lib/roles';

export interface RedirectContext {
  from: string;
  intended?: string;
  reason?: string;
  requiresAuth?: boolean;
  requiredRole?: UserRole;
}

export interface ContextualRedirectOptions {
  showToast?: boolean;
  preserveIntent?: boolean;
  fallbackUrl?: string;
  delay?: number;
}

export function useContextualRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, role, isLoading } = useUser();
  const { showErrorToast, showSuccessToast, showInfoToast } = useErrorToast();
  const redirectContextRef = useRef<RedirectContext | null>(null);

  // Parse redirect context from URL parameters
  const getRedirectContext = useCallback((): RedirectContext | null => {
    const from = searchParams.get('redirect_from');
    const intended = searchParams.get('intended');
    const reason = searchParams.get('reason');
    const requiresAuth = searchParams.get('requires_auth') === 'true';
    const requiredRole = searchParams.get('required_role') as UserRole;

    if (!from && !intended) return null;

    return {
      from: from || window.location.pathname,
      intended: intended || undefined,
      reason: reason || undefined,
      requiresAuth,
      requiredRole,
    };
  }, [searchParams]);

  // Store redirect context for later use
  const storeRedirectContext = useCallback((context: RedirectContext) => {
    redirectContextRef.current = context;
    
    // Store in sessionStorage for persistence across page reloads
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('redirect_context', JSON.stringify(context));
    }
  }, []);

  // Retrieve stored redirect context
  const getStoredContext = useCallback((): RedirectContext | null => {
    if (redirectContextRef.current) {
      return redirectContextRef.current;
    }

    if (typeof window !== 'undefined') {
      const stored = sessionStorage.getItem('redirect_context');
      if (stored) {
        try {
          const context = JSON.parse(stored);
          redirectContextRef.current = context;
          return context;
        } catch (error) {
          console.error('Failed to parse stored redirect context:', error);
          sessionStorage.removeItem('redirect_context');
        }
      }
    }

    return null;
  }, []);

  // Clear stored redirect context
  const clearStoredContext = useCallback(() => {
    redirectContextRef.current = null;
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('redirect_context');
    }
  }, []);

  // Perform contextual redirect with user feedback
  const performContextualRedirect = useCallback(async (
    to: string, 
    context?: RedirectContext,
    options: ContextualRedirectOptions = {}
  ) => {
    const {
      showToast = true,
      preserveIntent = true,
      fallbackUrl = '/',
      delay = 0,
    } = options;

    try {
      // Store context if provided
      if (context && preserveIntent) {
        storeRedirectContext(context);
      }

      // Show appropriate toast message
      if (showToast) {
        if (context?.reason) {
          showInfoToast(context.reason, 'Redirecting...');
        } else if (to.includes('login')) {
          showInfoToast('Please sign in to continue', 'Authentication Required');
        } else if (to.includes('profile')) {
          showSuccessToast('Welcome! Redirecting to your profile...');
        }
      }

      // Perform redirect with delay if specified
      const performRedirect = () => {
        if (to.startsWith('http')) {
          window.location.href = to;
        } else {
          router.push(to);
        }
      };

      if (delay > 0) {
        setTimeout(performRedirect, delay);
      } else {
        performRedirect();
      }

    } catch (error) {
      console.error('Redirect failed:', error);
      if (showToast) {
        showErrorToast(
          error as Error,
          { 
            title: 'Redirect Failed',
            description: 'Unable to redirect. Please try again.' 
          }
        );
      }
      
      // Fallback to safe URL
      router.push(fallbackUrl);
    }
  }, [router, storeRedirectContext, showErrorToast, showSuccessToast, showInfoToast]);

  // Handle authentication-required redirects
  const requireAuth = useCallback((
    intendedUrl?: string,
    requiredRole?: UserRole,
    options: ContextualRedirectOptions = {}
  ) => {
    if (isLoading) return;

    const currentUrl = window.location.pathname + window.location.search;
    const intended = intendedUrl || currentUrl;

    // Check if user is authenticated
    if (!user) {
      const context: RedirectContext = {
        from: currentUrl,
        intended,
        reason: 'Please sign in to access this page',
        requiresAuth: true,
        requiredRole,
      };

      performContextualRedirect('/auth', context, {
        ...options,
        showToast: options.showToast !== false,
      });
      return false;
    }

    // Check if user has required role
    if (requiredRole && role && !hasSufficientRole(role, requiredRole)) {
      const context: RedirectContext = {
        from: currentUrl,
        intended,
        reason: `This page requires ${requiredRole} privileges`,
        requiresAuth: true,
        requiredRole,
      };

      performContextualRedirect('/profile', context, {
        ...options,
        showToast: options.showToast !== false,
      });
      return false;
    }

    return true;
  }, [user, role, isLoading, performContextualRedirect]);

  // Handle successful authentication redirect
  const handleSuccessfulAuth = useCallback((
    userRole?: UserRole,
    options: ContextualRedirectOptions = {}
  ) => {
    const storedContext = getStoredContext();
    
    if (storedContext?.intended && storedContext.intended !== '/auth') {
      // Redirect to intended page
      const intendedUrl = storedContext.intended;
      clearStoredContext();
      
      performContextualRedirect(intendedUrl, undefined, {
        ...options,
        showToast: options.showToast !== false,
      });
    } else {
      // Default redirect based on role
      const defaultRedirect = getDefaultRedirectUrl(userRole);
      performContextualRedirect(defaultRedirect, undefined, {
        ...options,
        showToast: options.showToast !== false,
      });
    }
  }, [getStoredContext, clearStoredContext, performContextualRedirect]);

  // Get default redirect URL based on user role
  const getDefaultRedirectUrl = useCallback((userRole?: UserRole): string => {
    // Default to consolidated profile page
    if (!userRole) return '/profile';
    
    if (userRole === 'superadmin' || userRole === 'president_national') {
      return '/admin';
    }
    
    return '/profile';
  }, []);

  // Handle logout with contextual redirect
  const handleLogout = useCallback(async (
    redirectTo: string = '/',
    options: ContextualRedirectOptions = {}
  ) => {
    try {
      clearStoredContext();
      
      if (options.showToast !== false) {
        showInfoToast('You have been logged out successfully', 'Logged Out');
      }

      performContextualRedirect(redirectTo, undefined, options);
    } catch (error) {
      console.error('Logout redirect failed:', error);
      router.push(redirectTo);
    }
  }, [clearStoredContext, performContextualRedirect, showInfoToast, router]);

  // Auto-cleanup on unmount
  useEffect(() => {
    return () => {
      clearStoredContext();
    };
  }, [clearStoredContext]);

  return {
    getRedirectContext,
    storeRedirectContext,
    getStoredContext,
    clearStoredContext,
    performContextualRedirect,
    requireAuth,
    handleSuccessfulAuth,
    getDefaultRedirectUrl,
    handleLogout,
    hasStoredIntent: !!getStoredContext(),
  };
}

// Use canonical helper from roles lib to avoid divergence and ensure superadmin coverage
