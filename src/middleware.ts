/**
 * Edge middleware: server-side guard for admin pages and admin APIs.
 *
 * - Browser visits to /admin/* without a session are redirected to
 *   /auth/login?redirect=<path> before any private dashboard UI can render
 *   (prevents authenticated-only content from flashing).
 * - Calls to /api/admin/* without a session are rejected with 401 JSON
 *   (API clients do not follow login redirects).
 *
 * Session detection is intentionally lightweight: the client sets an
 * `__session` cookie holding the Firebase ID token on sign-in
 * (see src/firebase/user-provider.tsx). Full token verification happens
 * inside API routes and server components via the Admin SDK, which is not
 * available in the Edge runtime.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SIGNIN_PATH = '/auth/login';

function hasSessionCookie(request: NextRequest): boolean {
  return Boolean(request.cookies.get('__session')?.value);
}

function hasBearerHeader(request: NextRequest): boolean {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  return !!header && header.startsWith('Bearer ');
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Guard admin JSON APIs: reject unauthenticated callers with 401.
  if (pathname.startsWith('/api/admin/')) {
    if (!hasSessionCookie(request) && !hasBearerHeader(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Guard admin pages: redirect unauthenticated browser visits to sign-in.
  if (pathname.startsWith('/admin')) {
    // Defensive: never redirect the sign-in page itself (avoids loops).
    if (pathname.startsWith(SIGNIN_PATH)) {
      return NextResponse.next();
    }
    // Local development serves over HTTP, where browsers do not send
    // Secure cookies. Skip the gate there so dev admin testing keeps working.
    if (process.env.NODE_ENV === 'development') {
      return NextResponse.next();
    }
    if (!hasSessionCookie(request)) {
      const url = request.nextUrl.clone();
      url.pathname = SIGNIN_PATH;
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
