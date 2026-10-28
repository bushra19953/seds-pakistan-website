import { NextRequest, NextResponse } from 'next/server';
import { isCronRequest } from '@/lib/server/cron-auth';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { runLeaveLifecycle } from '@/lib/server/leave-lifecycle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/leave-lifecycle — daily leave lifecycle sweep
 * (defect fix, 2026-10-28).
 *
 * Keeps the On Leave flags on users/{uid} in step with approved
 * leave windows (judged in Asia/Karachi, end date inclusive):
 * activates a leave when its start date arrives, completes it
 * (flags cleared, request 'completed', redirected work restored
 * via the shared returnFromLeave helper) once its end date has
 * passed, and clears flags the old approval behaviour stamped
 * early for a leave that has not started yet. See
 * src/lib/server/leave-lifecycle.ts for the engine and its
 * idempotency argument.
 *
 * DEFAULT IS DRY-RUN, like the other cron repair routes
 * (reconcile-roles, resync-events): the response is the lifecycle
 * report and ZERO writes happen. Repair requires the explicit
 * mode: the JSON body field `mode: 'repair'` on POST, or the
 * `?mode=repair` query parameter on GET. The registered daily
 * schedule in vercel.json carries `?mode=repair` in its path, so
 * the scheduled run performs the sweep while any bare manual hit
 * stays a dry-run.
 *
 * Authorization (same shape as /api/cron/resync-events): a cron
 * call with the CRON_SECRET bearer, or a signed-in caller holding
 * canManageApplications (the leave decision gate). Unauthenticated
 * -> 401, authenticated without the permission -> 403, and the
 * sweep never runs in either case.
 *
 * Schedule: daily at 00:00 Asia/Karachi (19:00 UTC), registered in
 * vercel.json ahead of check-deadlines (19:15 UTC) so the flags
 * the deadline exemption reads are already settled for the new
 * Karachi day.
 */
async function handle(req: NextRequest) {
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization') || '';
  const isCron = isCronRequest(authHeader);
  if (!isCron) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    let allowed = false;
    try {
      allowed = await hasServerPermissionForUser(
        db as never,
        auth.user.userId,
        'canManageApplications',
      );
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  const queryMode = req.nextUrl?.searchParams?.get('mode');
  const mode = body.mode === 'repair' || queryMode === 'repair' ? 'repair' : 'dry-run';

  const report = await runLeaveLifecycle(db as never, { mode });
  return NextResponse.json({ ok: true, report });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
