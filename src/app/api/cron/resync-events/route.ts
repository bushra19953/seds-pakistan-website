import { NextRequest, NextResponse } from 'next/server';
import { isCronRequest } from '@/lib/server/cron-auth';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { runEventsResync } from '@/lib/supa-events/resync-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/resync-events — one-time fs_events resync for
 * the events mirror-staleness fix (2026-10-28).
 *
 * DEFAULT IS DRY-RUN: the response is the drift report (per-doc
 * field diffs, missing rows, orphan rows) and ZERO writes happen —
 * neither to fs_events nor anywhere else. Repair mode requires the
 * explicit body field `mode: 'repair'` (POST) and rewrites every
 * drifted/missing fs_events row from its Firestore source doc and
 * deletes orphan mirror rows, through the events seam adapter (see
 * src/lib/supa-events/resync-events.ts).
 *
 * Authorization (same shape as /api/cron/reconcile-roles): a cron
 * call with the CRON_SECRET bearer, or a signed-in caller holding
 * canManageEvents (the events write routes' gate). Unauthenticated
 * -> 401, authenticated without the permission -> 403, and the
 * resync never runs in either case.
 *
 * When the events surface is off or Supabase is unconfigured the
 * adapter is unavailable and the route answers 503 (the
 * /api/events/public convention): there is no mirror to resync.
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
        'canManageEvents',
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

  const report = await runEventsResync(db as never, mode);
  if (!report) {
    return NextResponse.json(
      { error: 'supa_unavailable', detail: 'events surface is off or Supabase is unconfigured' },
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
