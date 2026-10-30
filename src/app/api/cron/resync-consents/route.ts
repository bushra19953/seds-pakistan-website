import { NextRequest, NextResponse } from 'next/server';
import { isCronRequest } from '@/lib/server/cron-auth';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { FOUNDER_UID } from '@/lib/roles';
import { runConsentsResync } from '@/lib/consents-resync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/resync-consents — the fs_consent_requests mirror
 * guard (consents mirror + seam program, 2026-10-30; modeled on
 * /api/cron/resync-applications).
 *
 * DEFAULT IS DRY-RUN: the response is the drift report (missing
 * rows, orphan rows) and ZERO writes happen — neither to
 * fs_consent_requests nor anywhere else. Repair mode requires the
 * explicit body field `mode: 'repair'` (POST) and re-mirrors every
 * missing fs_consent_requests row from its Firestore source doc
 * through the consents seam's own mirror helper (see
 * src/lib/consents-resync.ts). Orphan mirror rows are reported only,
 * never deleted. The Firestore scan is budget-capped: an
 * over-budget report makes no writes at all.
 *
 * Authorization (timing-safe cron auth like its siblings): a cron
 * call with the CRON_SECRET bearer, or a signed-in caller who IS the
 * Founder — consent records are Founder-decided governance records
 * and no canManageConsents permission key exists, so the manual arm
 * is the consent decider check itself (uid === FOUNDER_UID, the same
 * test isConsentDecider applies). Unauthenticated -> 401,
 * authenticated non-founder -> 403, and the resync never runs in
 * either case.
 *
 * When the consents surface is off or Supabase is unconfigured the
 * adapter is unavailable and the route answers 503: there is no
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
    if (auth.user.userId !== FOUNDER_UID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  const mode = body.mode === 'repair' ? 'repair' : 'dry-run';

  const report = await runConsentsResync(db as never, mode);
  if (!report) {
    return NextResponse.json(
      { error: 'supa_unavailable', detail: 'consents surface is off or Supabase is unconfigured' },
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
