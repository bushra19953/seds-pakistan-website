// ADAPTER: thin local stand-in for the Phase 2 W0 substrate founder gate
// (phase2_spec.md Section 0.3). Replace with the canonical W0 module at merge
// time; the exported signatures are the contract and must not change.
//
// Founder identity is a UID equality check against FOUNDER_UID
// (src/lib/roles.ts). It is NEVER a role check: a superadmin,
// president_national, or chief_technology_officer holder who is not the
// Founder UID fails every Founder gate in Phase 2.

import type { NextRequest } from 'next/server';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { FOUNDER_UID } from '@/lib/roles';
import { verifySession, SessionError } from '@/lib/auth/verifySession';

export function isFounderUid(uid: string | null | undefined): boolean {
  return typeof uid === 'string' && uid.length > 0 && uid === FOUNDER_UID;
}

/**
 * Verify the request session and require the caller to be the Founder.
 * Returns the decoded token on success; throws SessionError (401 when the
 * session itself fails, 403 when the caller is not the Founder).
 */
export async function assertFounder(req: NextRequest): Promise<DecodedIdToken> {
  const decoded = await verifySession(req);
  if (!isFounderUid(decoded.uid)) {
    throw new SessionError('Forbidden: Founder only', 403);
  }
  return decoded;
}
