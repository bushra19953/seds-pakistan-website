import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { authRateLimiter, signupIpRateLimiter } from '@/lib/rate-limiter';
import { GENERIC_SIGNUP_ERROR } from '@/lib/signup-errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/signup
 *
 * Server-side account creation for the public homepage join form
 * (audit item 5). The form used to call Firebase's
 * createUserWithEmailAndPassword directly from the browser, so no
 * app-side rate limit could ever apply to it: a script needed only
 * the public web API key. Creation now runs here instead:
 *
 * 1. Per-IP brake: signupIpRateLimiter (5 creations / 15 min / IP).
 * 2. Per-email brake: authRateLimiter (5 attempts / 15 min / email).
 * 3. The account is created with the Admin SDK and the caller gets a
 *    Firebase custom token back; the browser signs in with
 *    signInWithCustomToken and then runs the exact same profile
 *    writes as before. Google sign-in is a separate flow and is not
 *    touched by this route.
 *
 * Honest scope (what this does NOT do): the limiters live in
 * per-process memory, so the ceiling is per server instance, and a
 * script that calls Firebase Auth's own sign-up endpoint directly
 * with the public web API key bypasses this route entirely. Closing
 * that last path is Firebase console work (App Check enforcement
 * for Authentication, Identity Platform abuse/quota settings, API
 * key restrictions) and is tracked as an owner action; this route is
 * the strongest control the app code itself can enforce.
 *
 * Enumeration safety (audit item 20): auth/email-already-exists and
 * every other non-input failure return the SAME generic 400 body.
 * Only codes about the caller's own input (invalid email, weak
 * password) or throttling are distinguishable.
 */

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function tooManyRequests(retryAfterSec: number) {
  return NextResponse.json(
    { error: 'Too many attempts. Please wait a few minutes and try again.', code: 'auth/too-many-requests' },
    { status: 429, headers: { 'Retry-After': String(Math.max(1, retryAfterSec)) } },
  );
}

export async function POST(request: NextRequest) {
  // 1. Per-IP brake, before any other work.
  const ip = clientIp(request);
  const ipCheck = await signupIpRateLimiter.check(ip);
  if (!ipCheck.success) {
    return tooManyRequests(Math.ceil((ipCheck.resetTime - Date.now()) / 1000));
  }

  let body: { name?: unknown; email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: GENERIC_SIGNUP_ERROR, code: 'signup/generic' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // 2. Per-email brake (the previously dead authRateLimiter, now wired).
  if (email) {
    const emailCheck = await authRateLimiter.check(`signup:${email}`);
    if (!emailCheck.success) {
      return tooManyRequests(Math.ceil((emailCheck.resetTime - Date.now()) / 1000));
    }
  }

  // Input validation: messages here describe the caller's own input
  // only, never any account state.
  if (!email || !email.includes('@')) {
    return NextResponse.json(
      { error: 'Please enter a valid email address.', code: 'auth/invalid-email' },
      { status: 400 },
    );
  }
  if (!password || password.length < 6) {
    return NextResponse.json(
      { error: 'Please choose a stronger password (at least 6 characters).', code: 'auth/weak-password' },
      { status: 400 },
    );
  }
  if (name.length < 2) {
    return NextResponse.json({ error: GENERIC_SIGNUP_ERROR, code: 'signup/generic' }, { status: 400 });
  }

  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: GENERIC_SIGNUP_ERROR, code: 'signup/generic' }, { status: 500 });
  }

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name,
    });
    const customToken = await admin.auth().createCustomToken(userRecord.uid);
    return NextResponse.json({ customToken });
  } catch (error: any) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code === 'auth/invalid-email') {
      return NextResponse.json(
        { error: 'Please enter a valid email address.', code: 'auth/invalid-email' },
        { status: 400 },
      );
    }
    if (code === 'auth/weak-password' || code === 'auth/invalid-password') {
      return NextResponse.json(
        { error: 'Please choose a stronger password (at least 6 characters).', code: 'auth/weak-password' },
        { status: 400 },
      );
    }
    // auth/email-already-exists lands here on purpose: it must be
    // indistinguishable from every other failure (audit item 20).
    return NextResponse.json({ error: GENERIC_SIGNUP_ERROR, code: 'signup/generic' }, { status: 400 });
  }
}
