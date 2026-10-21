/**
 * Founder gate for governance (Phase 2) server operations.
 *
 * The Founder test is UID equality against FOUNDER_UID (src/lib/roles.ts),
 * never a role check. A holder of superadmin, president_national, or
 * chief_technology_officer who is not the Founder UID fails this gate.
 */

import type { NextRequest } from 'next/server';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { FOUNDER_UID } from '@/lib/roles';
import { verifySession } from '@/lib/auth/verifySession';

/** Thrown when an authenticated caller is not the Founder. */
export class FounderGateError extends Error {
  readonly statusCode = 403;
  constructor(message = 'Forbidden: Founder only') {
    super(message);
    this.name = 'FounderGateError';
  }
}

/**
 * Pure UID-equality check. Returns false for null/undefined/empty uids.
 */
export function isFounderUid(uid: string | null | undefined): boolean {
  return uid === FOUNDER_UID;
}

/**
 * Verify the request session and require the Founder UID.
 *
 * Rethrows the SessionError from verifySession when the request is
 * unauthenticated. Throws FounderGateError when the caller is
 * authenticated but their uid is not FOUNDER_UID. Returns the decoded
 * token on success.
 */
export async function assertFounder(req: NextRequest): Promise<DecodedIdToken> {
  const decoded = await verifySession(req);
  if (!isFounderUid(decoded.uid)) {
    throw new FounderGateError();
  }
  return decoded;
}
