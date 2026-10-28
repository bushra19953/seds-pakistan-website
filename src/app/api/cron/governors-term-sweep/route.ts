import { isCronRequest } from '@/lib/server/cron-auth';
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { runGovernorTermSweep } from '@/lib/server/governors/term-sweep';
import { getCronG1Db } from '@/lib/server/cron/g1-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Governor term sweep - MANUAL trigger endpoint (Phase 2, spec C.6).
 * Spec C.6 adds NO new scheduled cron and NO vercel.json entry: the sweep's
 * scheduled interim host is a named step at the end of
 * /api/cron/check-deadlines (daily, behind the same CRON_SECRET), and
 * register reads also run the sweep inline. This endpoint exists only so
 * the sweep can be triggered on demand.
 *
 * Auth (RP-02, mirroring the custom-role expiry sweep): a CRON_SECRET
 * bearer, OR an authenticated caller holding canManageRoles (the founder
 * passes via the founder_patron shortcut inside hasServerPermission).
 * The sweep materialises vacancies and writes history/audit, so "any
 * authenticated caller" is NOT acceptable: unauthenticated -> 401,
 * authenticated without canManageRoles -> 403, and the sweep never runs
 * in either case. A manual run stamps the caller's uid as the actor on
 * the records it writes; a cron run keeps the sweep's 'system' actor.
 */
async function run(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  const isCron = isCronRequest(authHeader);
  let actorUid: string | undefined;
  if (!isCron) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const canManage = await hasServerPermission(auth.user.role, 'canManageRoles');
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    actorUid = auth.user.userId;
  }
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getCronG1Db();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  }
  const summary = await runGovernorTermSweep(
    db as never,
    new Date(),
    actorUid ? { actorUid } : undefined,
  );
  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
