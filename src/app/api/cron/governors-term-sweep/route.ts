import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { runGovernorTermSweep } from '@/lib/server/governors/term-sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Governor term sweep - MANUAL trigger endpoint (Phase 2, spec C.6).
 * Spec C.6 adds NO new scheduled cron and NO vercel.json entry: the sweep's
 * scheduled interim host is a named step at the end of
 * /api/cron/check-deadlines (daily, behind the same CRON_SECRET), and
 * register reads also run the sweep inline. This endpoint exists only so
 * the sweep can be triggered on demand; it follows the repo cron auth
 * convention (Bearer CRON_SECRET, or an authenticated caller).
 */
async function run(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const auth = await verifyAuthentication(req);
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  }
  const summary = await runGovernorTermSweep(db as never, new Date());
  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
