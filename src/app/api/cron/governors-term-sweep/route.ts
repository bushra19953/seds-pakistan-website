import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { runGovernorTermSweep } from '@/lib/server/governors/term-sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Governor term sweep cron (Phase 2, spec C.2.3): materialises lapsed terms
 * and sends the T-90/T-30 reminders. Follows the repo cron convention:
 * Bearer CRON_SECRET, or an authenticated caller. Register reads also run
 * the sweep inline, so this endpoint is the belt-and-braces schedule.
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
