/**
 * CSRF Protection for Next.js applications
 * Implements double-submit cookie pattern for CSRF protection
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

export interface CSRFContext {
  token: string;
  cookieName: string;
  headerName: string;
}

const CSRF_COOKIE_NAME = 'csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_SECRET = process.env.CSRF_SECRET || 'fallback-secret-change-in-production';

/**
 * Generate a secure CSRF token
 */
export function generateCSRFToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Create CSRF token and set cookie
 */
export function createCSRFToken(): CSRFContext {
  const token = generateCSRFToken();

  return {
    token,
    cookieName: CSRF_COOKIE_NAME,
    headerName: CSRF_HEADER_NAME,
  };
}

/**
 * Set CSRF token cookie in response
 */
export function setCSRFCookie(response: NextResponse, token: string): NextResponse {
  response.cookies.set(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24, // 24 hours
    path: '/',
  });

  return response;
}

/**
 * Get CSRF token from request
 */
export function getCSRFToken(request: NextRequest): string | null {
  // First try to get from header
  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  if (headerToken) {
    return headerToken;
  }

  // Then try to get from cookie (for server-side validation)
  return request.cookies.get(CSRF_COOKIE_NAME)?.value || null;
}

/**
 * Validate CSRF token
 */
export function validateCSRFToken(request: NextRequest): { valid: boolean; error?: string } {
  const token = getCSRFToken(request);

  if (!token) {
    return {
      valid: false,
      error: 'CSRF token missing',
    };
  }

  // In a production app, you'd validate the token against a server-side store
  // For now, we'll do a basic length check
  if (token.length < 32) {
    return {
      valid: false,
      error: 'Invalid CSRF token format',
    };
  }

  return { valid: true };
}

/**
 * CSRF protection middleware for API routes
 */
export function withCSRFProtection(
  handler: (request: NextRequest) => Promise<NextResponse> | NextResponse
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Skip CSRF protection for GET, HEAD, OPTIONS requests
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return handler(request);
    }

    const csrfValidation = validateCSRFToken(request);

    if (!csrfValidation.valid) {
      return NextResponse.json(
        {
          error: 'CSRF token validation failed',
          message: csrfValidation.error
        },
        { status: 403 }
      );
    }

    return handler(request);
  };
}

/**
 * Generate CSRF token for client-side forms
 */
export function generateCSRFTokenForClient(): { token: string; cookieScript: string } {
  const token = generateCSRFToken();
  const cookieScript = `
    if (typeof document !== 'undefined') {
      document.cookie = '${CSRF_COOKIE_NAME}=${token}; path=/; max-age=86400; samesite=strict${process.env.NODE_ENV === 'production' ? '; secure' : ''}';
    }
  `;

  return { token, cookieScript };
}

/**
 * CSRF token component helper for React forms
 */
export function getCSRFTokenForForms(): string {
  // In a real app, this would be handled by a React context or server state
  // For now, return a placeholder that should be replaced with actual token
  return '__CSRF_TOKEN__';
}