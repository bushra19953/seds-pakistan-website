import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
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
 * Authorization follows the check-deadlines convention: Vercel Cron
 * supplies Authorization: Bearer <CRON_SECRET>; an authenticated admin
 * session may also trigger it manually.
 */
async function handle(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  ensureAdminInitialized();
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  const mode = body.mode === 'repair' ? 'repair' : 'report';

  const report = await reconcileRoles(db, { mode });
  const dateKey = report.generatedAt.slice(0, 10);
  await db
    .collection('reconciliation_reports')
    .doc(dateKey)
    .set({ ...report, storedAt: new Date() }, { merge: true });

  return NextResponse.json({ ok: true, report });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
