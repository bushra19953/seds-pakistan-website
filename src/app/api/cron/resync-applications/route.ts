import { NextRequest, NextResponse } from 'next/server';
import { isCronRequest } from '@/lib/server/cron-auth';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { runApplicationsResync } from '@/lib/applications-resync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/resync-applications — the fs_applications mirror
 * guard (P1 mirror-loudness fix, 2026-10-29).
 *
 * DEFAULT IS DRY-RUN: the response is the drift report (missing
 * rows, orphan rows) and ZERO writes happen — neither to
 * fs_applications nor anywhere else. Repair mode requires the
 * explicit body field `mode: 'repair'` (POST) and re-mirrors every
 * missing fs_applications row from its Firestore source doc through
 * the applications seam's own mirror helper (see
 * src/lib/applications-resync.ts). Orphan mirror rows are reported
 * only, never deleted. The Firestore scan is budget-capped: an
 * over-budget report makes no writes at all.
 *
 * Authorization (same shape as /api/cron/resync-events): a cron
 * call with the CRON_SECRET bearer, or a signed-in caller holding
 * canManageApplications (the applications write routes' gate).
 * Unauthenticated -> 401, authenticated without the permission ->
 * 403, and the resync never runs in either case.
 *
 * When the applications surface is off or Supabase is unconfigured
 * the adapter is unavailable and the route answers 503: there is no
 * mirror to resync.
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
  const mode = body.mode === 'repair' ? 'repair' : 'dry-run';

  const report = await runApplicationsResync(db as never, mode);
  if (!report) {
    return NextResponse.json(
      { error: 'supa_unavailable', detail: 'applications surface is off or Supabase is unconfigured' },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, report });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
