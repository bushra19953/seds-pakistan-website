import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { getG2Db } from '@/lib/server/cron/g2-data';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { runCustomRoleExpirySweep } from '@/lib/server/custom-role-expiry-sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Custom role expiry sweep - MANUAL trigger endpoint (Custom Roles
 * Fix Program, contracts 5.1 + ADDENDUM R2/R3).
 *
 * NO new scheduled cron and NO vercel.json entry: the sweep's
 * scheduled host is a named step of /api/cron/check-deadlines (daily,
 * behind the same CRON_SECRET). This endpoint exists only so the
 * sweep can be triggered on demand.
 *
 * Auth (R2, SEC-08 over contracts 5.1's governors parity): a
 * CRON_SECRET bearer, OR an authenticated caller holding
 * canManageRoles. The sweep strips roles, so "any authenticated
 * caller" is NOT acceptable: unauthenticated -> 401, authenticated
 * without canManageRoles -> 403, and the sweep never runs in either
 * case.
 */
async function run(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const canManage = await hasServerPermission(auth.user.role, 'canManageRoles');
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getG2Db();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  }
  const summary = await runCustomRoleExpirySweep(db as never, new Date());
  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
