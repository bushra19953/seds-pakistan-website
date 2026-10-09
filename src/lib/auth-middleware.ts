/**
 * Authentication middleware for Next.js routes
 * Provides authentication checks and user session management
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuth } from 'firebase/auth';
import { getFirebaseApp } from '@/firebase';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { resolveCanonicalRole } from '@/lib/server/permissions';
import { hasSufficientRole, UserRole } from '@/lib/roles';

// Firebase Admin initialization is handled lazily - no module-level initialization needed

export interface AuthContext {
  user: any; // Firebase User object
  userId: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  role: UserRole; // Add role to AuthContext
}

export interface AuthMiddlewareResult {
  authenticated: boolean;
  user?: AuthContext;
  error?: string;
  redirectTo?: string;
}

/**
 * Extract authentication token from request
 */
function extractAuthToken(request: NextRequest): string | null {
  // Check Authorization header
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check cookies for session token
  const sessionCookie = request.cookies.get('__session')?.value;
  if (sessionCookie) {
    return sessionCookie;
  }

  return null;
}

/**
 * Verify user authentication
 */
export async function verifyAuthentication(request: NextRequest): Promise<AuthMiddlewareResult> {
  try {
    const token = extractAuthToken(request);

    if (!token) {
      return {
        authenticated: false,
        error: 'No authentication token provided',
        redirectTo: '/auth/login',
      };
    }

    if (!ensureAdminInitialized()) {
      return {
        authenticated: false,
        error: 'Server misconfiguration: Firebase Admin not initialized',
        redirectTo: '/auth/login',
      };
    }

    // Handle development token
    if (token === 'dev_token') {
      // Only allow dev_token in development environment
      if (process.env.NODE_ENV !== 'development') {
        return {
          authenticated: false,
          error: 'Invalid authentication token',
          redirectTo: '/auth/login',
        };
      }

      // Create a mock decoded token for development
      const mockUserId = 'dev_user';

      // Fetch user role from Firestore for dev user
      const db = getDb();
      if (!db) {
        return {
          authenticated: false,
          error: 'Server misconfiguration: Firestore not available',
          redirectTo: '/auth/login',
        };
      }

      // Canonical role resolution (spec step 03): check-time normalization only.
      const userRole = await resolveCanonicalRole(db, mockUserId);

      return {
        authenticated: true,
        user: {
          user: {
            uid: mockUserId,
            email: 'dev@example.com',
            email_verified: true,
            name: 'Development User'
          },
          userId: mockUserId,
          email: 'dev@example.com',
          displayName: 'Development User',
          emailVerified: true,
          role: userRole as UserRole,
        },
      };
    }

    // Verify real Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userId = decodedToken.uid;

    // Fetch user role from Firestore
    const db = getDb();
    if (!db) {
      return {
        authenticated: false,
        error: 'Server misconfiguration: Firestore not available',
        redirectTo: '/auth/login',
      };
    }

    // Parallel fetch: canonical role (roles/ first, users/ fallback, normalized
    // at check time by resolveCanonicalRole) and user profile (for ban status)
    const [userRole, userProfileSnap] = await Promise.all([
      resolveCanonicalRole(db, userId),
      db.collection('users').doc(userId).get()
    ]);
    const isBanned = userProfileSnap.exists ? userProfileSnap.data()?.isBanned === true : false;

    if (isBanned) {
      return {
        authenticated: false,
        error: 'Account Banned',
        redirectTo: '/banned',
      };
    }

    return {
      authenticated: true,
      user: {
        user: decodedToken, // Add the user object
        userId: decodedToken.uid,
        email: decodedToken.email || '',
        displayName: decodedToken.name || null,
        emailVerified: decodedToken.email_verified || false,
        role: userRole as UserRole,
      },
    };
  } catch (error) {
    console.error('Authentication verification failed:', error);
    const permissionError = new FirestorePermissionError({
      path: request.nextUrl.pathname,
      operation: 'get',
      requestResourceData: { error: error instanceof Error ? error.message : 'Unknown auth error' },
    });
    errorEmitter.emit('permission-error', permissionError);

    return {
      authenticated: false,
      error: 'Authentication verification failed',
      redirectTo: '/auth/login',
    };
  }
}

/**
 * Middleware function for protected routes
 */
export async function withAuth(
  request: NextRequest,
  handler: (context: AuthContext) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  const authResult = await verifyAuthentication(request);
  const isApiRequest = request.nextUrl.pathname.startsWith('/api/');

  if (!authResult.authenticated) {
    if (isApiRequest) {
      return NextResponse.json(
        { error: 'Unauthorized', message: authResult.error || 'Authentication required' },
        { status: 401 }
      );
    }

    // If specifically banned, respect the redirect to /banned
    if (authResult.redirectTo === '/banned') {
      return NextResponse.redirect(new URL('/banned', request.url));
    }

    // Redirect to login page with return URL
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('callbackUrl', request.nextUrl.pathname + request.nextUrl.search);

    return NextResponse.redirect(loginUrl);
  }

  if (!authResult.user) {
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('callbackUrl', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  try {
    return await handler(authResult.user);
  } catch (error) {
    console.error('Authenticated handler error:', error);
    const permissionError = new FirestorePermissionError({
      path: request.nextUrl.pathname,
      operation: 'get',
      requestResourceData: {
        error: error instanceof Error ? error.message : 'Unknown handler error',
        userId: authResult.user.userId
      },
    });
    errorEmitter.emit('permission-error', permissionError);

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * Higher-order function for API routes that require authentication
 */
export function requireAuth(handler: (context: AuthContext, request: NextRequest) => Promise<NextResponse>) {
  return async (request: NextRequest): Promise<NextResponse> => {
    return withAuth(request, (context) => handler(context, request));
  };
}

/**
 * Check if user has required role/permission
 */
export async function requireRole(
  request: NextRequest,
  requiredRole: UserRole,
  handler: (context: AuthContext) => Promise<NextResponse>
): Promise<NextResponse> {
  return withAuth(request, async (context) => {
    if (!context.role || !hasSufficientRole(context.role, requiredRole)) {
      return NextResponse.json(
        { error: 'Insufficient permissions' },
        { status: 403 }
      );
    }

    return handler(context);
  });
}

/**
 * Optional authentication - provides user context if available
 */
export async function withOptionalAuth(
  request: NextRequest,
  handler: (context: AuthContext | null) => Promise<NextResponse>
): Promise<NextResponse> {
  const authResult = await verifyAuthentication(request);

  if (authResult.authenticated && authResult.user) {
    return handler(authResult.user);
  }

  return handler(null);
}
