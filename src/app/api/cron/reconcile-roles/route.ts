import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { hasServerPermission } from '@/lib/server/permissions';
import { reconcileRoles } from '@/lib/server/role-reconciliation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET/POST /api/cron/reconcile-roles (Phase 1, spec B.6).
 *
 * Daily reconciliation of roles/{uid} against the users mirror. DEFAULT
 * IS REPORT MODE: the report is returned and stored at
 * reconciliation_reports/{date}; zero role-store writes happen. Repair
 * mode requires the explicit `mode: 'repair'` body field plus cron or
 * admin authorization, and is enabled operationally only after Publish 1
 * (it writes through the same single write path as everything else).
 *
 * Authorization (RP-01): Vercel Cron supplies
 * Authorization: Bearer <CRON_SECRET>. The manual arm is NOT "any
 * authenticated caller": a signed-in caller must hold canManageRoles
 * (the founder passes via the founder_patron shortcut inside
 * hasServerPermission). Unauthenticated -> 401, authenticated without
 * canManageRoles -> 403, and reconciliation never runs in either case.
 * A manual run stamps the caller's uid as actorUid on the audit /
 * history records it writes; a cron run keeps the library default.
 */
async function handle(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
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

  ensureAdminInitialized();
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  const mode = body.mode === 'repair' ? 'repair' : 'report';

  const report = await reconcileRoles(db, {
    mode,
    ...(actorUid ? { actorUid } : {}),
  });
  const dateKey = report.generatedAt.slice(0, 10);
  await db
    .collection('reconciliation_reports')
    .doc(dateKey)
    .set(
      { ...report, storedAt: new Date(), ...(actorUid ? { actorUid } : {}) },
      { merge: true },
    );

  return NextResponse.json({ ok: true, report });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
