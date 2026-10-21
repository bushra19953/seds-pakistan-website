// ADAPTER(W0): Local implementation of the Section 0.3 founder gate until the
// Phase 2 substrate (feat/bylaws-p2-consent) lands. Signature and semantics are
// fixed by spec Section 0.3: Founder identity is a UID equality check against
// FOUNDER_UID, never a role check. A superadmin, president_national, or
// chief_technology_officer holder who is not the Founder UID fails every
// Founder gate in Phase 2.

import type { NextRequest } from 'next/server';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { FOUNDER_UID } from '@/lib/roles';
import { verifySession } from '@/lib/auth/verifySession';

export function isFounderUid(uid: string | null | undefined): boolean {
  return typeof uid === 'string' && uid.length > 0 && uid === FOUNDER_UID;
}

export class FounderGateError extends Error {
  httpStatus = 403;
  constructor(message = 'Founder-only action') {
    super(message);
    this.name = 'FounderGateError';
  }
}

/**
 * Verifies the session, then the Founder UID equality check. Throws
 * SessionError (from verifySession) for unauthenticated requests and
 * FounderGateError for authenticated non-Founders.
 */
export async function assertFounder(request: NextRequest): Promise<DecodedIdToken> {
  const decoded = await verifySession(request);
  if (!isFounderUid(decoded.uid)) {
    throw new FounderGateError();
  }
  return decoded;
}
