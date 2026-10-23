// Shared auth gate for governance record routes (Workstream D, spec 3.5).
// Bearer ID token via verifyAuthentication; role resolved through the
// server permission layer (resolveUserRole reads the Phase 1 role store
// first); gate via hasServerPermission against the live grants.

import { NextRequest, NextResponse } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import { verifyAuthentication } from '@/lib/auth-middleware';
import {
  hasServerPermissionForUser,
  resolveUserRole,
} from '@/lib/server/permissions';
import type { PermissionKey } from '@/config/permission-registry';

export interface GovernanceAuth {
  uid: string;
  role: string;
}

export type GovernanceAuthResult =
  | { ok: true; auth: GovernanceAuth }
  | { ok: false; response: NextResponse };

export async function requireGovernancePermission(
  request: NextRequest,
  db: Firestore,
  keys: PermissionKey[],
): Promise<GovernanceAuthResult> {
  const auth = await verifyAuthentication(request);
  if (!auth.authenticated || !auth.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: auth.error || 'Unauthorized' },
        { status: 401 },
      ),
    };
  }
  const uid = auth.user.userId;
  const role =
    (await resolveUserRole(db as never, uid)) || auth.user.role || 'member';
  for (const key of keys) {
    if (await hasServerPermissionForUser(db, uid, key)) {
      return { ok: true, auth: { uid, role } };
    }
  }
  return {
    ok: false,
    response: NextResponse.json(
      { error: 'Forbidden: insufficient permissions' },
      { status: 403 },
    ),
  };
}

export function dbUnavailable(): NextResponse {
  return NextResponse.json(
    { error: 'Database not initialized' },
    { status: 500 },
  );
}
