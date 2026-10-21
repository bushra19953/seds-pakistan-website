import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { runGovernanceCron } from '@/lib/server/lifecycle-cron';

export const dynamic = 'force-dynamic';

/**
 * GET/POST /api/cron/governance
 *
 * The daily governance cron (Phase 2 Section D.6; vercel.json schedule
 * "0 4 * * *" = 09:00 PKT). A dispatcher over named, independently
 * guarded actions: stampDeemedRatifications (D.4/D.6), scanVacancies
 * (D.8), retryProbationRestores (D.10), plus disabled stub stanzas owned
 * by Workstreams E and C. One action throwing never stops the others;
 * the response carries each action's counts separately.
 *
 * Shadow/dry-run default: the engine ships with lifecycleEnforce = false
 * (governance_settings) and this route honours ?dryRun=1 (or a POST body
 * { "dryRun": true }) to report the registry and settings posture while
 * executing nothing and writing nothing. The actions themselves are
 * clerical (deeming, derivation, restore retries change no one's powers,
 * D.11) and are idempotent within a day.
 *
 * Authorization follows the /api/cron/clear-probation convention: Vercel
 * Cron supplies Authorization: Bearer <CRON_SECRET>; an authenticated
 * admin session may also trigger it manually.
 */
async function runGovernance(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const cronSecret = process.env.CRON_SECRET;
    const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
    if (!isCron) {
      const auth = await verifyAuthentication(req);
      if (!auth.authenticated || !auth.user?.role) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    if (!ensureAdminInitialized()) {
      return NextResponse.json({ error: 'Firebase Admin not initialized' }, { status: 500 });
    }
    const adminDb = getDb();
    if (!adminDb) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    let dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
    if (!dryRun && req.method === 'POST') {
      try {
        const body = await req.clone().json();
        if (body && body.dryRun === true) dryRun = true;
      } catch {
        // No/invalid JSON body: a plain cron POST, not a dry run.
      }
    }

    const summary = await runGovernanceCron(adminDb, new Date(), { dryRun });
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[cron/governance] run failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Governance cron failed' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return runGovernance(req);
}

export async function POST(req: NextRequest) {
  return runGovernance(req);
}
