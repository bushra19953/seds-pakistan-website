/**
 * verifySession: shared Firebase ID token verification for API routes.
 *
 * Extracts the Bearer <redacted> the Authorization header and verifies it with
 * the Firebase Admin SDK (getAuth().verifyIdToken). Returns the decoded token
 * on success, or throws a SessionError carrying an HTTP status code so route
 * handlers can map failures to 401/500 responses without duplicating logic.
 *
 * Intended for Node.js API routes only. Edge middleware must not import this
 * module because firebase-admin is not Edge compatible.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { ensureAdminInitialized, getLastAdminError } from '@/lib/server/firebase-admin';

/** Error thrown when session verification fails. Carries the HTTP status to return. */
export class SessionError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: 401 | 403 | 500) {
    super(message);
    this.name = 'SessionError';
    this.statusCode = statusCode;
  }
}

/**
 * Extract a Bearer <redacted> the Authorization header.
 * Returns null when the header is missing, malformed, or empty.
 */
export function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

/**
 * Verify a raw Firebase ID token string with the Admin SDK.
 * Throws SessionError(401) for invalid or expired tokens,
 * SessionError(500) when the Admin SDK failed to initialize.
 */
export async function verifyIdTokenString(token: string): Promise<DecodedIdToken> {
  if (!ensureAdminInitialized()) {
    const detail = getLastAdminError();
    throw new SessionError(
      detail
        ? `Server misconfiguration: ${detail}`
        : 'Server misconfiguration: Firebase Admin not initialized',
      500,
    );
  }
  try {
    return await getAuth().verifyIdToken(token);
  } catch {
    throw new SessionError('Unauthorized: invalid or expired token', 401);
  }
}

/**
 * Verify the request's Authorization: Bearer <token> header.
 * Returns the decoded ID token. Throws SessionError(401) when the token is
 * missing or invalid, SessionError(500) on server misconfiguration.
 */
export async function verifySession(request: NextRequest): Promise<DecodedIdToken> {
  const token = extractBearerToken(request);
  if (!token) {
    throw new SessionError('Unauthorized: missing Bearer <redacted>', 401);
  }
  return verifyIdTokenString(token);
}

/**
 * Convert a SessionError into a JSON error response.
 * Returns null when the error is not a SessionError (caller handles it).
 */
export function toSessionErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SessionError) {
    return NextResponse.json({ error: err.message }, { status: err.statusCode });
  }
  return null;
}
