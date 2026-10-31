import { NextRequest, NextResponse } from 'next/server';
import { isCronRequest } from '@/lib/server/cron-auth';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { runTimelineResync } from '@/lib/supa-timeline/resync-timeline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/resync-timeline — fs_timeline resync for the
 * timeline surface (2026-11-01; pattern: /api/cron/resync-events).
 *
 * DEFAULT IS DRY-RUN: the response is the drift report (missing
 * rows, drifted fields, orphan rows) and ZERO writes happen.
 * Repair mode requires the explicit body field `mode: 'repair'`
 * (POST) and rewrites every drifted/missing fs_timeline row from
 * its Firestore source doc and deletes orphan mirror rows, through
 * the timeline seam adapter (src/lib/supa-timeline/resync-timeline.ts).
 *
 * Authorization (same shape as /api/cron/resync-events): a cron
 * call with the CRON_SECRET bearer, or a signed-in caller holding
 * canManageTimeline (the timeline write gate). Unauthenticated ->
 * 401, authenticated without the permission -> 403, and the resync
 * never runs in either case.
 *
 * When the timeline surface is off or Supabase is unconfigured the
 * adapter is unavailable and the route answers 503 (the
 * /api/timeline/public convention): there is no mirror to resync.
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
        'canManageTimeline',
      );
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  let mode: 'dry-run' | 'repair' = 'dry-run';
  if (req.method === 'POST') {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (body && body.mode === 'repair') mode = 'repair';
    } catch {
      /* no body -> dry-run */
    }
  }

  const report = await runTimelineResync(db as never, { mode });
  if (report.unavailable) {
    return NextResponse.json({ error: 'supa_unavailable' }, { status: 503 });
  }
  return NextResponse.json(report);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
